package main

import (
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/packetmoose/svarla/modem-gateway/internal/buffer"
	"github.com/packetmoose/svarla/modem-gateway/internal/signaling"
	"github.com/packetmoose/svarla/modem-gateway/internal/sms"
)

// fakeSender records sent messages and reports a configurable connection state.
type fakeSender struct {
	mu        sync.Mutex
	connected bool
	sent      []signaling.Message
	failNext  bool
}

func (f *fakeSender) Send(msg signaling.Message) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failNext {
		f.failNext = false
		return errDelivery("send failed")
	}
	f.sent = append(f.sent, msg)
	return nil
}

func (f *fakeSender) IsConnected() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.connected
}

func (f *fakeSender) setConnected(v bool) {
	f.mu.Lock()
	f.connected = v
	f.mu.Unlock()
}

func (f *fakeSender) sentCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

func newTestBuffer(t *testing.T) *buffer.PersistentBuffer[sms.IncomingSMS] {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sms-buffer.jsonl")
	buf, err := buffer.NewKeyed[sms.IncomingSMS](path, 100, func(m sms.IncomingSMS) string { return m.MessageID })
	if err != nil {
		t.Fatalf("failed to create buffer: %v", err)
	}
	return buf
}

func msg(id string) sms.IncomingSMS {
	return sms.IncomingSMS{MessageID: id, From: "+1", Body: "hi", Timestamp: time.Unix(1, 0)}
}

func TestPersist_KeepsInBufferUntilAck(t *testing.T) {
	buf := newTestBuffer(t)
	sender := &fakeSender{connected: true}
	d := NewSMSDelivery(buf, sender)

	if err := d.Persist(msg("m1")); err != nil {
		t.Fatalf("persist failed: %v", err)
	}

	// Persist alone must durably store the message even before any send.
	if buf.Len() != 1 {
		t.Fatalf("expected message buffered, got %d", buf.Len())
	}

	// After a flush the message is sent but still retained (no ack yet).
	d.flush()
	if sender.sentCount() != 1 {
		t.Fatalf("expected 1 sent message, got %d", sender.sentCount())
	}
	if buf.Len() != 1 {
		t.Fatalf("message must remain buffered until acked, got %d", buf.Len())
	}

	// Ack removes it.
	d.HandleAck("m1")
	if buf.Len() != 0 {
		t.Fatalf("expected buffer empty after ack, got %d", buf.Len())
	}
}

func TestFlush_NoopWhenDisconnected(t *testing.T) {
	buf := newTestBuffer(t)
	sender := &fakeSender{connected: false}
	d := NewSMSDelivery(buf, sender)

	if err := d.Persist(msg("m1")); err != nil {
		t.Fatalf("persist failed: %v", err)
	}
	d.flush()

	if sender.sentCount() != 0 {
		t.Fatalf("expected no sends while disconnected, got %d", sender.sentCount())
	}
	if buf.Len() != 1 {
		t.Fatalf("message must remain buffered while disconnected, got %d", buf.Len())
	}
}

func TestFlush_StopsOnSendFailure(t *testing.T) {
	buf := newTestBuffer(t)
	sender := &fakeSender{connected: true, failNext: true}
	d := NewSMSDelivery(buf, sender)

	if err := d.Persist(msg("m1")); err != nil {
		t.Fatalf("persist failed: %v", err)
	}
	if err := d.Persist(msg("m2")); err != nil {
		t.Fatalf("persist failed: %v", err)
	}

	d.flush() // first send fails, loop stops

	// Nothing acked, both remain buffered for retry.
	if buf.Len() != 2 {
		t.Fatalf("expected both messages retained after send failure, got %d", buf.Len())
	}

	// Next flush succeeds for both.
	d.flush()
	if sender.sentCount() != 2 {
		t.Fatalf("expected 2 sent after retry, got %d", sender.sentCount())
	}
}

func TestPersist_DuplicateSuppressed(t *testing.T) {
	buf := newTestBuffer(t)
	sender := &fakeSender{connected: true}
	d := NewSMSDelivery(buf, sender)

	_ = d.Persist(msg("dup"))
	_ = d.Persist(msg("dup"))

	if buf.Len() != 1 {
		t.Fatalf("expected duplicate persist suppressed, got %d", buf.Len())
	}
}

func TestHandleAck_UnknownIsNoop(t *testing.T) {
	buf := newTestBuffer(t)
	sender := &fakeSender{connected: true}
	d := NewSMSDelivery(buf, sender)

	_ = d.Persist(msg("m1"))
	d.HandleAck("does-not-exist")

	if buf.Len() != 1 {
		t.Fatalf("ack of unknown id must not remove anything, got %d", buf.Len())
	}
}
