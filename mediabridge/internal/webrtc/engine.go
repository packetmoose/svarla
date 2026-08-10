package webrtc

import (
	"fmt"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

const ipCacheDuration = 2 * time.Minute

// EngineConfig holds configuration for the WebRTC engine.
type EngineConfig struct {
	// PublicIP is the public IP address to advertise in ICE candidates.
	PublicIP string
	// TCPPort is the fixed TCP port for WebRTC connections (default 10443).
	TCPPort int
}

// Engine manages WebRTC peer connections with ICE Lite configuration.
type Engine struct {
	config       EngineConfig
	logger       *slog.Logger
	tcpListener  net.Listener
	tcpMux       ice.TCPMux
	udpConn      net.PacketConn
	mediaEngine  *webrtc.MediaEngine

	mu       sync.RWMutex
	sessions map[string]*PeerSession

	// resolvedIP caches the resolved numeric IP and when it was resolved.
	resolvedIP   string
	resolvedAt   time.Time

	// eventHandler is called when session events occur.
	eventHandler EventHandler
}

// PeerSession represents a WebRTC peer connection for a single session.
type PeerSession struct {
	SessionID  string
	PC         *webrtc.PeerConnection
	State      *SessionStateMachine
	audioTrack *webrtc.TrackLocalStaticRTP

	// mu protects onTrackHandler and remoteTrack.
	mu             sync.RWMutex
	onTrackHandler func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver)
	// remoteTrack stores the client's incoming audio track if it arrives
	// before the OnTrack handler is set (race condition workaround).
	remoteTrack    *webrtc.TrackRemote
	remoteReceiver *webrtc.RTPReceiver
}

// AudioTrack returns the local audio track used for sending audio to the client.
func (ps *PeerSession) AudioTrack() *webrtc.TrackLocalStaticRTP {
	return ps.audioTrack
}

// SetOnTrackHandler sets a callback that will be invoked when the client's
// audio track is received. If the track has already arrived, the handler
// is called immediately with the stored track.
func (ps *PeerSession) SetOnTrackHandler(handler func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver)) {
	ps.mu.Lock()
	ps.onTrackHandler = handler
	// If the track already arrived before the handler was set, call it now.
	track := ps.remoteTrack
	receiver := ps.remoteReceiver
	ps.mu.Unlock()

	if track != nil && handler != nil {
		handler(track, receiver)
	}
}

// getOnTrackHandler returns the current OnTrack handler.
func (ps *PeerSession) getOnTrackHandler() func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	return ps.onTrackHandler
}

// setRemoteTrack stores the remote track for later retrieval.
func (ps *PeerSession) setRemoteTrack(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	ps.remoteTrack = track
	ps.remoteReceiver = receiver
}

// NewEngine creates and initializes a new WebRTC engine.
// It sets up ICE Lite with TCP on the configured port and Opus-only audio codecs.
func NewEngine(cfg EngineConfig, logger *slog.Logger) (*Engine, error) {
	if cfg.TCPPort == 0 {
		cfg.TCPPort = 8443
	}
	if cfg.PublicIP == "" {
		cfg.PublicIP = "127.0.0.1"
	}

	e := &Engine{
		config:   cfg,
		logger:   logger,
		sessions: make(map[string]*PeerSession),
	}

	if err := e.init(); err != nil {
		return nil, fmt.Errorf("initializing webrtc engine: %w", err)
	}

	return e, nil
}

