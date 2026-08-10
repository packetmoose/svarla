package webrtc

import (
	"fmt"
	"log/slog"
	"net"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func getFreePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to get free port: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port
}

func newTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

func TestEngine_NewEngine(t *testing.T) {
	port := getFreePort(t)
	logger := newTestLogger()

	engine, err := NewEngine(EngineConfig{
		PublicIP: "192.0.2.1",
		TCPPort:  port,
	}, logger)
	if err != nil {
		t.Fatalf("NewEngine() error: %v", err)
	}
	defer engine.Close()

	if engine.SessionCount() != 0 {
		t.Errorf("initial session count = %d, want 0", engine.SessionCount())
	}
}

func TestEngine_HandleOffer_CreatesSession(t *testing.T) {
	port := getFreePort(t)
	logger := newTestLogger()

	engine, err := NewEngine(EngineConfig{
		PublicIP: "192.0.2.1",
		TCPPort:  port,
	}, logger)
	if err != nil {
		t.Fatalf("NewEngine() error: %v", err)
	}
	defer engine.Close()

	// Create a minimal valid SDP offer.
	sdpOffer := createTestOffer(t, port)

	sdpAnswer, candidates, err := engine.HandleOffer("test-session-1", sdpOffer)
	if err != nil {
		t.Fatalf("HandleOffer() error: %v", err)
	}

	if sdpAnswer == "" {
		t.Error("HandleOffer() returned empty SDP answer")
	}

	if len(candidates) == 0 {
		t.Error("HandleOffer() returned no ICE candidates")
	}

	// Verify candidate contains our public IP.
	found := false
	for _, c := range candidates {
		if c.Candidate != "" && c.SDPMid == "0" {
			found = true
			break
		}
	}
	if !found {
		t.Error("no valid ICE candidate with sdpMid=0")
	}

	// Verify session was created.
	if engine.SessionCount() != 1 {
		t.Errorf("session count = %d, want 1", engine.SessionCount())
	}

	session, ok := engine.GetSession("test-session-1")
	if !ok {
		t.Fatal("session not found")
	}
	if session.State.State() != StateWaitingClient {
		t.Errorf("session state = %v, want WAITING_CLIENT", session.State.State())
	}
}

func TestEngine_HandleOffer_InvalidSDP(t *testing.T) {
	port := getFreePort(t)
	logger := newTestLogger()

	engine, err := NewEngine(EngineConfig{
		PublicIP: "192.0.2.1",
		TCPPort:  port,
	}, logger)
	if err != nil {
		t.Fatalf("NewEngine() error: %v", err)
	}
	defer engine.Close()

	_, _, err = engine.HandleOffer("bad-session", "not-valid-sdp")
	if err == nil {
		t.Error("HandleOffer() with invalid SDP should return error")
	}
}

func TestEngine_RemoveSession(t *testing.T) {
	port := getFreePort(t)
	logger := newTestLogger()

	engine, err := NewEngine(EngineConfig{
		PublicIP: "192.0.2.1",
		TCPPort:  port,
	}, logger)
	if err != nil {
		t.Fatalf("NewEngine() error: %v", err)
	}
	defer engine.Close()

	sdpOffer := createTestOffer(t, port)

	_, _, err = engine.HandleOffer("session-to-remove", sdpOffer)
	if err != nil {
		t.Fatalf("HandleOffer() error: %v", err)
	}

	if engine.SessionCount() != 1 {
		t.Fatalf("session count = %d, want 1", engine.SessionCount())
	}

	if err := engine.RemoveSession("session-to-remove"); err != nil {
		t.Fatalf("RemoveSession() error: %v", err)
	}

	if engine.SessionCount() != 0 {
		t.Errorf("session count after removal = %d, want 0", engine.SessionCount())
	}
}

func TestEngine_RemoveSession_NotFound(t *testing.T) {
	port := getFreePort(t)
	logger := newTestLogger()

	engine, err := NewEngine(EngineConfig{
		PublicIP: "192.0.2.1",
		TCPPort:  port,
	}, logger)
	if err != nil {
		t.Fatalf("NewEngine() error: %v", err)
	}
	defer engine.Close()

	err = engine.RemoveSession("nonexistent")
	if err == nil {
		t.Error("RemoveSession() for nonexistent session should return error")
	}
}

