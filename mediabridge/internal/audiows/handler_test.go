package audiows

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"mediabridge/internal/events"
	"mediabridge/internal/session"

	"github.com/gorilla/websocket"
)

// --- Test helpers ---

type discardWriter struct{}

func (d *discardWriter) Write(p []byte) (n int, err error) { return len(p), nil }

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(&discardWriter{}, nil))
}

type messageCollector struct {
	mu       sync.Mutex
	messages [][]byte
}

func (mc *messageCollector) add(msg []byte) {
	mc.mu.Lock()
	defer mc.mu.Unlock()
	mc.messages = append(mc.messages, msg)
}

func (mc *messageCollector) getAll() [][]byte {
	mc.mu.Lock()
	defer mc.mu.Unlock()
	result := make([][]byte, len(mc.messages))
	copy(result, mc.messages)
	return result
}

func (mc *messageCollector) count() int {
	mc.mu.Lock()
	defer mc.mu.Unlock()
	return len(mc.messages)
}

// createTestEventServer creates an events.Server and an httptest.Server hosting
// the /events endpoint. It also connects a collector WebSocket client that
// records all events emitted by the server.
func createTestEventServer(t *testing.T) (*events.Server, *httptest.Server, *messageCollector) {
	t.Helper()

	es := events.NewServer(events.ServerConfig{
		BufferSize:     256,
		HealthInterval: 1 * time.Hour, // Don't emit health events in tests.
	}, func() (int, int) { return 0, 0 }, testLogger())
	es.Start()

	// Create an HTTP test server that hosts the event WebSocket endpoint.
	mux := http.NewServeMux()
	mux.Handle("/events", es)
	srv := httptest.NewServer(mux)

	// Connect a collector client to the event server.
	mc := &messageCollector{}
	wsURL := "ws" + srv.URL[len("http"):] + "/events"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("failed to connect collector to event server: %v", err)
	}

	// Read events in the background.
	go func() {
		defer conn.Close()
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			mc.add(msg)
		}
	}()

	// Wait for connection to be registered.
	waitFor(t, 500*time.Millisecond, func() bool { return es.IsConnected() })

	t.Cleanup(func() {
		es.Shutdown()
		srv.Close()
	})

	return es, srv, mc
}

// createSimpleEventServer creates an events.Server without a collector — for
// tests that don't need to inspect emitted events.
func createSimpleEventServer(t *testing.T) *events.Server {
	t.Helper()

	es := events.NewServer(events.ServerConfig{
		BufferSize:     256,
		HealthInterval: 1 * time.Hour,
	}, func() (int, int) { return 0, 0 }, testLogger())
	es.Start()

	t.Cleanup(func() {
		es.Shutdown()
	})

	return es
}

// setupTestHandler creates a Handler with a test HTTP server.
func setupTestHandler(t *testing.T, token string, store *session.Store, eventServer *events.Server) (*Handler, *httptest.Server) {
	t.Helper()

	cfg := Config{
		Port:  9091, // Not used directly; test server handles port.
		Token: token,
	}

	h := NewHandler(cfg, store, eventServer, testLogger())

	mux := http.NewServeMux()
	mux.HandleFunc("/audio/", h.handleAudioWS)

	srv := httptest.NewServer(mux)
	return h, srv
}

// connectWS dials a WebSocket connection to the test server.
func connectWS(t *testing.T, url string, headers http.Header) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	dialer := websocket.Dialer{}
	return dialer.Dial(url, headers)
}

// waitFor polls a condition until it returns true or the timeout expires.
func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// --- Tests ---

func TestExtractSessionID(t *testing.T) {
	tests := []struct {
		path     string
		expected string
	}{
		{"/audio/session-123", "session-123"},
		{"/audio/abc-def-ghi-jkl", "abc-def-ghi-jkl"},
		{"/audio/session-123/", "session-123"},
		{"/audio/", ""},
		{"/audio", ""},
		{"/other/session-123", ""},
		{"/audio/session/extra", ""},
		{"", ""},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			result := extractSessionID(tt.path)
			if result != tt.expected {
				t.Errorf("extractSessionID(%q) = %q, want %q", tt.path, result, tt.expected)
			}
		})
	}
}

func TestAuthenticate_NoTokenRequired(t *testing.T) {
	store := session.NewStore()
	es := createSimpleEventServer(t)

	// No token configured — all connections should be allowed.
	_, srv := setupTestHandler(t, "", store, es)
	defer srv.Close()

	// Create a session so the handler can look it up.
	sess := session.NewSession("test-session", session.ProviderLeg{
		Type: session.ProviderLegWebSocket,
	}, session.Options{})
	_ = store.Create(sess)

	wsURL := "ws" + srv.URL[len("http"):] + "/audio/test-session"
	conn, _, err := connectWS(t, wsURL, nil)
	if err != nil {
		t.Fatalf("expected connection to succeed without token, got: %v", err)
	}
	conn.Close()
}