// init sets up the TCP listener, ICE Lite settings, and Pion API.
func (e *Engine) init() error {
	// Create TCP listener on the configured port.
	addr := fmt.Sprintf("0.0.0.0:%d", e.config.TCPPort)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listening on %s: %w", addr, err)
	}
	e.tcpListener = listener

	// Create TCP mux for ICE over TCP.
	e.tcpMux = webrtc.NewICETCPMux(nil, listener, 20)

	// Create UDP listener on the same port for ICE over UDP.
	// UDP is the primary transport for WebRTC and works on all clients.
	udpAddr := fmt.Sprintf("0.0.0.0:%d", e.config.TCPPort)
	udpConn, err := net.ListenPacket("udp", udpAddr)
	if err != nil {
		listener.Close()
		return fmt.Errorf("listening UDP on %s: %w", udpAddr, err)
	}
	e.udpConn = udpConn

	// Configure MediaEngine with PCMU (G.711 µ-law) audio only.
	// We use PCMU instead of Opus because:
	// 1. The SIP provider sends G.711, enabling zero-transcoding passthrough
	// 2. Pure-Go Opus codecs have quality issues with CGO_ENABLED=0
	// 3. PCMU is mandatory-to-implement per WebRTC spec — all browsers support it
	// Voice quality at 64kbps G.711 is equivalent to landline (toll quality).
	me := &webrtc.MediaEngine{}
	if err := me.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypePCMU,
			ClockRate: 8000,
			Channels:  1,
		},
		PayloadType: 0,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		listener.Close()
		udpConn.Close()
		return fmt.Errorf("registering pcmu codec: %w", err)
	}
	e.mediaEngine = me

	// Do initial DNS resolution.
	ip, err := e.resolvePublicIP()
	if err != nil {
		listener.Close()
		udpConn.Close()
		return err
	}

	e.logger.Info("webrtc listeners started",
		slog.String("addr", addr),
		slog.String("publicIP", ip),
		slog.String("transports", "tcp+udp"),
	)

	return nil
}

// resolvePublicIP returns the numeric IP for the configured PublicIP.
// If PublicIP is already a numeric IP, returns it directly.
// If it's a hostname, resolves via DNS with a 2-minute cache.
func (e *Engine) resolvePublicIP() (string, error) {
	// If it's already a numeric IP, no resolution needed.
	if net.ParseIP(e.config.PublicIP) != nil {
		return e.config.PublicIP, nil
	}

	// Check cache.
	if e.resolvedIP != "" && time.Since(e.resolvedAt) < ipCacheDuration {
		return e.resolvedIP, nil
	}

	// Resolve hostname.
	ips, err := net.LookupHost(e.config.PublicIP)
	if err != nil || len(ips) == 0 {
		return "", fmt.Errorf("resolving publicIp hostname %q: %w", e.config.PublicIP, err)
	}

	newIP := ips[0]
	if newIP != e.resolvedIP {
		e.logger.Info("resolved publicIp hostname",
			slog.String("hostname", e.config.PublicIP),
			slog.String("ip", newIP),
		)
	}
	e.resolvedIP = newIP
	e.resolvedAt = time.Now()
	return newIP, nil
}

// buildAPI creates a new Pion WebRTC API configured for the given public IP.
func (e *Engine) buildAPI(publicIP string) *webrtc.API {
	var se webrtc.SettingEngine
	se.SetLite(true)
	se.SetICETCPMux(e.tcpMux)
	se.SetICEUDPMux(webrtc.NewICEUDPMux(nil, e.udpConn))
	se.SetNAT1To1IPs([]string{publicIP}, webrtc.ICECandidateTypeHost)
	// Enable both UDP and TCP for ICE connectivity.
	// UDP is the standard WebRTC transport and works on all clients.
	// TCP is a fallback for restrictive firewalls.
	se.SetNetworkTypes([]webrtc.NetworkType{
		webrtc.NetworkTypeUDP4,
		webrtc.NetworkTypeTCP4,
	})

	return webrtc.NewAPI(
		webrtc.WithSettingEngine(se),
		webrtc.WithMediaEngine(e.mediaEngine),
	)
}

// SetEventHandler sets the callback for session events.
func (e *Engine) SetEventHandler(handler EventHandler) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.eventHandler = handler
}

// emitEvent sends an event to the registered handler.
func (e *Engine) emitEvent(event SessionEvent) {
	e.mu.RLock()
	handler := e.eventHandler
	e.mu.RUnlock()

	if handler != nil {
		handler(event)
	}
}

