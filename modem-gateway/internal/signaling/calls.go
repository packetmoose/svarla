package signaling

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/packetmoose/svarla/modem-gateway/internal/bridge"
	"github.com/packetmoose/svarla/modem-gateway/internal/modem"
)

// Call state constants reported to Svarla.
const (
	CallStateRinging   = "RINGING"
	CallStateAnswered  = "ANSWERED"
	CallStateCompleted = "COMPLETED"
	CallStateFailed    = "FAILED"
	CallStateBusy      = "BUSY"
)

// Call direction constants.
const (
	CallDirectionOutbound = "outbound"
	CallDirectionInbound  = "inbound"
)

// clipWaitDelay is how long handleRING waits for the +CLIP URC (which carries
// the caller's number) to arrive before reporting the incoming call to Svarla.
// On the SIM7600, RING is emitted before +CLIP, so reporting immediately on
// RING would send an empty caller number ("anonymous"). A short wait lets +CLIP
// populate the number so we report the call exactly once, with caller ID.
const clipWaitDelay = 400 * time.Millisecond

// audioSettleDelay is how long to wait after a call is established before
// enabling PCM streaming (AT+CPCMREG=1). The SIM7600 audio subsystem needs
// a moment to come online; starting too early yields command errors and
// silent (all-zero) PCM frames.
const audioSettleDelay = 1 * time.Second

// BridgeFactory creates an AudioBridge for a given call. This allows
// injection of different bridge implementations for testing.
type BridgeFactory func() *bridge.AudioBridge

// AudioPipeline defines the interface for managing the modem's PCM audio
// capture and playback during calls.
type AudioPipeline interface {
	Start() error
	Stop() error
	CaptureFrames() <-chan []byte
	PlaybackFrames() chan<- []byte
}

// MakeCallPayload is received from Svarla when initiating an outbound call.
type MakeCallPayload struct {
	Type       string `json:"type"`
	RequestID  string `json:"requestId"`
	CallID     string `json:"callId"`
	To         string `json:"to"`
	AudioWsURL string `json:"audioWsUrl"`
}

// AnswerCallPayload is received from Svarla when answering an incoming call.
type AnswerCallPayload struct {
	Type       string `json:"type"`
	RequestID  string `json:"requestId"`
	CallID     string `json:"callId"`
	AudioWsURL string `json:"audioWsUrl"`
}

// EndCallPayload is received from Svarla to hang up a call.
type EndCallPayload struct {
	Type   string `json:"type"`
	CallID string `json:"callId"`
}

// CallStatePayload is sent to Svarla on state transitions.
type CallStatePayload struct {
	Type            string  `json:"type"`
	CallID          string  `json:"callId"`
	State           string  `json:"state"`
	Reason          string  `json:"reason,omitempty"`
	DurationSeconds *int64  `json:"durationSeconds"`
}

// IncomingCallPayload is sent to Svarla when an incoming call is detected.
type IncomingCallPayload struct {
	Type   string `json:"type"`
	CallID string `json:"callId"`
	From   string `json:"from"`
}

// AckPayload is sent to Svarla to acknowledge a make_call or answer_call request.
// The RequestID echoes the requestId from the originating request so the server
// can resolve its pending operation.
type AckPayload struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
}

// activeCall tracks the state of the currently active call.
type activeCall struct {
	callID      string
	direction   string
	from        string // caller number (inbound) or empty (outbound)
	to          string // destination number
	audioWsURL  string
	answered    bool
	answerTime  time.Time
	bridge      *bridge.AudioBridge
}

// CallManager handles voice call lifecycle management including outbound
// call initiation, inbound call detection, audio bridge management, and
// call state reporting to the Svarla server via the signaling WebSocket.
//
// It enforces single concurrent call, tracks duration, and manages the
// audio pipeline and bridge connections during calls.
type CallManager struct {
	mdm           *modem.Modem
	stateMachine  *modem.StateMachine
	sigClient     MessageSender
	bridgeFactory BridgeFactory
	audio         AudioPipeline

	mu         sync.Mutex
	call       *activeCall
	callIDSeq  atomic.Uint64

	// incomingFrom tracks the caller number parsed from the +CLIP URC so the
	// incoming_call report includes caller ID.
	incomingFrom string
	ringing      bool

	// reportTimer defers the incoming_call report briefly after RING so the
	// +CLIP URC (caller number) can arrive first. reportSent guards against
	// emitting the report more than once for the same call.
	reportTimer *time.Timer
	reportSent  bool
}

