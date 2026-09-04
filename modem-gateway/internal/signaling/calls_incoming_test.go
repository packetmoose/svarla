package signaling

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/packetmoose/svarla/modem-gateway/internal/modem"
)

// mockSender captures messages sent to Svarla for assertions.
type mockSender struct {
	mu        sync.Mutex
	connected bool
	sent      []IncomingCallPayload
}

func (m *mockSender) Send(msg Message) error {
	// Only capture incoming_call messages; ignore call_state etc.
	if msg.Type != TypeIncomingCall {
		return nil
	}
	var p IncomingCallPayload
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		return err
	}
	m.mu.Lock()
	m.sent = append(m.sent, p)
	m.mu.Unlock()
	return nil
}

func (m *mockSender) IsConnected() bool { return m.connected }

func (m *mockSender) incomingCalls() []IncomingCallPayload {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]IncomingCallPayload, len(m.sent))
	copy(out, m.sent)
	return out
}

// newTestCallManager builds a CallManager whose modem is never opened. The
// RING/CLIP reporting path under test does not touch the modem on the happy
// path (it only sends signaling messages via the mock sender).
func newTestCallManager(sender MessageSender) *CallManager {
	return &CallManager{
		mdm:          modem.New(nil),
		stateMachine: modem.NewStateMachine(),
		sigClient:    sender,
	}
}

// waitForIncoming polls until at least n incoming_call messages are captured or
// the timeout elapses.
func waitForIncoming(t *testing.T, s *mockSender, n int, timeout time.Duration) []IncomingCallPayload {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if calls := s.incomingCalls(); len(calls) >= n {
			return calls
		}
		time.Sleep(5 * time.Millisecond)
	}
	return s.incomingCalls()
}

// TestIncomingCall_RingThenClip_ReportsOnceWithNumber verifies the normal
// SIM7600 ordering (RING before +CLIP): the gateway must report the incoming
// call exactly once, and with the caller number — never an empty "anonymous"
// report followed by a correction.
func TestIncomingCall_RingThenClip_ReportsOnceWithNumber(t *testing.T) {
	sender := &mockSender{connected: true}
	cm := newTestCallManager(sender)

	// RING arrives first (no caller info yet).
	cm.handleURC(modem.URC{Prefix: "RING"})

	// +CLIP arrives shortly after with the number, well within clipWaitDelay.
	cm.handleURC(modem.URC{Prefix: "+CLIP", Data: `"+46733123456",145,,,"",0`})

	calls := waitForIncoming(t, sender, 1, clipWaitDelay+500*time.Millisecond)

	if len(calls) != 1 {
		t.Fatalf("expected exactly 1 incoming_call report, got %d: %+v", len(calls), calls)
	}
	if calls[0].From != "+46733123456" {
		t.Fatalf("expected caller number to be reported, got %q", calls[0].From)
	}
}

// TestIncomingCall_NoClip_ReportsOnceAnonymous verifies that when +CLIP never
// arrives (caller withheld their number), the call is still reported exactly
// once after the wait window, with an empty From.
func TestIncomingCall_NoClip_ReportsOnceAnonymous(t *testing.T) {
	sender := &mockSender{connected: true}
	cm := newTestCallManager(sender)

	cm.handleURC(modem.URC{Prefix: "RING"})

	calls := waitForIncoming(t, sender, 1, clipWaitDelay+500*time.Millisecond)

	if len(calls) != 1 {
		t.Fatalf("expected exactly 1 incoming_call report, got %d: %+v", len(calls), calls)
	}
	if calls[0].From != "" {
		t.Fatalf("expected empty From when no +CLIP, got %q", calls[0].From)
	}
}

// TestIncomingCall_DuplicateRing_ReportsOnce verifies that repeated RING URCs
// for the same call (the modem rings multiple times) do not produce multiple
// reports.
func TestIncomingCall_DuplicateRing_ReportsOnce(t *testing.T) {
	sender := &mockSender{connected: true}
	cm := newTestCallManager(sender)

	cm.handleURC(modem.URC{Prefix: "RING"})
	cm.handleURC(modem.URC{Prefix: "+CLIP", Data: `"+46733123456",145`})
	cm.handleURC(modem.URC{Prefix: "RING"}) // second ring
	cm.handleURC(modem.URC{Prefix: "RING"}) // third ring

	// Wait past the report window, then a little extra to catch any stray emits.
	calls := waitForIncoming(t, sender, 1, clipWaitDelay+500*time.Millisecond)
	time.Sleep(100 * time.Millisecond)
	calls = sender.incomingCalls()

	if len(calls) != 1 {
		t.Fatalf("expected exactly 1 incoming_call report for repeated RINGs, got %d: %+v", len(calls), calls)
	}
	if calls[0].From != "+46733123456" {
		t.Fatalf("expected caller number to be reported, got %q", calls[0].From)
	}
}
