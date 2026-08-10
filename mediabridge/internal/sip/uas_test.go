package sip

import (
	"log/slog"
	"net"
	"os"
	"sync"
	"testing"
	"time"
)

// testEventCollector collects UAS events for assertions.
type testEventCollector struct {
	mu     sync.Mutex
	events []UASEvent
}

func (c *testEventCollector) callback(evt UASEvent) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, evt)
}

func (c *testEventCollector) get() []UASEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	cp := make([]UASEvent, len(c.events))
	copy(cp, c.events)
	return cp
}

func (c *testEventCollector) waitFor(t *testing.T, count int, timeout time.Duration) []UASEvent {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		evts := c.get()
		if len(evts) >= count {
			return evts
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d events, got %d", count, len(c.get()))
	return nil
}

func setupTestUAS(t *testing.T, validSessions []string) (*UAS, *testEventCollector, int) {
	t.Helper()

	// Find a free port.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to find free port: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	// Wait a moment for port release.
	time.Sleep(50 * time.Millisecond)

	collector := &testEventCollector{}
	lookup := func(sessionID string) bool {
		for _, s := range validSessions {
			if s == sessionID {
				return true
			}
		}
		return false
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))

	uas := NewUAS(UASConfig{
		Port:      port,
		MediaPort: port + 2,
		PublicIP:  "127.0.0.1",
	}, lookup, collector.callback, logger)

	if err := uas.Start(); err != nil {
		t.Fatalf("UAS start failed: %v", err)
	}

	return uas, collector, port
}

func TestUAS_InviteAccepted(t *testing.T) {
	uas, collector, port := setupTestUAS(t, []string{"session-abc"})
	defer uas.Shutdown(nil)

	// Build a SIP INVITE with SDP.
	sdpBody := "v=0\r\n" +
		"o=- 0 0 IN IP4 10.0.0.1\r\n" +
		"s=-\r\n" +
		"c=IN IP4 10.0.0.1\r\n" +
		"t=0 0\r\n" +
		"m=audio 4000 RTP/AVP 0\r\n" +
		"a=rtpmap:0 PCMU/8000\r\n" +
		"a=sendrecv\r\n"

	invite := buildTestINVITE("session-abc", "127.0.0.1", port, sdpBody)

	// Send via UDP.
	conn, err := net.Dial("udp", net.JoinHostPort("127.0.0.1", itoa(port)))
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	defer conn.Close()

	_, err = conn.Write(invite)
	if err != nil {
		t.Fatalf("write failed: %v", err)
	}

	// Read response(s).
	buf := make([]byte, 65535)
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))

	var responses []string
	for {
		n, err := conn.Read(buf)
		if err != nil {
			break
		}
		responses = append(responses, string(buf[:n]))
	}

	// Should have received 100 Trying + 200 OK.
	if len(responses) < 2 {
		t.Fatalf("expected at least 2 responses, got %d", len(responses))
	}

	// First should be 100 Trying.
	if !containsHelper(responses[0], "100 Trying") {
		t.Errorf("first response should be 100 Trying, got: %s", responses[0][:min(80, len(responses[0]))])
	}

	// Second should be 200 OK with SDP.
	if !containsHelper(responses[1], "200 OK") {
		t.Errorf("second response should be 200 OK, got: %s", responses[1][:min(80, len(responses[1]))])
	}
	if !containsHelper(responses[1], "application/sdp") {
		t.Error("200 OK should contain SDP body")
	}
	if !containsHelper(responses[1], "m=audio") {
		t.Error("200 OK SDP should contain media line")
	}

	// Check event was emitted.
	events := collector.waitFor(t, 1, 2*time.Second)
	if events[0].Type != EventProviderConnected {
		t.Errorf("expected provider_connected event, got %s", events[0].Type)
	}
	if events[0].SessionID != "session-abc" {
		t.Errorf("expected session-abc, got %s", events[0].SessionID)
	}
	if events[0].Codec == nil || events[0].Codec.Name != "PCMU" {
		t.Error("expected PCMU codec in event")
	}
}

func TestUAS_InviteUnknownSession(t *testing.T) {
	uas, _, port := setupTestUAS(t, []string{"session-known"})
	defer uas.Shutdown(nil)

	sdpBody := "v=0\r\no=- 0 0 IN IP4 10.0.0.1\r\ns=-\r\nc=IN IP4 10.0.0.1\r\nt=0 0\r\nm=audio 4000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n"
	invite := buildTestINVITE("session-unknown", "127.0.0.1", port, sdpBody)

	conn, err := net.Dial("udp", net.JoinHostPort("127.0.0.1", itoa(port)))
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	defer conn.Close()

	conn.Write(invite)

	buf := make([]byte, 65535)
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatal("expected response")
	}

	resp := string(buf[:n])
	if !containsHelper(resp, "404 Not Found") {
		t.Errorf("expected 404 for unknown session, got: %s", resp[:min(80, len(resp))])
	}
}