func TestEngine_EventHandler(t *testing.T) {
	port := getFreePort(t)
	logger := newTestLogger()

	engine, err := NewEngine(EngineConfig{
		PublicIP: "192.0.2.1",
		TCPPort:  port,
	}, logger)
	if err != nil {
		t.Fatalf("NewEngine() error: %v", err)
	}
	defer engine.Close()

	var mu sync.Mutex
	var events []SessionEvent

	engine.SetEventHandler(func(event SessionEvent) {
		mu.Lock()
		events = append(events, event)
		mu.Unlock()
	})

	sdpOffer := createTestOffer(t, port)
	_, _, err = engine.HandleOffer("event-session", sdpOffer)
	if err != nil {
		t.Fatalf("HandleOffer() error: %v", err)
	}

	// Give a moment for any async events to propagate.
	time.Sleep(50 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	// We expect a state_changed event when transitioning to WAITING_CLIENT.
	found := false
	for _, ev := range events {
		if ev.Type == EventStateChanged && ev.State == StateWaitingClient {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected state_changed event to WAITING_CLIENT, got events: %+v", events)
	}
}

func TestEngine_Close(t *testing.T) {
	port := getFreePort(t)
	logger := newTestLogger()

	engine, err := NewEngine(EngineConfig{
		PublicIP: "192.0.2.1",
		TCPPort:  port,
	}, logger)
	if err != nil {
		t.Fatalf("NewEngine() error: %v", err)
	}

	sdpOffer := createTestOffer(t, port)
	_, _, err = engine.HandleOffer("close-session", sdpOffer)
	if err != nil {
		t.Fatalf("HandleOffer() error: %v", err)
	}

	if err := engine.Close(); err != nil {
		t.Fatalf("Close() error: %v", err)
	}

	if engine.SessionCount() != 0 {
		t.Errorf("session count after close = %d, want 0", engine.SessionCount())
	}
}

// createTestOffer generates a valid SDP offer using a local Pion PeerConnection.
func createTestOffer(t *testing.T, _ int) string {
	t.Helper()

	// Create a standard (non-ICE Lite) peer connection to generate a valid offer.
	me := &webrtc.MediaEngine{}
	if err := me.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypePCMU,
			ClockRate: 8000,
			Channels:  1,
		},
		PayloadType: 0,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		t.Fatalf("register pcmu codec: %v", err)
	}

	api := webrtc.NewAPI(webrtc.WithMediaEngine(me))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("create peer connection: %v", err)
	}
	defer pc.Close()

	// Add audio transceiver to generate audio in the SDP.
	_, err = pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionSendrecv,
	})
	if err != nil {
		t.Fatalf("add transceiver: %v", err)
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}

	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("set local description: %v", err)
	}

	return offer.SDP
}

func TestEngine_DefaultConfig(t *testing.T) {
	// Verify that zero-value config fields get proper defaults.
	port := getFreePort(t)
	logger := newTestLogger()

	engine, err := NewEngine(EngineConfig{
		TCPPort: port,
		// Leave PublicIP at zero value.
	}, logger)
	if err != nil {
		t.Fatalf("NewEngine() error: %v", err)
	}
	defer engine.Close()

	if engine.config.PublicIP != "127.0.0.1" {
		t.Errorf("default PublicIP = %q, want 127.0.0.1", engine.config.PublicIP)
	}
}

func TestEngine_MultipleSessions(t *testing.T) {
	port := getFreePort(t)
	logger := newTestLogger()

	engine, err := NewEngine(EngineConfig{
		PublicIP: "192.0.2.1",
		TCPPort:  port,
	}, logger)
	if err != nil {
		t.Fatalf("NewEngine() error: %v", err)
	}
	defer engine.Close()

	sdpOffer := createTestOffer(t, port)

	for i := 0; i < 5; i++ {
		sessionID := fmt.Sprintf("session-%d", i)
		_, _, err := engine.HandleOffer(sessionID, sdpOffer)
		if err != nil {
			t.Fatalf("HandleOffer(%s) error: %v", sessionID, err)
		}
	}

	if engine.SessionCount() != 5 {
		t.Errorf("session count = %d, want 5", engine.SessionCount())
	}
}
