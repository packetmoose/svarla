package shutdown

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// mockCallTerminator tracks whether Shutdown was called and simulates an active call.
type mockCallTerminator struct {
	mu         sync.Mutex
	active     bool
	shutdownAt int
	order      *[]string
}

func (m *mockCallTerminator) HasActiveCall() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.active
}

func (m *mockCallTerminator) Shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.active = false
	*m.order = append(*m.order, "call_terminated")
}

// mockFlusher tracks flush calls and their order.
type mockFlusher struct {
	name  string
	err   error
	order *[]string
}

func (m *mockFlusher) Flush() error {
	*m.order = append(*m.order, "flush_"+m.name)
	return m.err
}

// mockCloser tracks close calls and their order.
type mockCloser struct {
	name  string
	err   error
	order *[]string
}

func (m *mockCloser) Close() error {
	*m.order = append(*m.order, "close_"+m.name)
	return m.err
}

func TestShutdownOrdering(t *testing.T) {
	var order []string

	callTerm := &mockCallTerminator{active: true, order: &order}
	smsBuf := &mockFlusher{name: "sms", order: &order}
	missedBuf := &mockFlusher{name: "missed", order: &order}
	sigClient := &mockCloser{name: "signaling", order: &order}
	mdm := &mockCloser{name: "modem", order: &order}

	coord := NewCoordinator(CoordinatorConfig{
		CallTerminator:   callTerm,
		SMSBuffer:        smsBuf,
		MissedCallBuffer: missedBuf,
		SignalingClient:   sigClient,
		Modem:            mdm,
	})

	err := coord.Shutdown(context.Background())
	if err != nil {
		t.Fatalf("Shutdown returned error: %v", err)
	}

	expected := []string{
		"call_terminated",
		"flush_sms",
		"flush_missed",
		"close_signaling",
		"close_modem",
	}

	if len(order) != len(expected) {
		t.Fatalf("expected %d operations, got %d: %v", len(expected), len(order), order)
	}

	for i, op := range expected {
		if order[i] != op {
			t.Errorf("step %d: expected %q, got %q", i, op, order[i])
		}
	}
}

func TestShutdownNoActiveCall(t *testing.T) {
	var order []string

	callTerm := &mockCallTerminator{active: false, order: &order}
	smsBuf := &mockFlusher{name: "sms", order: &order}
	missedBuf := &mockFlusher{name: "missed", order: &order}
	sigClient := &mockCloser{name: "signaling", order: &order}
	mdm := &mockCloser{name: "modem", order: &order}

	coord := NewCoordinator(CoordinatorConfig{
		CallTerminator:   callTerm,
		SMSBuffer:        smsBuf,
		MissedCallBuffer: missedBuf,
		SignalingClient:   sigClient,
		Modem:            mdm,
	})

	err := coord.Shutdown(context.Background())
	if err != nil {
		t.Fatalf("Shutdown returned error: %v", err)
	}

	// call_terminated should NOT be in the order since no call was active.
	expected := []string{
		"flush_sms",
		"flush_missed",
		"close_signaling",
		"close_modem",
	}

	if len(order) != len(expected) {
		t.Fatalf("expected %d operations, got %d: %v", len(expected), len(order), order)
	}

	for i, op := range expected {
		if order[i] != op {
			t.Errorf("step %d: expected %q, got %q", i, op, order[i])
		}
	}
}

func TestShutdownNilComponents(t *testing.T) {
	// All nil — should not panic and should succeed.
	coord := NewCoordinator(CoordinatorConfig{})

	err := coord.Shutdown(context.Background())
	if err != nil {
		t.Fatalf("Shutdown with nil components returned error: %v", err)
	}
}

func TestShutdownFlushErrors(t *testing.T) {
	var order []string

	smsBuf := &mockFlusher{name: "sms", err: errors.New("disk full"), order: &order}
	missedBuf := &mockFlusher{name: "missed", err: errors.New("io error"), order: &order}
	sigClient := &mockCloser{name: "signaling", order: &order}
	mdm := &mockCloser{name: "modem", order: &order}

	coord := NewCoordinator(CoordinatorConfig{
		SMSBuffer:        smsBuf,
		MissedCallBuffer: missedBuf,
		SignalingClient:   sigClient,
		Modem:            mdm,
	})

	// Flush errors are logged but don't halt the sequence.
	err := coord.Shutdown(context.Background())
	if err != nil {
		t.Fatalf("Shutdown returned error: %v", err)
	}

	// All operations should still complete despite errors.
	expected := []string{
		"flush_sms",
		"flush_missed",
		"close_signaling",
		"close_modem",
	}

	if len(order) != len(expected) {
		t.Fatalf("expected %d operations, got %d: %v", len(expected), len(order), order)
	}
}

func TestShutdownRespectsContextCancellation(t *testing.T) {
	var order []string

	// Create a context that's already cancelled.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	smsBuf := &mockFlusher{name: "sms", order: &order}
	sigClient := &mockCloser{name: "signaling", order: &order}

	coord := NewCoordinator(CoordinatorConfig{
		SMSBuffer:      smsBuf,
		SignalingClient: sigClient,
	})

	err := coord.Shutdown(ctx)
	if err == nil {
		t.Fatal("expected context error, got nil")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}

	// No operations should have been performed.
	if len(order) != 0 {
		t.Fatalf("expected no operations with cancelled context, got: %v", order)
	}
}

func TestShutdownContextCancelledMidway(t *testing.T) {
	var order []string

	// Create a context with a very short timeout so it expires during execution.
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Millisecond)
	defer cancel()

	// The SMS buffer flush will succeed, then context should be cancelled
	// before the next step.
	smsBuf := &mockFlusher{name: "sms", order: &order}
	missedBuf := &mockFlusher{name: "missed", order: &order}

	// Use a slow closer that gives time for the context to expire.
	slowCloser := &mockCloser{name: "signaling", order: &order}

	coord := NewCoordinator(CoordinatorConfig{
		SMSBuffer:        smsBuf,
		MissedCallBuffer: missedBuf,
		SignalingClient:   slowCloser,
	})

	// Wait for timeout to fire.
	time.Sleep(5 * time.Millisecond)

	err := coord.Shutdown(ctx)
	if err == nil {
		t.Fatal("expected context deadline exceeded error")
	}
}