// MessageSender is the interface for sending signaling messages to Svarla.
// Both Client and ReconnectingClient satisfy this interface.
type MessageSender interface {
	Send(msg Message) error
	IsConnected() bool
}

// CallManagerConfig holds the dependencies for creating a CallManager.
type CallManagerConfig struct {
	Modem         *modem.Modem
	StateMachine  *modem.StateMachine
	SigClient     MessageSender
	BridgeFactory BridgeFactory
	Audio         AudioPipeline
}

// NewCallManager creates a CallManager and registers URC handlers on the modem
// for RING, +CLIP, and NO CARRIER events.
func NewCallManager(cfg CallManagerConfig) *CallManager {
	cm := &CallManager{
		mdm:           cfg.Modem,
		stateMachine:  cfg.StateMachine,
		sigClient:     cfg.SigClient,
		bridgeFactory: cfg.BridgeFactory,
		audio:         cfg.Audio,
	}

	// Register URC handlers for call-related events.
	cfg.Modem.OnURC(cm.handleURC)

	return cm
}

// HandleMessage processes an incoming signaling message related to calls.
// Call this from the signaling client's message dispatch.
func (cm *CallManager) HandleMessage(msg Message) {
	switch msg.Type {
	case TypeMakeCall:
		cm.handleMakeCall(msg)
	case TypeAnswerCall:
		cm.handleAnswerCall(msg)
	case TypeEndCall:
		cm.handleEndCall(msg)
	}
}

// handleMakeCall processes a make_call message from Svarla.
func (cm *CallManager) handleMakeCall(msg Message) {
	var payload MakeCallPayload
	if err := msg.ParsePayload(&payload); err != nil {
		log.Printf("[calls] failed to parse make_call payload: %v", err)
		return
	}

	cm.mu.Lock()

	// Enforce single concurrent call.
	if cm.call != nil {
		cm.mu.Unlock()
		cm.sendCallState("", CallStateFailed, "call_already_active", nil)
		return
	}

	// Use the callId assigned by the server so both sides agree on the call
	// identifier (needed for end_call matching). Fall back to a locally
	// generated id if the server didn't supply one.
	callID := payload.CallID
	if callID == "" {
		callID = cm.generateCallID()
	}
	cm.call = &activeCall{
		callID:     callID,
		direction:  CallDirectionOutbound,
		to:         payload.To,
		audioWsURL: payload.AudioWsURL,
	}
	cm.mu.Unlock()

	// Dial the number. ATD<number>; with trailing semicolon for voice call.
	dialCmd := fmt.Sprintf("ATD%s;", payload.To)
	_, err := cm.mdm.SendCommand(dialCmd, 30*time.Second)
	if err != nil {
		cm.mu.Lock()
		cm.call = nil
		cm.mu.Unlock()

		reason := "dial_failed"
		if errStr := err.Error(); errStr != "" {
			reason = errStr
		}

		// Check for BUSY indication.
		if strings.Contains(strings.ToUpper(err.Error()), "BUSY") {
			cm.sendCallState(callID, CallStateBusy, "", nil)
		} else {
			cm.sendCallState(callID, CallStateFailed, reason, nil)
		}
		return
	}

	// Dial succeeded — acknowledge the make_call request so the server can
	// resolve its pending operation.
	cm.sendAck(TypeCallAck, payload.RequestID)

	// Dial succeeded — transition modem to InCall state.
	_ = cm.stateMachine.TransitionToInCall()

	// Report RINGING state to Svarla.
	cm.sendCallState(callID, CallStateRinging, "", nil)

	// The call is now RINGING. ATD returning OK only means the call was
	// initiated — the remote party has not answered yet, and the network
	// ringback tone is present on the audio path. We must NOT open the audio
	// bridge now, or the caller would hear that ringback streamed as call
	// audio. We wait for the "VOICE CALL: BEGIN" URC (handleVoiceCall), which
	// the SIM7600 emits when the remote party actually answers, before marking
	// the call answered and opening the audio bridge.
}

