package sms

import (
	"fmt"
	"log/slog"
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

// StoredPart is the durable, on-disk representation of a single received
// concatenated-SMS part. Parts are persisted the moment they are read from the
// modem so they can be deleted from (small) SIM/modem storage immediately,
// rather than being held on the SIM until the whole message arrives. The
// reassembler rehydrates from these on startup.
type StoredPart struct {
	Sender     string    `json:"sender"`
	RefNum     int       `json:"refNum"`
	SeqNum     int       `json:"seqNum"`
	TotalParts int       `json:"totalParts"`
	Body       string    `json:"body"`
	ReceivedAt time.Time `json:"receivedAt"`
}

// PartKey returns a stable unique key for a stored part, used for duplicate
// suppression and removal in the backing buffer.
func (p StoredPart) PartKey() string {
	return fmt.Sprintf("%s|%d|%d/%d", p.Sender, p.RefNum, p.SeqNum, p.TotalParts)
}

// PartStore is the durable backing store for in-flight concatenated-SMS parts.
// It is satisfied by a keyed persistent buffer. All methods must be safe for
// concurrent use.
type PartStore interface {
	// Push durably records a part. Duplicate keys are suppressed (no-op).
	Push(StoredPart) error
	// Remove deletes a part by its PartKey. A missing key is a no-op.
	Remove(key string) error
	// Snapshot returns all currently stored parts.
	Snapshot() []StoredPart
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

	// store durably persists in-flight parts so they can be deleted from the
	// modem immediately and survive a restart. May be nil, in which case the
	// reassembler is purely in-memory (parts are not durable across restarts).
	store PartStore
}

// NewReassembler creates a Reassembler with the given stale timeout.
// If staleTimeout is 0, DefaultStaleTimeout (5 minutes) is used.
func NewReassembler(staleTimeout time.Duration) *Reassembler {
	return NewReassemblerWithStore(staleTimeout, nil)
}

// NewReassemblerWithStore creates a Reassembler backed by a durable PartStore.
// If store is non-nil, previously persisted parts are rehydrated into memory so
// that concatenated messages in flight before a restart can still complete.
// If staleTimeout is 0, DefaultStaleTimeout (5 minutes) is used.
func NewReassemblerWithStore(staleTimeout time.Duration, store PartStore) *Reassembler {
	if staleTimeout == 0 {
		staleTimeout = DefaultStaleTimeout
	}
	r := &Reassembler{
		pending:      make(map[concatKey]*pendingMessage),
		staleTimeout: staleTimeout,
		store:        store,
	}
	if store != nil {
		r.rehydrateFromStore()
	}
	return r
}

// rehydrateFromStore loads persisted parts back into the in-memory pending map
// on startup. Parts older than the stale timeout are dropped (and removed from
// the store) rather than rehydrated.
func (r *Reassembler) rehydrateFromStore() {
	now := time.Now()
	for _, sp := range r.store.Snapshot() {
		if now.Sub(sp.ReceivedAt) > r.staleTimeout {
			_ = r.store.Remove(sp.PartKey())
			continue
		}
		if sp.SeqNum < 1 || sp.TotalParts < 1 || sp.SeqNum > sp.TotalParts {
			_ = r.store.Remove(sp.PartKey())
			continue
		}
		key := concatKey{sender: sp.Sender, refNum: sp.RefNum}
		pm, exists := r.pending[key]
		if !exists {
			pm = &pendingMessage{
				RefNum:     sp.RefNum,
				TotalParts: sp.TotalParts,
				Parts:      make([]smsPart, 0, sp.TotalParts),
				CreatedAt:  sp.ReceivedAt,
			}
			r.pending[key] = pm
		}
		// Skip duplicates that may exist across restarts.
		dup := false
		for _, existing := range pm.Parts {
			if existing.SeqNum == sp.SeqNum {
				dup = true
				break
			}
		}
		if !dup {
			pm.Parts = append(pm.Parts, smsPart{SeqNum: sp.SeqNum, Body: sp.Body})
		}
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

	// Durably persist this part before anything else. This is what allows the
	// caller to delete the part from modem storage immediately: the durable
	// copy survives a crash/restart even though the message is not yet complete.
	// Persist is idempotent (duplicate keys are suppressed by the store).
	r.persistPart(sender, refNum, seqNum, totalParts, body, pm.CreatedAt)

	// Check for duplicate part.
	for _, existing := range pm.Parts {
		if existing.SeqNum == seqNum {
			// Duplicate part, ignore.
			if pm.isComplete() {
				return true, pm.assemble()
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
	//
	// NOTE: on completion we deliberately do NOT yet remove the pending entry or
	// its persisted parts. The caller must durably persist the assembled message
	// first and then call Commit. This ordering guarantees the assembled message
	// is durable before its source parts are discarded, so a crash in between
	// cannot lose the message (the parts remain in the store and are rehydrated
	// on restart).
	if pm.isComplete() {
		return true, pm.assemble()
	}

	return false, ""
}

// Commit finalizes a completed concatenated message: it removes the pending
// entry and deletes all of its persisted parts from the store. It must be
// called only after the assembled message has been durably persisted
// downstream. Calling Commit for an unknown key is a no-op.
func (r *Reassembler) Commit(sender string, refNum int) {
	r.mu.Lock()
	defer r.mu.Unlock()

	key := concatKey{sender: sender, refNum: refNum}
	pm, ok := r.pending[key]
	if !ok {
		return
	}
	r.removeStoredParts(sender, pm)
	delete(r.pending, key)
}

// persistPart durably records a received part in the store, if one is
// configured. Errors are logged but not fatal: a failed persist just means the
// part is not durable across a restart, which the caller must account for by
// NOT deleting it from modem storage (see the receive path).
func (r *Reassembler) persistPart(sender string, refNum, seqNum, totalParts int, body string, receivedAt time.Time) {
	if r.store == nil {
		return
	}
	sp := StoredPart{
		Sender:     sender,
		RefNum:     refNum,
		SeqNum:     seqNum,
		TotalParts: totalParts,
		Body:       body,
		ReceivedAt: receivedAt,
	}
	if err := r.store.Push(sp); err != nil {
		slog.Warn("Failed to persist concat SMS part", "key", sp.PartKey(), "error", err)
	}
}

// removeStoredParts deletes every persisted part for a pending message from the
// store. Safe to call when no store is configured.
func (r *Reassembler) removeStoredParts(sender string, pm *pendingMessage) {
	if r.store == nil {
		return
	}
	for _, p := range pm.Parts {
		key := StoredPart{Sender: sender, RefNum: pm.RefNum, SeqNum: p.SeqNum, TotalParts: pm.TotalParts}.PartKey()
		if err := r.store.Remove(key); err != nil {
			slog.Warn("Failed to remove persisted concat part", "key", key, "error", err)
		}
	}
}

// Durable reports whether the reassembler is backed by a persistent store. When
// true, a part passed to AddPart is durably recorded before AddPart returns, so
// the caller may safely delete it from modem storage even if the overall
// message is not yet complete.
func (r *Reassembler) Durable() bool {
	return r.store != nil
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
			// Drop the in-memory entry and also purge its durable parts so the
			// store does not accumulate parts of messages that never complete.
			r.removeStoredParts(key.sender, pm)
			delete(r.pending, key)
		}
	}
}
