package events

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// testLogger returns a silent logger for tests.
func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(&discardWriter{}, nil))
}

type discardWriter struct{}

func (d *discardWriter) Write(p []byte) (n int, err error) { return len(p), nil }

// messageCollector reads messages from a WebSocket connection in the background.
type messageCollector struct {
	mu       sync.Mutex
	messages [][]byte
	conn     *websocket.Conn
	done     chan struct{}
}

func newMessageCollector(conn *websocket.Conn) *messageCollector {
	mc := &messageCollector{
		conn: conn,
		done: make(chan struct{}),
	}
	go mc.readLoop()
	return mc
}

func (mc *messageCollector) readLoop() {
	defer close(mc.done)
	for {
		_, msg, err := mc.conn.ReadMessage()
		if err != nil {
			return
		}
		mc.mu.Lock()
		mc.messages = append(mc.messages, msg)
		mc.mu.Unlock()
	}
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

func (mc *messageCollector) close() {
	mc.conn.Close()
	<-mc.done
}

// createTestServer creates an events.Server, hosts it on an httptest.Server,
// and connects a collector client to it. Returns the server, collector, and cleanup func.
func createTestServer(t *testing.T, cfg ServerConfig) (*Server, *httptest.Server, *messageCollector) {
	t.Helper()

	s := NewServer(cfg, func() (int, int) { return 0, 0 }, testLogger())
	s.Start()

	mux := http.NewServeMux()
	mux.Handle("/events", s)
	srv := httptest.NewServer(mux)

	// Connect a collector client.
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/events"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("failed to connect collector: %v", err)
	}

	mc := newMessageCollector(conn)

	// Wait for the server to register the connection.
	waitFor(t, 500*time.Millisecond, func() bool { return s.IsConnected() })

	t.Cleanup(func() {
		mc.close()
		s.Shutdown()
		srv.Close()
	})

	return s, srv, mc
}

// --- Tests ---

func TestEventSerialization_SessionEvent(t *testing.T) {
	evt := Event{
		Type:      "session_event",
		SessionID: "sess-123",
		EventName: "client_connected",
	}

	data, err := json.Marshal(evt)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if result["type"] != "session_event" {
		t.Errorf("expected type session_event, got %v", result["type"])
	}
	if result["sessionId"] != "sess-123" {
		t.Errorf("expected sessionId sess-123, got %v", result["sessionId"])
	}
	if result["event"] != "client_connected" {
		t.Errorf("expected event client_connected, got %v", result["event"])
	}
	// Reason should be omitted (empty)
	if _, exists := result["reason"]; exists {
		t.Error("reason should be omitted when empty")
	}
}

func TestEventSerialization_SessionEventWithReason(t *testing.T) {
	evt := Event{
		Type:      "session_event",
		SessionID: "sess-456",
		EventName: "client_disconnected",
		Reason:    "ice_failed",
	}

	data, err := json.Marshal(evt)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if result["type"] != "session_event" {
		t.Errorf("expected type session_event, got %v", result["type"])
	}
	if result["event"] != "client_disconnected" {
		t.Errorf("expected event client_disconnected, got %v", result["event"])
	}
	if result["reason"] != "ice_failed" {
		t.Errorf("expected reason ice_failed, got %v", result["reason"])
	}
}

func TestEventSerialization_DTMFEvent(t *testing.T) {
	evt := Event{
		Type:      "session_event",
		SessionID: "sess-789",
		EventName: "dtmf",
		Digit:     "5",
	}

	data, err := json.Marshal(evt)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if result["event"] != "dtmf" {
		t.Errorf("expected event dtmf, got %v", result["event"])
	}
	if result["digit"] != "5" {
		t.Errorf("expected digit 5, got %v", result["digit"])
	}
}