// handleAnswerCall processes an answer_call message from Svarla.
func (cm *CallManager) handleAnswerCall(msg Message) {
	var payload AnswerCallPayload
	if err := msg.ParsePayload(&payload); err != nil {
		log.Printf("[calls] failed to parse answer_call payload: %v", err)
		return
	}

	cm.mu.Lock()

	// Verify we have a matching incoming call.
	if cm.call == nil || cm.call.callID != payload.CallID {
		cm.mu.Unlock()
		cm.sendCallState(payload.CallID, CallStateFailed, "no_matching_call", nil)
		return
	}

	// Enforce single concurrent call (shouldn't happen, but guard).
	if cm.call.answered {
		cm.mu.Unlock()
		cm.sendCallState(payload.CallID, CallStateFailed, "call_already_answered", nil)
		return
	}

	cm.call.audioWsURL = payload.AudioWsURL
	cm.mu.Unlock()

	// Answer the call with ATA.
	_, err := cm.mdm.SendCommand("ATA", 30*time.Second)
	if err != nil {
		cm.mu.Lock()
		cm.call = nil
		cm.ringing = false
		cm.incomingFrom = ""
		cm.stopReportTimerLocked()
		cm.mu.Unlock()

		reason := "answer_failed"
		if errStr := err.Error(); errStr != "" {
			reason = errStr
		}
		cm.sendCallState(payload.CallID, CallStateFailed, reason, nil)
		return
	}

	// ATA success — acknowledge the answer_call request so the server can
	// resolve its pending operation.
	cm.sendAck(TypeAnswerAck, payload.RequestID)

	// ATA success — modem is now in call.
	_ = cm.stateMachine.TransitionToInCall()

	cm.mu.Lock()
	if cm.call != nil && cm.call.callID == payload.CallID {
		cm.call.answered = true
		cm.call.answerTime = time.Now()
		cm.mu.Unlock()

		cm.sendCallState(payload.CallID, CallStateAnswered, "", nil)
		cm.openAudioBridge(payload.CallID)
	} else {
		cm.mu.Unlock()
	}
}

// handleEndCall processes an end_call message from Svarla.
func (cm *CallManager) handleEndCall(msg Message) {
	var payload EndCallPayload
	if err := msg.ParsePayload(&payload); err != nil {
		log.Printf("[calls] failed to parse end_call payload: %v", err)
		return
	}

	cm.mu.Lock()

	if cm.call == nil {
		cm.mu.Unlock()
		log.Printf("[calls] end_call received but no active call (callId=%s)", payload.CallID)
		return
	}

	if cm.call.callID != payload.CallID {
		// CallId mismatch — this end_call refers to a different (already-ended)
		// call, e.g. a stale/delayed teardown from a previous call. Ignore it,
		// otherwise we would wrongly hang up the current active call.
		cm.mu.Unlock()
		log.Printf("[calls] end_call callId mismatch (active=%s, requested=%s) — ignoring stale end_call",
			cm.call.callID, payload.CallID)
		return
	}

	call := cm.call
	cm.call = nil
	cm.ringing = false
	cm.incomingFrom = ""
	cm.stopReportTimerLocked()
	cm.mu.Unlock()

	log.Printf("[calls] ending call %s via end_call", call.callID)

	// Hang up the voice call FIRST so the caller's line drops immediately and
	// is never delayed by audio-bridge/pipeline goroutine teardown (which waits
	// on goroutines and can take time). We disable PCM streaming directly here
	// — the SIM7600 wants PCM released before hangup — using quick AT commands
	// rather than the full pipeline Stop() (that runs in closeAudio below).
	_, _ = cm.mdm.SendCommand("AT+CPCMREG=0", 5*time.Second)
	cm.hangupModem()

	// Transition modem back to Ready.
	_ = cm.stateMachine.TransitionToReady()

	// Report COMPLETED with duration.
	duration := cm.calculateDuration(call)
	cm.sendCallState(call.callID, CallStateCompleted, "", duration)

	// Tear down the audio bridge and pipeline goroutines in the background.
	// This handler runs synchronously on the signaling read loop, so a slow or
	// stuck teardown here would block ALL subsequent signaling messages
	// (including the next make_call). Running it in a goroutine keeps the read
	// loop responsive so a new call can start immediately.
	go cm.closeAudio(call)
}

