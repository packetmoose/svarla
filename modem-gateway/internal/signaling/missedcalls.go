package signaling

import (
	"fmt"
	"log"
	"time"

	"github.com/packetmoose/svarla/modem-gateway/internal/buffer"
)

// MissedCall represents a call that was received while the signaling WebSocket
// was disconnected. The call is rejected (ATH) and the caller info is stored.
type MissedCall struct {
	From      string `json:"from"`
	Timestamp int64  `json:"timestamp"`
}

// MissedCallsPayload is the message sent to Svarla containing buffered missed calls.
type MissedCallsPayload struct {
	Type  string       `json:"type"`
	Calls []MissedCall `json:"calls"`
}

// MissedCallBuffer stores missed calls during signaling disconnections and
// delivers them when the connection is restored. It uses the generic
// PersistentBuffer from the buffer package for disk-backed storage.
type MissedCallBuffer struct {
	buf *buffer.PersistentBuffer[MissedCall]
}

// NewMissedCallBuffer creates a MissedCallBuffer backed by a JSON Lines file
// at bufferPath. The buffer shares the same capacity (1000) as the SMS buffer.
func NewMissedCallBuffer(bufferPath string) (*MissedCallBuffer, error) {
	buf, err := buffer.New[MissedCall](bufferPath, buffer.DefaultCapacity)
	if err != nil {
		return nil, fmt.Errorf("missed calls: failed to create buffer: %w", err)
	}
	return &MissedCallBuffer{buf: buf}, nil
}

// Add records a missed call with the given caller number and the current timestamp.
func (m *MissedCallBuffer) Add(from string) error {
	entry := MissedCall{
		From:      from,
		Timestamp: time.Now().Unix(),
	}
	if err := m.buf.Push(entry); err != nil {
		return fmt.Errorf("missed calls: failed to buffer entry: %w", err)
	}
	log.Printf("missed calls: buffered call from %s", from)
	return nil
}

// DeliverAll drains the buffer and sends all missed calls to Svarla via the
// provided MessageSender. If there are no buffered calls, it does nothing.
// Calls are delivered in chronological order (oldest first).
func (m *MissedCallBuffer) DeliverAll(client MessageSender) error {
	calls, err := m.buf.DrainAll()
	if err != nil {
		return fmt.Errorf("missed calls: failed to drain buffer: %w", err)
	}

	if len(calls) == 0 {
		return nil
	}

	payload := MissedCallsPayload{
		Type:  TypeMissedCalls,
		Calls: calls,
	}

	msg, err := NewMessage(TypeMissedCalls, payload)
	if err != nil {
		return fmt.Errorf("missed calls: failed to create message: %w", err)
	}

	if err := client.Send(msg); err != nil {
		// Push calls back into the buffer so they aren't lost.
		for _, call := range calls {
			_ = m.buf.Push(call)
		}
		return fmt.Errorf("missed calls: failed to send message: %w", err)
	}

	log.Printf("missed calls: delivered %d buffered missed call(s)", len(calls))
	return nil
}

// Len returns the number of currently buffered missed calls.
func (m *MissedCallBuffer) Len() int {
	return m.buf.Len()
}

// Flush forces a rewrite of the backing file from current in-memory state.
func (m *MissedCallBuffer) Flush() error {
	return m.buf.Flush()
}