// HandleOffer processes an SDP offer for the given session, creating a new
// PeerConnection if needed, and returns the SDP answer and ICE candidates.
func (e *Engine) HandleOffer(sessionID, sdpOffer string) (sdpAnswer string, candidates []ICECandidate, err error) {
	e.mu.Lock()
	session, exists := e.sessions[sessionID]
	if !exists {
		// Create a new peer session.
		session, err = e.createSession(sessionID)
		if err != nil {
			e.mu.Unlock()
			return "", nil, fmt.Errorf("creating session %s: %w", sessionID, err)
		}
		e.sessions[sessionID] = session
	}
	e.mu.Unlock()

	// Set the remote SDP offer.
	offer := webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  sdpOffer,
	}
	if err := session.PC.SetRemoteDescription(offer); err != nil {
		return "", nil, fmt.Errorf("setting remote description: %w", err)
	}

	// Create an SDP answer.
	answer, err := session.PC.CreateAnswer(nil)
	if err != nil {
		return "", nil, fmt.Errorf("creating answer: %w", err)
	}

	// Set the local description.
	if err := session.PC.SetLocalDescription(answer); err != nil {
		return "", nil, fmt.Errorf("setting local description: %w", err)
	}

	// Transition state to WAITING_CLIENT.
	if session.State.State() == StateCreated {
		if err := session.State.Transition(StateWaitingClient); err != nil {
			e.logger.Warn("state transition failed", slog.String("error", err.Error()))
		} else {
			e.emitEvent(SessionEvent{
				SessionID: sessionID,
				Type:      EventStateChanged,
				State:     StateWaitingClient,
			})
		}
	}

	// With ICE Lite, all candidates are known upfront (public IP + TCP/UDP port).
	// Build the candidates and inject them into the SDP answer so clients don't
	// need separate addIceCandidate calls (some clients don't handle trickle ICE).
	publicIP, _ := e.resolvePublicIP()

	// UDP candidate (primary — works on all WebRTC clients including Android).
	// Pion with ICE Lite + NAT1To1IPs will listen on UDP on the same port as TCP.
	udpCandidateStr := fmt.Sprintf("a=candidate:1 1 udp 2130706431 %s %d typ host", publicIP, e.config.TCPPort)
	// TCP candidate (fallback for restrictive networks).
	tcpCandidateStr := fmt.Sprintf("a=candidate:2 1 tcp 2128609279 %s %d typ host tcptype passive", publicIP, e.config.TCPPort)

	// Inject both candidates into the SDP answer.
	sdpAnswer = session.PC.LocalDescription().SDP
	sdpAnswer = injectCandidateIntoSDP(sdpAnswer, udpCandidateStr)
	sdpAnswer = injectCandidateIntoSDP(sdpAnswer, tcpCandidateStr)

	iceCandidates := []ICECandidate{
		{
			Candidate:     fmt.Sprintf("candidate:1 1 udp 2130706431 %s %d typ host", publicIP, e.config.TCPPort),
			SDPMid:        "0",
			SDPMLineIndex: 0,
		},
		{
			Candidate:     fmt.Sprintf("candidate:2 1 tcp 2128609279 %s %d typ host tcptype passive", publicIP, e.config.TCPPort),
			SDPMid:        "0",
			SDPMLineIndex: 0,
		},
	}

	return sdpAnswer, iceCandidates, nil
}