// hangupModem terminates the current voice call on the modem. It uses AT+CHUP
// (3GPP voice call hangup), falling back to ATH if AT+CHUP is not supported.
func (cm *CallManager) hangupModem() {
	if _, err := cm.mdm.SendCommand("AT+CHUP", 5*time.Second); err != nil {
		log.Printf("[calls] AT+CHUP failed (%v), falling back to ATH", err)
		_, _ = cm.mdm.SendCommand("ATH", 5*time.Second)
	}
}

// handleURC processes unsolicited result codes from the modem related to calls.
func (cm *CallManager) handleURC(urc modem.URC) {
	switch urc.Prefix {
	case "RING", "+CRING":
		cm.handleRING()
	case "+CLIP":
		cm.handleCLIP(urc)
	case "VOICE CALL":
		cm.handleVoiceCall(urc)
	case "NO CARRIER":
		cm.handleNoCarrier()
	case "MISSED_CALL":
		// SIM7600-specific: sent instead of NO CARRIER when an incoming call
		// rings but is never answered. Treat the same as NO CARRIER for cleanup.
		cm.handleNoCarrier()
	case "BUSY":
		cm.handleBusy()
	}
}

// handleVoiceCall processes the SIM7600 "VOICE CALL:" URC.
//   - "VOICE CALL: BEGIN" fires when the remote party answers an outbound call.
//     This is the true answer signal; ATD returning OK only means the call was
//     initiated (still ringing). We mark the outbound call answered and open the
//     audio bridge here so the caller doesn't hear the network ringback streamed
//     through as call audio.
//   - "VOICE CALL: END" fires when the call ends; NO CARRIER handles cleanup,
//     so it's ignored here.
func (cm *CallManager) handleVoiceCall(urc modem.URC) {
	if !strings.HasPrefix(strings.ToUpper(urc.Data), "BEGIN") {
		return
	}

	cm.mu.Lock()
	call := cm.call
	// Only act on outbound calls that haven't been marked answered yet.
	if call == nil || call.direction != CallDirectionOutbound || call.answered {
		cm.mu.Unlock()
		return
	}
	callID := call.callID
	call.answered = true
	call.answerTime = time.Now()
	cm.mu.Unlock()

	cm.sendCallState(callID, CallStateAnswered, "", nil)
	cm.openAudioBridge(callID)
}

// handleRING processes the RING URC indicating an incoming call.
func (cm *CallManager) handleRING() {
	cm.mu.Lock()

	// If we already have an active call, ignore additional RINGs
	// (could be the same incoming call ringing again).
	if cm.call != nil && !cm.ringing {
		cm.mu.Unlock()
		return
	}

	if cm.ringing {
		// Already reported this incoming call; skip duplicate RING.
		cm.mu.Unlock()
		return
	}

	// Check if signaling is connected. If not, reject the call.
	if !cm.sigClient.IsConnected() {
		cm.mu.Unlock()
		// Reject call when WS is disconnected (req 5.9).
		cm.hangupModem()
		return
	}

	// If there's an existing active call, reject the second incoming call.
	if cm.call != nil {
		cm.mu.Unlock()
		cm.hangupModem()
		return
	}

	// Create a new incoming call entry.
	callID := cm.generateCallID()
	from := cm.incomingFrom // may be empty if +CLIP hasn't arrived yet
	cm.call = &activeCall{
		callID:    callID,
		direction: CallDirectionInbound,
		from:      from,
	}
	cm.ringing = true
	cm.reportSent = false

	// Defer reporting to Svarla so the +CLIP URC (caller number), which the
	// SIM7600 sends just after RING, can populate the number first. This lets
	// us report the call exactly once, with caller ID, instead of first
	// reporting an empty ("anonymous") number and then correcting it.
	cm.reportTimer = time.AfterFunc(clipWaitDelay, func() {
		cm.emitIncomingCall(callID)
	})
	cm.mu.Unlock()
}