func TestEventSerialization_HealthEvent(t *testing.T) {
	activeSessions := 3
	uptime := 7200
	evt := Event{
		Type:           "health",
		ActiveSessions: &activeSessions,
		Uptime:         &uptime,
	}

	data, err := json.Marshal(evt)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if result["type"] != "health" {
		t.Errorf("expected type health, got %v", result["type"])
	}
	if int(result["activeSessions"].(float64)) != 3 {
		t.Errorf("expected activeSessions 3, got %v", result["activeSessions"])
	}
	if int(result["uptime"].(float64)) != 7200 {
		t.Errorf("expected uptime 7200, got %v", result["uptime"])
	}
	// Session fields should be omitted
	if _, exists := result["sessionId"]; exists {
		t.Error("sessionId should be omitted in health event")
	}
}

func TestServer_AcceptsConnectionAndSendsEvents(t *testing.T) {
	s, _, mc := createTestServer(t, ServerConfig{
		BufferSize:     10,
		HealthInterval: 1 * time.Hour,
	})

	// Emit events.
	s.EmitSessionEvent("s1", "client_connected", "")
	s.EmitSessionEvent("s1", "provider_disconnected", "bye")
	s.EmitDTMF("s1", "9")

	// Wait for messages to arrive.
	waitFor(t, 500*time.Millisecond, func() bool { return mc.count() >= 3 })

	msgs := mc.getAll()
	if len(msgs) < 3 {
		t.Fatalf("expected at least 3 messages, got %d", len(msgs))
	}

	// Verify first message.
	var evt1 Event
	if err := json.Unmarshal(msgs[0], &evt1); err != nil {
		t.Fatalf("unmarshal msg 0: %v", err)
	}
	if evt1.Type != "session_event" || evt1.EventName != "client_connected" {
		t.Errorf("unexpected first event: %+v", evt1)
	}

	// Verify second message has reason.
	var evt2 Event
	if err := json.Unmarshal(msgs[1], &evt2); err != nil {
		t.Fatalf("unmarshal msg 1: %v", err)
	}
	if evt2.Reason != "bye" {
		t.Errorf("expected reason bye, got %s", evt2.Reason)
	}

	// Verify DTMF message.
	var evt3 Event
	if err := json.Unmarshal(msgs[2], &evt3); err != nil {
		t.Fatalf("unmarshal msg 2: %v", err)
	}
	if evt3.EventName != "dtmf" || evt3.Digit != "9" {
		t.Errorf("expected dtmf 9, got %+v", evt3)
	}
}

func TestServer_ReplacesOldConnection(t *testing.T) {
	s := NewServer(ServerConfig{
		BufferSize:     10,
		HealthInterval: 1 * time.Hour,
	}, func() (int, int) { return 0, 0 }, testLogger())
	s.Start()
	defer s.Shutdown()

	mux := http.NewServeMux()
	mux.Handle("/events", s)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/events"

	// First client connects.
	conn1, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("first connect failed: %v", err)
	}
	waitFor(t, 500*time.Millisecond, func() bool { return s.IsConnected() })

	// Second client connects — should replace first.
	conn2, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("second connect failed: %v", err)
	}
	mc2 := newMessageCollector(conn2)
	defer mc2.close()

	time.Sleep(100 * time.Millisecond)

	// First client should be closed.
	conn1.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	_, _, readErr := conn1.ReadMessage()
	if readErr == nil {
		t.Error("expected first connection to be closed after replacement")
	}
	conn1.Close()

	// Second client should receive events.
	s.EmitSessionEvent("s1", "client_connected", "")
	waitFor(t, 500*time.Millisecond, func() bool { return mc2.count() >= 1 })

	if mc2.count() < 1 {
		t.Error("second client did not receive events")
	}
}