func TestUAS_ByeEmitsDisconnect(t *testing.T) {
	uas, collector, port := setupTestUAS(t, []string{"session-bye"})
	defer uas.Shutdown(nil)

	// First, send INVITE to establish dialog.
	sdpBody := "v=0\r\no=- 0 0 IN IP4 10.0.0.1\r\ns=-\r\nc=IN IP4 10.0.0.1\r\nt=0 0\r\nm=audio 4000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n"
	invite := buildTestINVITE("session-bye", "127.0.0.1", port, sdpBody)

	conn, err := net.Dial("udp", net.JoinHostPort("127.0.0.1", itoa(port)))
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	defer conn.Close()

	conn.Write(invite)

	// Read 100 + 200.
	buf := make([]byte, 65535)
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	conn.Read(buf) // 100 Trying
	conn.Read(buf) // 200 OK

	// Wait for provider_connected event.
	collector.waitFor(t, 1, 2*time.Second)

	// Now send BYE with matching Call-ID.
	bye := buildTestBYE("session-bye", "127.0.0.1", port, "call-test-session-bye@10.0.0.1")
	conn.Write(bye)

	// Read 200 OK for BYE.
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatal("expected 200 OK for BYE")
	}
	resp := string(buf[:n])
	if !containsHelper(resp, "200 OK") {
		t.Errorf("expected 200 OK for BYE, got: %s", resp[:min(80, len(resp))])
	}

	// Check disconnect event.
	events := collector.waitFor(t, 2, 2*time.Second)
	if events[1].Type != EventProviderDisconnected {
		t.Errorf("expected provider_disconnected event, got %s", events[1].Type)
	}
	if events[1].Reason != "bye" {
		t.Errorf("expected reason 'bye', got %s", events[1].Reason)
	}
}

func TestUAS_SendBye(t *testing.T) {
	uas, _, port := setupTestUAS(t, []string{"session-sendb"})
	defer uas.Shutdown(nil)

	// Establish dialog.
	sdpBody := "v=0\r\no=- 0 0 IN IP4 10.0.0.1\r\ns=-\r\nc=IN IP4 10.0.0.1\r\nt=0 0\r\nm=audio 4000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n"
	invite := buildTestINVITE("session-sendb", "127.0.0.1", port, sdpBody)

	conn, err := net.Dial("udp", net.JoinHostPort("127.0.0.1", itoa(port)))
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	defer conn.Close()

	conn.Write(invite)

	// Read responses.
	buf := make([]byte, 65535)
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	conn.Read(buf) // 100
	conn.Read(buf) // 200

	time.Sleep(100 * time.Millisecond)

	// Send BYE from our side.
	err = uas.SendBye("session-sendb")
	if err != nil {
		t.Fatalf("SendBye failed: %v", err)
	}

	// Read the BYE request that was sent.
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatal("expected BYE from UAS")
	}
	msg := string(buf[:n])
	if !containsHelper(msg, "BYE") {
		t.Errorf("expected BYE request, got: %s", msg[:min(80, len(msg))])
	}
}

func TestUAS_IPAllowlist(t *testing.T) {
	// Set up UAS with a restrictive allowlist.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	time.Sleep(50 * time.Millisecond)

	collector := &testEventCollector{}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))

	// Only allow 10.0.0.1, which is NOT the loopback we'll send from.
	uas := NewUAS(UASConfig{
		Port:       port,
		MediaPort:  port + 2,
		PublicIP:   "127.0.0.1",
		AllowedIPs: []string{"10.0.0.1"},
	}, func(string) bool { return true }, collector.callback, logger)

	if err := uas.Start(); err != nil {
		t.Fatalf("UAS start failed: %v", err)
	}
	defer uas.Shutdown(nil)

	// Send INVITE from 127.0.0.1 (not allowed).
	sdpBody := "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio 4000 RTP/AVP 0\r\n"
	invite := buildTestINVITE("session-x", "127.0.0.1", port, sdpBody)

	conn, err := net.Dial("udp", net.JoinHostPort("127.0.0.1", itoa(port)))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	conn.Write(invite)

	// Should get no response (message dropped silently).
	buf := make([]byte, 65535)
	conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	_, err = conn.Read(buf)
	if err == nil {
		t.Error("expected no response for blocked IP")
	}

	// No events should be emitted.
	time.Sleep(100 * time.Millisecond)
	if len(collector.get()) > 0 {
		t.Error("no events expected for blocked IP")
	}
}

// -- Helper functions --

func buildTestINVITE(sessionID, host string, port int, sdpBody string) []byte {
	msg := "INVITE sip:" + sessionID + "@" + host + ":" + itoa(port) + " SIP/2.0\r\n" +
		"Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK" + sessionID + "\r\n" +
		"From: <sip:provider@10.0.0.1>;tag=from-" + sessionID + "\r\n" +
		"To: <sip:" + sessionID + "@" + host + ">\r\n" +
		"Call-ID: call-test-" + sessionID + "@10.0.0.1\r\n" +
		"CSeq: 1 INVITE\r\n" +
		"Contact: <sip:provider@10.0.0.1:5060>\r\n" +
		"Content-Type: application/sdp\r\n" +
		"Content-Length: " + itoa(len(sdpBody)) + "\r\n" +
		"\r\n" +
		sdpBody
	return []byte(msg)
}

func buildTestBYE(sessionID, host string, port int, callID string) []byte {
	msg := "BYE sip:" + sessionID + "@" + host + ":" + itoa(port) + " SIP/2.0\r\n" +
		"Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bKbye-" + sessionID + "\r\n" +
		"From: <sip:provider@10.0.0.1>;tag=from-" + sessionID + "\r\n" +
		"To: <sip:" + sessionID + "@" + host + ">;tag=mb-totag\r\n" +
		"Call-ID: " + callID + "\r\n" +
		"CSeq: 2 BYE\r\n" +
		"Content-Length: 0\r\n" +
		"\r\n"
	return []byte(msg)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