func TestAuthenticate_ValidBearerToken(t *testing.T) {
	store := session.NewStore()
	es := createSimpleEventServer(t)

	_, srv := setupTestHandler(t, "secret-token-123", store, es)
	defer srv.Close()

	sess := session.NewSession("test-session", session.ProviderLeg{
		Type: session.ProviderLegWebSocket,
	}, session.Options{})
	_ = store.Create(sess)

	// Valid Bearer token in Authorization header.
	headers := http.Header{}
	headers.Set("Authorization", "Bearer secret-token-123")

	wsURL := "ws" + srv.URL[len("http"):] + "/audio/test-session"
	conn, _, err := connectWS(t, wsURL, headers)
	if err != nil {
		t.Fatalf("expected connection to succeed with valid token, got: %v", err)
	}
	conn.Close()
}

func TestAuthenticate_ValidQueryToken(t *testing.T) {
	store := session.NewStore()
	es := createSimpleEventServer(t)

	_, srv := setupTestHandler(t, "my-token", store, es)
	defer srv.Close()

	sess := session.NewSession("test-session", session.ProviderLeg{
		Type: session.ProviderLegWebSocket,
	}, session.Options{})
	_ = store.Create(sess)

	// Token via query parameter.
	wsURL := "ws" + srv.URL[len("http"):] + "/audio/test-session?token=my-token"
	conn, _, err := connectWS(t, wsURL, nil)
	if err != nil {
		t.Fatalf("expected connection to succeed with query token, got: %v", err)
	}
	conn.Close()
}

func TestAuthenticate_InvalidToken(t *testing.T) {
	store := session.NewStore()
	es := createSimpleEventServer(t)

	_, srv := setupTestHandler(t, "correct-token", store, es)
	defer srv.Close()

	sess := session.NewSession("test-session", session.ProviderLeg{
		Type: session.ProviderLegWebSocket,
	}, session.Options{})
	_ = store.Create(sess)

	// Wrong token.
	headers := http.Header{}
	headers.Set("Authorization", "Bearer wrong-token")

	wsURL := "ws" + srv.URL[len("http"):] + "/audio/test-session"
	_, resp, err := connectWS(t, wsURL, headers)
	if err == nil {
		t.Fatal("expected connection to fail with invalid token")
	}
	if resp != nil && resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401 status, got %d", resp.StatusCode)
	}
}

func TestAuthenticate_MissingTokenWhenRequired(t *testing.T) {
	store := session.NewStore()
	es := createSimpleEventServer(t)

	_, srv := setupTestHandler(t, "required-token", store, es)
	defer srv.Close()

	sess := session.NewSession("test-session", session.ProviderLeg{
		Type: session.ProviderLegWebSocket,
	}, session.Options{})
	_ = store.Create(sess)

	// No token at all.
	wsURL := "ws" + srv.URL[len("http"):] + "/audio/test-session"
	_, resp, err := connectWS(t, wsURL, nil)
	if err == nil {
		t.Fatal("expected connection to fail with no token when required")
	}
	if resp != nil && resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401 status, got %d", resp.StatusCode)
	}
}

func TestSessionNotFound(t *testing.T) {
	store := session.NewStore()
	es := createSimpleEventServer(t)

	// No token required.
	_, srv := setupTestHandler(t, "", store, es)
	defer srv.Close()

	// Don't create a session — should get 404.
	wsURL := "ws" + srv.URL[len("http"):] + "/audio/nonexistent-session"
	_, resp, err := connectWS(t, wsURL, nil)
	if err == nil {
		t.Fatal("expected connection to fail for nonexistent session")
	}
	if resp != nil && resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 status, got %d", resp.StatusCode)
	}
}

func TestMissingSessionID(t *testing.T) {
	store := session.NewStore()
	es := createSimpleEventServer(t)

	_, srv := setupTestHandler(t, "", store, es)
	defer srv.Close()

	// No session ID in path.
	wsURL := "ws" + srv.URL[len("http"):] + "/audio/"
	_, resp, err := connectWS(t, wsURL, nil)
	if err == nil {
		t.Fatal("expected connection to fail with missing session ID")
	}
	if resp != nil && resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 status, got %d", resp.StatusCode)
	}
}

