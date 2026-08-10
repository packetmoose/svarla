package dtmf

import (
	"log/slog"
	"sync"
)

// SIPSender is the interface for sending RFC 2833 telephone-event RTP packets
// on the SIP leg (outbound DTMF relay).
type SIPSender interface {
	// SendTelephoneEvent sends an RFC 2833 event on the SIP RTP stream.
	SendTelephoneEvent(payload []byte) error
}

// EventEmitter is the interface for emitting DTMF events to the Server
// via the event WebSocket (inbound DTMF notification).
type EventEmitter interface {
	// EmitDTMF emits a DTMF digit event for a session.
	EmitDTMF(sessionID, digit string)
}

// Relay bridges DTMF between the WebRTC leg and SIP leg of a session.
//
// Outbound DTMF (WebRTC → SIP):
//   - Detects RFC 2833 telephone-event packets from the WebRTC leg
//   - Relays them as RFC 2833 on the SIP leg via SIPSender
//
// Inbound DTMF (SIP → Server):
//   - Detects RFC 2833 telephone-event packets from the SIP leg
//   - Emits DTMF events to the Server via EventEmitter
type Relay struct {
	mu        sync.Mutex
	sessionID string
	logger    *slog.Logger

	// sipSender sends RFC 2833 payloads on the SIP leg.
	sipSender SIPSender

	// eventEmitter notifies the Server of inbound DTMF.
	eventEmitter EventEmitter

	// webrtcDetector detects DTMF from WebRTC leg → relay to SIP.
	webrtcDetector *Detector

	// sipDetector detects DTMF from SIP leg → emit to Server.
	sipDetector *Detector

	stopped bool
}

// RelayConfig holds configuration for creating a DTMF relay.
type RelayConfig struct {
	SessionID    string
	SIPSender    SIPSender
	EventEmitter EventEmitter
	Logger       *slog.Logger
}

// NewRelay creates a DTMF relay for the given session.
func NewRelay(cfg RelayConfig) *Relay {
	r := &Relay{
		sessionID:    cfg.SessionID,
		logger:       cfg.Logger,
		sipSender:    cfg.SIPSender,
		eventEmitter: cfg.EventEmitter,
	}

	// WebRTC detector: when we get a complete digit from WebRTC, relay it to SIP.
	r.webrtcDetector = NewDetector(r.handleOutboundDTMF, cfg.Logger)

	// SIP detector: when we get a complete digit from SIP, emit to Server.
	r.sipDetector = NewDetector(r.handleInboundDTMF, cfg.Logger)

	return r
}

// HandleWebRTCPacket processes an RFC 2833 telephone-event payload received
// from the WebRTC leg. The payload is relayed in-band to the SIP leg and
// also detected for event-based notification.
func (r *Relay) HandleWebRTCPacket(payload []byte) {
	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		return
	}
	r.mu.Unlock()

	// In-band relay: forward the raw RFC 2833 payload to the SIP leg.
	if r.sipSender != nil {
		if err := r.sipSender.SendTelephoneEvent(payload); err != nil {
			r.logger.Warn("failed to relay DTMF to SIP leg",
				slog.String("sessionId", r.sessionID),
				slog.String("error", err.Error()),
			)
		}
	}

	// Event-based detection: parse and detect the digit for logging/notification.
	r.webrtcDetector.ProcessPacket(payload)
}

// HandleSIPPacket processes an RFC 2833 telephone-event payload received
// from the SIP leg. The digit is emitted to the Server via the event WebSocket.
func (r *Relay) HandleSIPPacket(payload []byte) {
	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		return
	}
	r.mu.Unlock()

	// Detect complete digits from SIP and emit events.
	r.sipDetector.ProcessPacket(payload)
}

// handleOutboundDTMF is called when a complete digit is detected from the WebRTC leg.
func (r *Relay) handleOutboundDTMF(digit string) {
	r.logger.Info("DTMF detected from WebRTC leg (outbound)",
		slog.String("sessionId", r.sessionID),
		slog.String("digit", digit),
	)
}

// handleInboundDTMF is called when a complete digit is detected from the SIP leg.
func (r *Relay) handleInboundDTMF(digit string) {
	r.logger.Info("DTMF detected from SIP leg (inbound)",
		slog.String("sessionId", r.sessionID),
		slog.String("digit", digit),
	)

	// Emit the DTMF event to the Server via event WebSocket.
	if r.eventEmitter != nil {
		r.eventEmitter.EmitDTMF(r.sessionID, digit)
	}
}

// Stop halts the relay, preventing further processing.
func (r *Relay) Stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stopped = true
	r.webrtcDetector.Reset()
	r.sipDetector.Reset()
}
