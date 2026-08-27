package sms

import (
	"fmt"
	"sync"
	"time"
)

// DefaultStaleTimeout is the default duration after which incomplete
// multi-part messages are discarded.
const DefaultStaleTimeout = 5 * time.Minute

// concatKey uniquely identifies a concatenated SMS message by combining
// the sender number and the concatenation reference number. This prevents
// collisions when two different senders use the same reference number.
type concatKey struct {
	sender string
	refNum int
}

// String returns a human-readable representation for logging/debugging.
func (k concatKey) String() string {
	return fmt.Sprintf("%s/%d", k.sender, k.refNum)
}

// smsPart represents a single part of a concatenated SMS.
type smsPart struct {
	// SeqNum is the 1-based sequence number of this part within the message.
	SeqNum int
	// Body is the text content of this part.
	Body string
}

// pendingMessage tracks an incomplete multi-part SMS message.
type pendingMessage struct {
	// RefNum is the concatenation reference number shared by all parts.
	RefNum int
	// TotalParts is the total number of parts expected.
	TotalParts int
	// Parts contains the received parts (may be out of order, may have gaps).
	Parts []smsPart
	// CreatedAt is when the first part of this message was received.
	CreatedAt time.Time
}

// receivedCount returns how many unique parts have been received.
func (pm *pendingMessage) receivedCount() int {
	return len(pm.Parts)
}

// isComplete returns true when all expected parts have been received.
func (pm *pendingMessage) isComplete() bool {
	return pm.receivedCount() == pm.TotalParts
}

// assemble concatenates the parts in sequence order and returns the full message text.
// This should only be called when isComplete() returns true.
func (pm *pendingMessage) assemble() string {
	// Sort parts by sequence number. Since TotalParts is typically small (≤255),
	// a simple insertion into a slice indexed by SeqNum is efficient.
	ordered := make([]string, pm.TotalParts)
	for _, p := range pm.Parts {
		if p.SeqNum >= 1 && p.SeqNum <= pm.TotalParts {
			ordered[p.SeqNum-1] = p.Body
		}
	}

	result := ""
	for _, body := range ordered {
		result += body
	}
	return result
}

// Reassembler handles concatenated (multi-part) SMS reassembly.
// It tracks in-progress messages by their sender and concatenation reference
// number, and assembles them when all parts arrive. Stale incomplete messages
// are cleaned up after a configurable timeout.
type Reassembler struct {
	mu           sync.Mutex
	pending      map[concatKey]*pendingMessage
	staleTimeout time.Duration
}

// NewReassembler creates a Reassembler with the given stale timeout.
// If staleTimeout is 0, DefaultStaleTimeout (5 minutes) is used.
func NewReassembler(staleTimeout time.Duration) *Reassembler {
	if staleTimeout == 0 {
		staleTimeout = DefaultStaleTimeout
	}
	return &Reassembler{
		pending:      make(map[concatKey]*pendingMessage),
		staleTimeout: staleTimeout,
	}
}

// AddPart adds a part of a concatenated SMS message.
// sender is the originating phone number (used to disambiguate reference numbers).
// refNum is the concatenation reference number (shared across all parts of the same message).
// seqNum is the 1-based sequence number of this part.
// totalParts is the total number of parts in the message.
// body is the text content of this part.
//
// Returns:
//   - complete: true if all parts have been received and the message is fully assembled.
//   - assembled: the full concatenated message text (only meaningful when complete is true).
//
// If this part is a duplicate (same sender, refNum, and seqNum already received), it is ignored.
// Stale incomplete messages are cleaned up on each call to AddPart.
func (r *Reassembler) AddPart(sender string, refNum int, seqNum int, totalParts int, body string) (complete bool, assembled string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Clean up stale messages on each call.
	r.cleanupStaleLocked()

	// Validate inputs.
	if seqNum < 1 || seqNum > totalParts || totalParts < 1 {
		return false, ""
	}

	key := concatKey{sender: sender, refNum: refNum}

	// Look up or create the pending message.
	pm, exists := r.pending[key]
	if !exists {
		pm = &pendingMessage{
			RefNum:     refNum,
			TotalParts: totalParts,
			Parts:      make([]smsPart, 0, totalParts),
			CreatedAt:  time.Now(),
		}
		r.pending[key] = pm
	}

	// Check for duplicate part.
	for _, existing := range pm.Parts {
		if existing.SeqNum == seqNum {
			// Duplicate part, ignore.
			if pm.isComplete() {
				assembled = pm.assemble()
				delete(r.pending, key)
				return true, assembled
			}
			return false, ""
		}
	}

	// Add the new part.
	pm.Parts = append(pm.Parts, smsPart{
		SeqNum: seqNum,
		Body:   body,
	})

	// Check if the message is now complete.
	if pm.isComplete() {
		assembled = pm.assemble()
		delete(r.pending, key)
		return true, assembled
	}

	return false, ""
}

// PendingCount returns the number of incomplete messages being tracked.
func (r *Reassembler) PendingCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.pending)
}

// cleanupStaleLocked removes incomplete messages that have been pending
// longer than the stale timeout. Must be called with r.mu held.
func (r *Reassembler) cleanupStaleLocked() {
	now := time.Now()
	for key, pm := range r.pending {
		if now.Sub(pm.CreatedAt) > r.staleTimeout {
			delete(r.pending, key)
		}
	}
}