// createSession creates a new PeerConnection with ICE Lite configuration.
func (e *Engine) createSession(sessionID string) (*PeerSession, error) {
	// Resolve public IP (cached for 2 minutes).
	publicIP, err := e.resolvePublicIP()
	if err != nil {
		return nil, fmt.Errorf("resolving public IP: %w", err)
	}

	// Build API with current IP.
	api := e.buildAPI(publicIP)

	// PeerConnection configuration — no ICE servers needed with ICE Lite.
	pcConfig := webrtc.Configuration{
		ICETransportPolicy: webrtc.ICETransportPolicyAll,
	}

	pc, err := api.NewPeerConnection(pcConfig)
	if err != nil {
		return nil, fmt.Errorf("creating peer connection: %w", err)
	}

	// Create a local audio track for sending audio to the client (PCMU, 8kHz).
	// G.711 µ-law passes through directly from the SIP provider without transcoding.
	audioTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypePCMU,
			ClockRate: 8000,
			Channels:  1,
		},
		"audio",
		"mediabridge",
	)
	if err != nil {
		pc.Close()
		return nil, fmt.Errorf("creating local audio track: %w", err)
	}

	// Add the local track as a sender (this also sets up the transceiver as sendrecv).
	sender, err := pc.AddTrack(audioTrack)
	if err != nil {
		pc.Close()
		return nil, fmt.Errorf("adding local audio track: %w", err)
	}

	// Read and discard RTCP packets from the sender to avoid blocking.
	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, err := sender.Read(buf); err != nil {
				return
			}
		}
	}()

	session := &PeerSession{
		SessionID:  sessionID,
		PC:         pc,
		State:      NewSessionStateMachine(),
		audioTrack: audioTrack,
	}

	// Monitor ICE connection state changes.
	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		e.logger.Info("ICE connection state changed",
			slog.String("sessionId", sessionID),
			slog.String("state", state.String()),
		)
		e.handleICEStateChange(session, state)
	})

	// Monitor peer connection state changes.
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		e.logger.Info("peer connection state changed",
			slog.String("sessionId", sessionID),
			slog.String("state", state.String()),
		)
		e.handlePeerConnectionStateChange(session, state)
	})

	// Handle incoming audio tracks from the client.
	pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		e.logger.Info("received audio track",
			slog.String("sessionId", sessionID),
			slog.String("codec", track.Codec().MimeType),
		)

		// Check if a custom OnTrack handler has been set (by the media session).
		handler := session.getOnTrackHandler()
		if handler != nil {
			handler(track, receiver)
			return
		}

		// Handler not set yet — store the track so it can be picked up later.
		// This handles the race where OnTrack fires before the media session
		// has a chance to call SetOnTrackHandler.
		session.setRemoteTrack(track, receiver)
	})

	return session, nil
}

// handleICEStateChange processes ICE connection state transitions.
func (e *Engine) handleICEStateChange(session *PeerSession, state webrtc.ICEConnectionState) {
	switch state {
	case webrtc.ICEConnectionStateConnected:
		currentState := session.State.State()
		if currentState == StateWaitingClient {
			if err := session.State.Transition(StateClientConnected); err == nil {
				e.emitEvent(SessionEvent{
					SessionID: session.SessionID,
					Type:      EventClientConnected,
					State:     StateClientConnected,
				})
			}
		}

	case webrtc.ICEConnectionStateDisconnected, webrtc.ICEConnectionStateFailed:
		reason := "ice_disconnected"
		if state == webrtc.ICEConnectionStateFailed {
			reason = "ice_failed"
		}
		e.emitEvent(SessionEvent{
			SessionID: session.SessionID,
			Type:      EventClientDisconnected,
			Reason:    reason,
			State:     session.State.State(),
		})

	case webrtc.ICEConnectionStateClosed:
		e.emitEvent(SessionEvent{
			SessionID: session.SessionID,
			Type:      EventClientDisconnected,
			Reason:    "closed",
			State:     session.State.State(),
		})
	}
}

// handlePeerConnectionStateChange processes peer connection state transitions.
func (e *Engine) handlePeerConnectionStateChange(session *PeerSession, state webrtc.PeerConnectionState) {
	switch state {
	case webrtc.PeerConnectionStateConnected:
		currentState := session.State.State()
		if currentState == StateWaitingClient {
			if err := session.State.Transition(StateClientConnected); err == nil {
				e.emitEvent(SessionEvent{
					SessionID: session.SessionID,
					Type:      EventClientConnected,
					State:     StateClientConnected,
				})
			}
		}

	case webrtc.PeerConnectionStateDisconnected:
		e.emitEvent(SessionEvent{
			SessionID: session.SessionID,
			Type:      EventClientDisconnected,
			Reason:    "peer_disconnected",
			State:     session.State.State(),
		})

	case webrtc.PeerConnectionStateFailed:
		e.emitEvent(SessionEvent{
			SessionID: session.SessionID,
			Type:      EventClientDisconnected,
			Reason:    "peer_failed",
			State:     session.State.State(),
		})

	case webrtc.PeerConnectionStateClosed:
		e.emitEvent(SessionEvent{
			SessionID: session.SessionID,
			Type:      EventClientDisconnected,
			Reason:    "closed",
			State:     session.State.State(),
		})
	}
}