// handleCLIP processes the +CLIP URC containing caller ID information.
// +CLIP is typically sent right after RING with the caller's number.
func (cm *CallManager) handleCLIP(urc modem.URC) {
	// Parse number from +CLIP data: "+15551234567",145,...
	number := parseCLIPNumber(urc.Data)

	cm.mu.Lock()
	cm.incomingFrom = number

	// Associate the number with the current inbound call, if any.
	if cm.call != nil && cm.call.direction == CallDirectionInbound && cm.call.from == "" && cm.ringing {
		cm.call.from = number

		// Common case: the deferred report hasn't fired yet, so the timer will
		// pick up the number we just stored. Nothing to send here.
		if !cm.reportSent {
			cm.mu.Unlock()
			return
		}

		// Rare case: +CLIP arrived after the report already went out (empty
		// number). Re-send once so the server can fill in the caller ID.
		callID := cm.call.callID
		cm.mu.Unlock()
		cm.sendIncomingCall(callID, number)
		return
	}
	cm.mu.Unlock()
}

// emitIncomingCall reports the pending inbound call to Svarla exactly once.
// Invoked by the reportTimer set in handleRING (or directly if +CLIP has
// already populated the number). Guarded by reportSent so a late +CLIP or a
// duplicate RING cannot cause a second report.
func (cm *CallManager) emitIncomingCall(callID string) {
	cm.mu.Lock()
	// The call may have ended (NO CARRIER / hangup) during the wait window.
	if cm.call == nil || cm.call.callID != callID || cm.reportSent {
		cm.mu.Unlock()
		return
	}
	cm.reportSent = true
	from := cm.call.from
	cm.mu.Unlock()

	cm.sendIncomingCall(callID, from)
}

// stopReportTimerLocked cancels any pending deferred incoming_call report and
// resets the report guard. The caller must hold cm.mu. Safe to call when no
// timer is pending.
func (cm *CallManager) stopReportTimerLocked() {
	if cm.reportTimer != nil {
		cm.reportTimer.Stop()
		cm.reportTimer = nil
	}
	cm.reportSent = false
}

// handleNoCarrier processes the NO CARRIER URC indicating remote hangup.
func (cm *CallManager) handleNoCarrier() {
	cm.mu.Lock()

	if cm.call == nil {
		cm.mu.Unlock()
		return
	}

	call := cm.call
	cm.call = nil
	cm.ringing = false
	cm.incomingFrom = ""
	cm.stopReportTimerLocked()
	cm.mu.Unlock()

	// Transition modem back to Ready. The state machine's own URC handler
	// may also do this, but it's safe to call multiple times (will error if
	// already in Ready state, which we ignore).
	_ = cm.stateMachine.TransitionToReady()

	// Close audio bridge and pipeline.
	cm.closeAudio(call)

	// Report COMPLETED with duration.
	duration := cm.calculateDuration(call)
	cm.sendCallState(call.callID, CallStateCompleted, "", duration)
}

// handleBusy processes the BUSY URC indicating the remote party is busy.
func (cm *CallManager) handleBusy() {
	cm.mu.Lock()

	if cm.call == nil {
		cm.mu.Unlock()
		return
	}

	call := cm.call
	cm.call = nil
	cm.ringing = false
	cm.incomingFrom = ""
	cm.stopReportTimerLocked()
	cm.mu.Unlock()

	_ = cm.stateMachine.TransitionToReady()
	cm.sendCallState(call.callID, CallStateBusy, "", nil)
}

// HandleModemLost is called when the modem becomes unavailable during a call.
// It closes the audio bridge and reports COMPLETED with reason "modem_lost".
func (cm *CallManager) HandleModemLost() {
	cm.mu.Lock()

	if cm.call == nil {
		cm.mu.Unlock()
		return
	}

	call := cm.call
	cm.call = nil
	cm.ringing = false
	cm.incomingFrom = ""
	cm.stopReportTimerLocked()
	cm.mu.Unlock()

	// Close audio bridge and pipeline.
	cm.closeAudio(call)

	// Report COMPLETED with modem_lost reason.
	duration := cm.calculateDuration(call)
	cm.sendCallState(call.callID, CallStateCompleted, "modem_lost", duration)
}

