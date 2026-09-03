package main

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/packetmoose/svarla/modem-gateway/internal/buffer"
	"github.com/packetmoose/svarla/modem-gateway/internal/signaling"
	"github.com/packetmoose/svarla/modem-gateway/internal/sms"
)

// retryInterval is how often the delivery pump re-attempts sending any
// buffered-but-unacknowledged SMS. Reconnects trigger an immediate attempt via
// Kick; this timer covers the case where the connection is up but an earlier
// send was dropped (e.g. write to a half-open socket) and no ack arrived.
const retryInterval = 30 * time.Second

// SMSDelivery owns the durable, at-least-once delivery of inbound SMS to the
// server. It follows a buffer-first, ack-to-remove model:
//
//   - Every received SMS is persisted to the buffer first (see Persist), before
//     the message is deleted from modem storage.
//   - A background pump repeatedly sends every buffered message to the server
//     and leaves it in the buffer.
//   - The message is removed from the buffer only when the server returns an
//     sms_ack for its messageId (see HandleAck).
//
// This guarantees a message is never dropped from the buffer before the server
// has durably accepted it, and never deleted from the modem before it is in the
// buffer. Duplicate deliveries (e.g. an ack lost in transit) are deduplicated
// server-side by messageId.
type SMSDelivery struct {
	buf    *buffer.PersistentBuffer[sms.IncomingSMS]
	sender signaling.MessageSender

	kickCh chan struct{}

	mu      sync.Mutex
	started bool
	stopCh  chan struct{}
	wg      sync.WaitGroup
}

// NewSMSDelivery creates a delivery pump over the given buffer and sender.
func NewSMSDelivery(buf *buffer.PersistentBuffer[sms.IncomingSMS], sender signaling.MessageSender) *SMSDelivery {
	return &SMSDelivery{
		buf:    buf,
		sender: sender,
		kickCh: make(chan struct{}, 1),
	}
}

// Persist durably stores an incoming SMS in the buffer and nudges the pump to
// attempt delivery. It returns an error only if persistence failed; on error
// the caller must NOT delete the message from modem storage (it will be
// retried). A duplicate messageId is suppressed by the buffer and treated as a
// successful persist.
func (d *SMSDelivery) Persist(msg sms.IncomingSMS) error {
	if d.buf == nil {
		// No buffer configured; fall back to a best-effort direct send so the
		// message is not silently dropped. Without a buffer we cannot guarantee
		// durability, but this path should not occur in normal operation.
		return d.sendOne(msg)
	}
	if err := d.buf.Push(msg); err != nil {
		return err
	}
	d.Kick()
	return nil
}

// HandleAck removes an acknowledged message from the buffer by messageId. It is
// safe to call for an unknown id (no-op).
func (d *SMSDelivery) HandleAck(messageID string) {
	if d.buf == nil || messageID == "" {
		return
	}
	if err := d.buf.Remove(messageID); err != nil {
		log.Printf("sms-delivery: failed to remove acked message %s from buffer: %v", messageID, err)
		return
	}
	log.Printf("sms-delivery: server acked message %s; removed from buffer", messageID)
}

// Kick nudges the pump to attempt delivery immediately (e.g. after reconnect or
// a new message). Non-blocking; coalesces multiple kicks.
func (d *SMSDelivery) Kick() {
	select {
	case d.kickCh <- struct{}{}:
	default:
	}
}

// Start launches the background delivery pump. It is idempotent.
func (d *SMSDelivery) Start(ctx context.Context) {
	d.mu.Lock()
	if d.started {
		d.mu.Unlock()
		return
	}
	d.started = true
	d.stopCh = make(chan struct{})
	d.wg.Add(1)
	d.mu.Unlock()

	go d.loop(ctx)
}

// Stop halts the delivery pump and waits for it to exit. Buffered messages are
// left on disk for the next run; nothing is dropped.
func (d *SMSDelivery) Stop() {
	d.mu.Lock()
	if !d.started {
		d.mu.Unlock()
		return
	}
	d.started = false
	close(d.stopCh)
	d.mu.Unlock()

	d.wg.Wait()
}

func (d *SMSDelivery) loop(ctx context.Context) {
	defer d.wg.Done()

	ticker := time.NewTicker(retryInterval)
	defer ticker.Stop()

	d.mu.Lock()
	stopCh := d.stopCh
	d.mu.Unlock()

	// Attempt an initial flush in case the buffer already holds messages from a
	// previous run.
	d.flush()

	for {
		select {
		case <-ctx.Done():
			return
		case <-stopCh:
			return
		case <-d.kickCh:
			d.flush()
		case <-ticker.C:
			d.flush()
		}
	}
}

// flush sends every buffered message to the server, leaving each in the buffer
// until an sms_ack removes it. Messages are sent oldest-first. If the sender is
// not connected or a send fails, flush stops early and relies on the next kick
// or tick to retry.
func (d *SMSDelivery) flush() {
	if d.buf == nil {
		return
	}
	if !d.sender.IsConnected() {
		return
	}

	for _, msg := range d.buf.Snapshot() {
		if !d.sender.IsConnected() {
			return
		}
		if err := d.sendOne(msg); err != nil {
			log.Printf("sms-delivery: send failed for %s, will retry: %v", msg.MessageID, err)
			return
		}
	}
}

// sendOne sends a single incoming SMS as an incoming_sms message. It does not
// remove the message from the buffer; removal happens only on ack.
func (d *SMSDelivery) sendOne(msg sms.IncomingSMS) error {
	payload := struct {
		Type      string `json:"type"`
		MessageID string `json:"messageId"`
		From      string `json:"from"`
		To        string `json:"to"`
		Body      string `json:"body"`
		Timestamp int64  `json:"timestamp"`
	}{
		Type:      signaling.TypeIncomingSMS,
		MessageID: msg.MessageID,
		From:      msg.From,
		To:        msg.To,
		Body:      msg.Body,
		Timestamp: msg.Timestamp.UnixMilli(),
	}
	m, err := signaling.NewMessage(signaling.TypeIncomingSMS, payload)
	if err != nil {
		return err
	}
	return d.sender.Send(m)
}