// GetSession returns the PeerSession for the given session ID.
func (e *Engine) GetSession(sessionID string) (*PeerSession, bool) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	s, ok := e.sessions[sessionID]
	return s, ok
}

// RemoveSession closes and removes a peer session.
func (e *Engine) RemoveSession(sessionID string) error {
	e.mu.Lock()
	session, exists := e.sessions[sessionID]
	if !exists {
		e.mu.Unlock()
		return fmt.Errorf("session %s not found", sessionID)
	}
	delete(e.sessions, sessionID)
	e.mu.Unlock()

	// Close the peer connection.
	if err := session.PC.Close(); err != nil {
		return fmt.Errorf("closing peer connection for %s: %w", sessionID, err)
	}

	// Transition to destroyed.
	_ = session.State.Transition(StateClosing)
	_ = session.State.Transition(StateDestroyed)

	return nil
}

// SessionCount returns the number of active sessions.
func (e *Engine) SessionCount() int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return len(e.sessions)
}

// Close shuts down the engine, closing all sessions and the TCP listener.
func (e *Engine) Close() error {
	e.mu.Lock()
	sessions := make(map[string]*PeerSession, len(e.sessions))
	for k, v := range e.sessions {
		sessions[k] = v
	}
	e.sessions = make(map[string]*PeerSession)
	e.mu.Unlock()

	// Close all peer connections.
	for id, session := range sessions {
		if err := session.PC.Close(); err != nil {
			e.logger.Error("error closing session",
				slog.String("sessionId", id),
				slog.String("error", err.Error()),
			)
		}
	}

	// Close TCP listener.
	if e.tcpListener != nil {
		if err := e.tcpListener.Close(); err != nil {
			return fmt.Errorf("closing TCP listener: %w", err)
		}
	}

	// Close UDP listener.
	if e.udpConn != nil {
		if err := e.udpConn.Close(); err != nil {
			return fmt.Errorf("closing UDP listener: %w", err)
		}
	}

	e.logger.Info("webrtc engine shut down")
	return nil
}

// ICECandidate represents a single ICE candidate to return to the client.
type ICECandidate struct {
	Candidate     string `json:"candidate"`
	SDPMid        string `json:"sdpMid"`
	SDPMLineIndex int    `json:"sdpMLineIndex"`
}

// injectCandidateIntoSDP inserts an ICE candidate line into an SDP string.
// The candidate is added at the end of the first media section (after the
// last attribute line of the m= block). This ensures the client sees the
// candidate without needing a separate addIceCandidate call.
func injectCandidateIntoSDP(sdp, candidateLine string) string {
	lines := strings.Split(sdp, "\r\n")
	var result []string
	injected := false

	for i, line := range lines {
		result = append(result, line)

		// Inject candidate after the last line of the audio media section.
		// We look for the end of the SDP or the start of another m= section.
		if !injected && i > 0 {
			// Check if we're in a media section and the next line is either
			// end of SDP or another m= line.
			inMedia := false
			for j := i; j >= 0; j-- {
				if strings.HasPrefix(lines[j], "m=") {
					inMedia = true
					break
				}
			}
			if inMedia {
				nextIsEnd := (i == len(lines)-1) || (i+1 < len(lines) && lines[i+1] == "")
				nextIsMedia := (i+1 < len(lines) && strings.HasPrefix(lines[i+1], "m="))
				if nextIsEnd || nextIsMedia {
					result = append(result, candidateLine)
					injected = true
				}
			}
		}
	}

	// If we didn't inject (shouldn't happen), append at the end.
	if !injected {
		result = append(result, candidateLine)
	}

	return strings.Join(result, "\r\n")
}