// HandleDisconnect is called when the signaling WebSocket disconnects.
// If there's an active ringing (unanswered) incoming call, reject it.
func (cm *CallManager) HandleDisconnect() {
	cm.mu.Lock()

	if cm.call == nil {
		cm.mu.Unlock()
		return
	}

	// If the call is ringing but not answered, reject it.
	if cm.ringing && !cm.call.answered {
		call := cm.call
		cm.call = nil
		cm.ringing = false
		cm.incomingFrom = ""
		cm.stopReportTimerLocked()
		cm.mu.Unlock()

		cm.closeAudio(call)
		cm.hangupModem()
		_ = cm.stateMachine.TransitionToReady()
		return
	}

	cm.mu.Unlock()
}

// Shutdown terminates the active call for graceful shutdown.
// It hangs up the modem, closes the audio bridge, and notifies
// Svarla with COMPLETED state and "shutdown" reason. If no call is active,
// this is a no-op.
func (cm *CallManager) Shutdown() {
	cm.mu.Lock()

	if cm.call == nil {
		cm.mu.Unlock()
		return
	}

	call := cm.call
	cm.call = nil
	cm.ringing = false
	cm.incomingFrom = ""
	cm.stopReportTimerLocked()
	cm.mu.Unlock()

	// Close audio bridge and pipeline first (disables PCM streaming), then
	// hang up the voice call.
	cm.closeAudio(call)
	cm.hangupModem()

	// Transition modem back to Ready.
	_ = cm.stateMachine.TransitionToReady()

	// Report COMPLETED with "shutdown" reason and duration.
	duration := cm.calculateDuration(call)
	cm.sendCallState(call.callID, CallStateCompleted, "shutdown", duration)
}

// HasActiveCall returns true if there is currently an active call.
func (cm *CallManager) HasActiveCall() bool {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	return cm.call != nil
}

// IsCallActive is an alias for HasActiveCall, satisfying the CallStateProvider interface.
func (cm *CallManager) IsCallActive() bool {
	return cm.HasActiveCall()
}

// ActiveCallID returns the call ID of the active call, or empty string if none.
func (cm *CallManager) ActiveCallID() string {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	if cm.call != nil {
		return cm.call.callID
	}
	return ""
}

// openAudioBridge connects the audio bridge and starts streaming.
func (cm *CallManager) openAudioBridge(callID string) {
	cm.mu.Lock()
	call := cm.call
	if call == nil || call.callID != callID || call.audioWsURL == "" {
		cm.mu.Unlock()
		return
	}
	cm.mu.Unlock()

	if cm.bridgeFactory == nil {
		return
	}

	// Connect the audio bridge WebSocket to MediaBridge and start streaming
	// FIRST, before the PCM settle delay. This makes MediaBridge see the
	// provider leg connect promptly and bridge the client's (app) WebRTC media
	// to this session, so the app's WebRTC ICE connection stays up. If we
	// delayed this behind the settle + AT+CPCMREG, the app's media path can
	// have no peer, its ICE times out and closes, and the whole call is torn
	// down right after answer (observed on inbound calls).
	//
	// StartStreaming wires BOTH directions at once (capture->bridge uplink and
	// bridge->playback downlink). The capture channel is simply empty until the
	// PCM pipeline is started below; the playback (downlink) path is live
	// immediately so app audio can flow to the modem as soon as PCM is up.
	b := cm.bridgeFactory()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := b.Connect(ctx, call.audioWsURL); err != nil {
		log.Printf("[calls] failed to connect audio bridge: %v", err)
		// Call continues without audio bridge (degraded).
		return
	}

	if cm.audio != nil {
		if err := b.StartStreaming(cm.audio.CaptureFrames(), cm.audio.PlaybackFrames()); err != nil {
			log.Printf("[calls] failed to start audio streaming: %v", err)
			_ = b.Close()
			return
		}
	}

	cm.mu.Lock()
	if cm.call != nil && cm.call.callID == callID {
		cm.call.bridge = b
	} else {
		// Call was ended while we were connecting; close bridge.
		_ = b.Close()
		cm.mu.Unlock()
		return
	}
	cm.mu.Unlock()

	// Brief delay to let the modem's audio subsystem come online after the
	// call is established. Without this, AT+CPCMREG=1 can fail and the PCM
	// stream can start before the modem produces real samples (silence).
	time.Sleep(audioSettleDelay)

	// Start the modem PCM pipeline (AT+CPCMREG=1). This begins producing capture
	// frames (uplink) and enables the modem to play back the downlink frames the
	// bridge is already delivering.
	if cm.audio != nil {
		if err := cm.audio.Start(); err != nil {
			log.Printf("[calls] failed to start audio pipeline: %v", err)
		}
	}
}