func TestServer_BufferDropsOldestWhenFull(t *testing.T) {
	s := NewServer(ServerConfig{
		BufferSize:     3,
		HealthInterval: 1 * time.Hour,
	}, func() (int, int) { return 0, 0 }, testLogger())
	s.Start()
	defer s.Shutdown()

	// Don't connect a client — events will buffer.
	s.Emit(Event{Type: "session_event", SessionID: "s1", EventName: "first"})
	s.Emit(Event{Type: "session_event", SessionID: "s2", EventName: "second"})
	s.Emit(Event{Type: "session_event", SessionID: "s3", EventName: "third"})

	// Buffer is now full (size 3). Adding one more should drop the oldest.
	s.Emit(Event{Type: "session_event", SessionID: "s4", EventName: "fourth"})

	// Drain the buffer and verify oldest was dropped.
	var events []Event
	for i := 0; i < 3; i++ {
		select {
		case evt := <-s.buffer:
			events = append(events, evt)
		default:
			break
		}
	}

	if len(events) != 3 {
		t.Fatalf("expected 3 events in buffer, got %d", len(events))
	}

	// The first event ("first") should have been dropped.
	names := make([]string, len(events))
	for i, e := range events {
		names[i] = e.EventName
	}

	// After drop-oldest logic: should have second, third, fourth
	if names[0] != "second" || names[1] != "third" || names[2] != "fourth" {
		t.Errorf("expected [second, third, fourth], got %v", names)
	}
}

func TestServer_HealthEmitter(t *testing.T) {
	healthCalls := 0
	var healthMu sync.Mutex

	s := NewServer(ServerConfig{
		BufferSize:     10,
		HealthInterval: 100 * time.Millisecond, // fast for testing
	}, func() (int, int) {
		healthMu.Lock()
		healthCalls++
		healthMu.Unlock()
		return 2, 3600
	}, testLogger())
	s.Start()
	defer s.Shutdown()

	mux := http.NewServeMux()
	mux.Handle("/events", s)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/events"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("connect failed: %v", err)
	}
	mc := newMessageCollector(conn)
	defer mc.close()

	// Wait for at least one health event.
	waitFor(t, 500*time.Millisecond, func() bool { return mc.count() >= 1 })

	msgs := mc.getAll()
	found := false
	for _, msg := range msgs {
		var evt Event
		if err := json.Unmarshal(msg, &evt); err != nil {
			continue
		}
		if evt.Type == "health" && evt.ActiveSessions != nil && *evt.ActiveSessions == 2 {
			found = true
			if evt.Uptime == nil || *evt.Uptime != 3600 {
				t.Errorf("expected uptime 3600, got %v", evt.Uptime)
			}
			break
		}
	}

	if !found {
		t.Error("did not receive a health event with activeSessions=2")
	}

	healthMu.Lock()
	if healthCalls < 1 {
		t.Error("health provider was never called")
	}
	healthMu.Unlock()
}

func TestServer_ConcurrentEmit(t *testing.T) {
	s, _, mc := createTestServer(t, ServerConfig{
		BufferSize:     200,
		HealthInterval: 1 * time.Hour,
	})

	// Spawn multiple goroutines emitting concurrently.
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for j := 0; j < 5; j++ {
				s.EmitSessionEvent("s1", "client_connected", "")
			}
		}(i)
	}
	wg.Wait()

	// Wait for all messages to be received.
	waitFor(t, 2*time.Second, func() bool { return mc.count() >= 50 })

	if mc.count() < 50 {
		t.Errorf("expected at least 50 messages from concurrent emit, got %d", mc.count())
	}
}

func TestServer_IsConnectedReportsCorrectly(t *testing.T) {
	s := NewServer(ServerConfig{
		BufferSize:     10,
		HealthInterval: 1 * time.Hour,
	}, func() (int, int) { return 0, 0 }, testLogger())
	s.Start()
	defer s.Shutdown()

	// Not connected initially.
	if s.IsConnected() {
		t.Error("expected not connected initially")
	}

	mux := http.NewServeMux()
	mux.Handle("/events", s)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/events"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("connect failed: %v", err)
	}

	waitFor(t, 500*time.Millisecond, func() bool { return s.IsConnected() })
	if !s.IsConnected() {
		t.Error("expected connected after client connects")
	}

	conn.Close()
	waitFor(t, 500*time.Millisecond, func() bool { return !s.IsConnected() })
	if s.IsConnected() {
		t.Error("expected disconnected after client closes")
	}
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