func TestConnectDisconnect_EmitsEvents(t *testing.T) {
	store := session.NewStore()
	es, _, mc := createTestEventServer(t)

	_, srv := setupTestHandler(t, "", store, es)
	defer srv.Close()

	sess := session.NewSession("evt-session", session.ProviderLeg{
		Type: session.ProviderLegWebSocket,
	}, session.Options{})
	_ = store.Create(sess)

	wsURL := "ws" + srv.URL[len("http"):] + "/audio/evt-session"
	conn, _, err := connectWS(t, wsURL, nil)
	if err != nil {
		t.Fatalf("connection failed: %v", err)
	}

	// Wait for provider_connected event.
	waitFor(t, 1*time.Second, func() bool { return mc.count() >= 1 })

	// Close the connection — should trigger provider_disconnected.
	conn.Close()

	// Wait for provider_disconnected event.
	waitFor(t, 1*time.Second, func() bool { return mc.count() >= 2 })

	msgs := mc.getAll()
	if len(msgs) < 2 {
		t.Fatalf("expected at least 2 events, got %d", len(msgs))
	}

	// Check provider_connected event.
	var evt1 events.Event
	if err := json.Unmarshal(msgs[0], &evt1); err != nil {
		t.Fatalf("unmarshal event 0: %v", err)
	}
	if evt1.Type != "session_event" {
		t.Errorf("expected type session_event, got %s", evt1.Type)
	}
	if evt1.SessionID != "evt-session" {
		t.Errorf("expected sessionId evt-session, got %s", evt1.SessionID)
	}
	if evt1.EventName != "provider_connected" {
		t.Errorf("expected event provider_connected, got %s", evt1.EventName)
	}

	// Check provider_disconnected event.
	var evt2 events.Event
	if err := json.Unmarshal(msgs[1], &evt2); err != nil {
		t.Fatalf("unmarshal event 1: %v", err)
	}
	if evt2.EventName != "provider_disconnected" {
		t.Errorf("expected event provider_disconnected, got %s", evt2.EventName)
	}
	if evt2.Reason != "ws_closed" {
		t.Errorf("expected reason ws_closed, got %s", evt2.Reason)
	}
}

func TestBidirectionalAudio(t *testing.T) {
	store := session.NewStore()
	es, _, _ := createTestEventServer(t)

	h, srv := setupTestHandler(t, "", store, es)
	defer srv.Close()

	sess := session.NewSession("audio-session", session.ProviderLeg{
		Type: session.ProviderLegWebSocket,
	}, session.Options{})
	_ = store.Create(sess)

	wsURL := "ws" + srv.URL[len("http"):] + "/audio/audio-session"
	conn, _, err := connectWS(t, wsURL, nil)
	if err != nil {
		t.Fatalf("connection failed: %v", err)
	}
	defer conn.Close()

	// Wait for connection to be tracked.
	waitFor(t, 500*time.Millisecond, func() bool { return h.IsConnected("audio-session") })

	// Provider sends audio frame to MediaBridge.
	testFrame := []byte{0x01, 0x02, 0x03, 0x04}
	err = conn.WriteMessage(websocket.BinaryMessage, testFrame)
	if err != nil {
		t.Fatalf("failed to send audio frame: %v", err)
	}

	// MediaBridge sends audio frame to provider.
	outFrame := []byte{0x0A, 0x0B, 0x0C, 0x0D}
	err = h.SendAudioFrame("audio-session", outFrame)
	if err != nil {
		t.Fatalf("failed to send audio frame to provider: %v", err)
	}

	// Read the frame on the client side.
	conn.SetReadDeadline(time.Now().Add(1 * time.Second))
	msgType, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("failed to read audio frame: %v", err)
	}
	if msgType != websocket.BinaryMessage {
		t.Errorf("expected binary message, got %d", msgType)
	}
	if len(data) != 4 || data[0] != 0x0A || data[3] != 0x0D {
		t.Errorf("unexpected audio data: %v", data)
	}
}

func TestSendAudioFrame_NoConnection(t *testing.T) {
	store := session.NewStore()
	es := createSimpleEventServer(t)

	h, srv := setupTestHandler(t, "", store, es)
	defer srv.Close()

	// Try to send audio to a session with no connected provider.
	err := h.SendAudioFrame("no-such-session", []byte{0x01})
	if err == nil {
		t.Fatal("expected error when sending to non-connected session")
	}
}

func TestGracefulShutdown(t *testing.T) {
	store := session.NewStore()
	es, _, _ := createTestEventServer(t)

	h, srv := setupTestHandler(t, "", store, es)
	defer srv.Close()

	sess := session.NewSession("shutdown-session", session.ProviderLeg{
		Type: session.ProviderLegWebSocket,
	}, session.Options{})
	_ = store.Create(sess)

	wsURL := "ws" + srv.URL[len("http"):] + "/audio/shutdown-session"
	conn, _, err := connectWS(t, wsURL, nil)
	if err != nil {
		t.Fatalf("connection failed: %v", err)
	}

	// Wait for connection to be tracked.
	waitFor(t, 500*time.Millisecond, func() bool { return h.IsConnected("shutdown-session") })

	// Initiate graceful shutdown.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err = h.Shutdown(ctx)
	if err != nil {
		t.Fatalf("shutdown failed: %v", err)
	}

	// The connection should be closed.
	if h.IsConnected("shutdown-session") {
		t.Error("expected connection to be closed after shutdown")
	}

	// Client should detect the close.
	conn.SetReadDeadline(time.Now().Add(1 * time.Second))
	_, _, readErr := conn.ReadMessage()
	if readErr == nil {
		t.Error("expected read error after server shutdown")
	}
}