// closeAudio shuts down the audio bridge and pipeline for a call.
func (cm *CallManager) closeAudio(call *activeCall) {
	if call == nil {
		return
	}

	if call.bridge != nil {
		_ = call.bridge.Close()
	}

	if cm.audio != nil {
		_ = cm.audio.Stop()
	}
}

// calculateDuration returns the call duration in seconds, or nil if unanswered.
func (cm *CallManager) calculateDuration(call *activeCall) *int64 {
	if call == nil || !call.answered {
		return nil
	}

	duration := int64(time.Since(call.answerTime).Seconds())
	return &duration
}

// sendCallState sends a call_state message to Svarla.
func (cm *CallManager) sendCallState(callID, state, reason string, duration *int64) {
	payload := CallStatePayload{
		Type:            TypeCallState,
		CallID:          callID,
		State:           state,
		Reason:          reason,
		DurationSeconds: duration,
	}

	msg, err := NewMessage(TypeCallState, payload)
	if err != nil {
		log.Printf("[calls] failed to create call_state message: %v", err)
		return
	}

	if err := cm.sigClient.Send(msg); err != nil {
		log.Printf("[calls] failed to send call_state message: %v", err)
	}
}

// sendAck sends an acknowledgement message (call_ack or answer_ack) to Svarla,
// echoing the requestId so the server can resolve its pending operation.
func (cm *CallManager) sendAck(ackType, requestID string) {
	if requestID == "" {
		return
	}
	payload := AckPayload{
		Type:      ackType,
		RequestID: requestID,
	}

	msg, err := NewMessage(ackType, payload)
	if err != nil {
		log.Printf("[calls] failed to create %s message: %v", ackType, err)
		return
	}

	if err := cm.sigClient.Send(msg); err != nil {
		log.Printf("[calls] failed to send %s message: %v", ackType, err)
	}
}

// sendIncomingCall sends an incoming_call message to Svarla.
func (cm *CallManager) sendIncomingCall(callID, from string) {
	payload := IncomingCallPayload{
		Type:   TypeIncomingCall,
		CallID: callID,
		From:   from,
	}

	msg, err := NewMessage(TypeIncomingCall, payload)
	if err != nil {
		log.Printf("[calls] failed to create incoming_call message: %v", err)
		return
	}

	if err := cm.sigClient.Send(msg); err != nil {
		log.Printf("[calls] failed to send incoming_call message: %v", err)
	} else {
		log.Printf("[calls] incoming call reported to server: callID=%s from=%s", callID, from)
	}
}

// generateCallID creates a unique call identifier using a monotonically
// increasing sequence number with a timestamp prefix for readability.
func (cm *CallManager) generateCallID() string {
	seq := cm.callIDSeq.Add(1)
	return fmt.Sprintf("call-%d-%d", time.Now().UnixMilli(), seq)
}

// parseCLIPNumber extracts the phone number from +CLIP data.
// Format: "+15551234567",145,... or "15551234567",129,...
// Returns the number without quotes, or empty string if parsing fails.
func parseCLIPNumber(data string) string {
	data = strings.TrimSpace(data)
	if data == "" {
		return ""
	}

	// Find the first quoted string.
	start := strings.Index(data, "\"")
	if start < 0 {
		// No quotes; try taking up to the first comma.
		if idx := strings.Index(data, ","); idx > 0 {
			return strings.TrimSpace(data[:idx])
		}
		return data
	}

	end := strings.Index(data[start+1:], "\"")
	if end < 0 {
		return ""
	}

	return data[start+1 : start+1+end]
}
