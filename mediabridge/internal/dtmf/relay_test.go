package dtmf

import (
	"log/slog"
	"os"
	"sync"
	"testing"
)

// mockSIPSender records telephone-event payloads sent to the SIP leg.
type mockSIPSender struct {
	mu       sync.Mutex
	payloads [][]byte
	err      error
}

func (m *mockSIPSender) SendTelephoneEvent(payload []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.err != nil {
		return m.err
	}
	cp := make([]byte, len(payload))
	copy(cp, payload)
	m.payloads = append(m.payloads, cp)
	return nil
}

func (m *mockSIPSender) getPayloads() [][]byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.payloads
}

// mockEventEmitter records DTMF events emitted to the Server.
type mockEventEmitter struct {
	mu     sync.Mutex
	events []emittedDTMF
}

type emittedDTMF struct {
	sessionID string
	digit     string
}

func (m *mockEventEmitter) EmitDTMF(sessionID, digit string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.events = append(m.events, emittedDTMF{sessionID: sessionID, digit: digit})
}

func (m *mockEventEmitter) getEvents() []emittedDTMF {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.events
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
}

func TestRelay_OutboundDTMF_RelayToSIP(t *testing.T) {
	sender := &mockSIPSender{}
	emitter := &mockEventEmitter{}

	relay := NewRelay(RelayConfig{
		SessionID:    "session-123",
		SIPSender:    sender,
		EventEmitter: emitter,
		Logger:       testLogger(),
	})

	// Simulate WebRTC leg sending DTMF digit '5'.
	payload1 := EncodePayload(Event{EventCode: 5, End: false, Volume: 10, Duration: 160})
	payload2 := EncodePayload(Event{EventCode: 5, End: false, Volume: 10, Duration: 320})
	payload3 := EncodePayload(Event{EventCode: 5, End: true, Volume: 10, Duration: 480})

	relay.HandleWebRTCPacket(payload1)
	relay.HandleWebRTCPacket(payload2)
	relay.HandleWebRTCPacket(payload3)

	// All packets should be relayed to SIP sender (in-band relay).
	payloads := sender.getPayloads()
	if len(payloads) != 3 {
		t.Fatalf("expected 3 payloads relayed to SIP, got %d", len(payloads))
	}

	// Verify the payloads are correct copies.
	for i, p := range payloads {
		if len(p) != PayloadSize {
			t.Errorf("payload[%d]: expected %d bytes, got %d", i, PayloadSize, len(p))
		}
	}

	// No events should be emitted to server (outbound doesn't emit).
	events := emitter.getEvents()
	if len(events) != 0 {
		t.Errorf("expected no emitted events for outbound DTMF, got %d", len(events))
	}
}

func TestRelay_InboundDTMF_EmitToServer(t *testing.T) {
	sender := &mockSIPSender{}
	emitter := &mockEventEmitter{}

	relay := NewRelay(RelayConfig{
		SessionID:    "session-456",
		SIPSender:    sender,
		EventEmitter: emitter,
		Logger:       testLogger(),
	})

	// Simulate SIP leg sending DTMF digit '#'.
	relay.HandleSIPPacket(EncodePayload(Event{EventCode: 11, End: false, Volume: 10, Duration: 160}))
	relay.HandleSIPPacket(EncodePayload(Event{EventCode: 11, End: true, Volume: 10, Duration: 320}))

	// Should emit a DTMF event to the server.
	events := emitter.getEvents()
	if len(events) != 1 {
		t.Fatalf("expected 1 emitted event, got %d", len(events))
	}
	if events[0].sessionID != "session-456" {
		t.Errorf("sessionID: got %q, want %q", events[0].sessionID, "session-456")
	}
	if events[0].digit != "#" {
		t.Errorf("digit: got %q, want %q", events[0].digit, "#")
	}

	// Nothing should be sent to SIP (inbound doesn't relay to SIP).
	payloads := sender.getPayloads()
	if len(payloads) != 0 {
		t.Errorf("expected no SIP payloads for inbound DTMF, got %d", len(payloads))
	}
}

func TestRelay_InboundDTMF_MultipleDigits(t *testing.T) {
	emitter := &mockEventEmitter{}

	relay := NewRelay(RelayConfig{
		SessionID:    "session-789",
		SIPSender:    &mockSIPSender{},
		EventEmitter: emitter,
		Logger:       testLogger(),
	})

	// Simulate dialing "1234" from SIP leg.
	digits := []uint8{1, 2, 3, 4}
	for _, code := range digits {
		relay.HandleSIPPacket(EncodePayload(Event{EventCode: code, End: false, Volume: 10, Duration: 160}))
		relay.HandleSIPPacket(EncodePayload(Event{EventCode: code, End: true, Volume: 10, Duration: 320}))
	}

	events := emitter.getEvents()
	if len(events) != 4 {
		t.Fatalf("expected 4 events, got %d", len(events))
	}

	expected := []string{"1", "2", "3", "4"}
	for i, e := range events {
		if e.digit != expected[i] {
			t.Errorf("event[%d]: got digit %q, want %q", i, e.digit, expected[i])
		}
	}
}

func TestRelay_Stop_PreventsProcessing(t *testing.T) {
	sender := &mockSIPSender{}
	emitter := &mockEventEmitter{}

	relay := NewRelay(RelayConfig{
		SessionID:    "session-stop",
		SIPSender:    sender,
		EventEmitter: emitter,
		Logger:       testLogger(),
	})

	relay.Stop()

	// After stop, packets should be ignored.
	relay.HandleWebRTCPacket(EncodePayload(Event{EventCode: 5, End: true, Volume: 10, Duration: 320}))
	relay.HandleSIPPacket(EncodePayload(Event{EventCode: 5, End: true, Volume: 10, Duration: 320}))

	if len(sender.getPayloads()) != 0 {
		t.Errorf("expected no SIP payloads after stop")
	}
	if len(emitter.getEvents()) != 0 {
		t.Errorf("expected no events after stop")
	}
}

func TestRelay_NilSIPSender(t *testing.T) {
	emitter := &mockEventEmitter{}

	relay := NewRelay(RelayConfig{
		SessionID:    "session-nil",
		SIPSender:    nil,
		EventEmitter: emitter,
		Logger:       testLogger(),
	})

	// Should not panic with nil SIP sender.
	relay.HandleWebRTCPacket(EncodePayload(Event{EventCode: 5, End: false, Volume: 10, Duration: 160}))
	relay.HandleWebRTCPacket(EncodePayload(Event{EventCode: 5, End: true, Volume: 10, Duration: 320}))
}

func TestRelay_NilEventEmitter(t *testing.T) {
	sender := &mockSIPSender{}

	relay := NewRelay(RelayConfig{
		SessionID:    "session-nil-emitter",
		SIPSender:    sender,
		EventEmitter: nil,
		Logger:       testLogger(),
	})

	// Should not panic with nil event emitter.
	relay.HandleSIPPacket(EncodePayload(Event{EventCode: 3, End: false, Volume: 10, Duration: 160}))
	relay.HandleSIPPacket(EncodePayload(Event{EventCode: 3, End: true, Volume: 10, Duration: 320}))
}
