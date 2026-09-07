package sms

import (
	"sync"
	"testing"
	"time"
)

// memPartStore is an in-memory PartStore for tests.
type memPartStore struct {
	mu    sync.Mutex
	items map[string]StoredPart
}

func newMemPartStore() *memPartStore {
	return &memPartStore{items: make(map[string]StoredPart)}
}

func (m *memPartStore) Push(p StoredPart) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.items[p.PartKey()]; ok {
		return nil // duplicate suppression, matching the real buffer
	}
	m.items[p.PartKey()] = p
	return nil
}

func (m *memPartStore) Remove(key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.items, key)
	return nil
}

func (m *memPartStore) Snapshot() []StoredPart {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]StoredPart, 0, len(m.items))
	for _, p := range m.items {
		out = append(out, p)
	}
	return out
}

func (m *memPartStore) len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.items)
}

func TestReassembler_DurablePersistsAndCommits(t *testing.T) {
	store := newMemPartStore()
	r := NewReassemblerWithStore(0, store)

	if !r.Durable() {
		t.Fatal("expected reassembler to report Durable() == true")
	}

	// First part of a 3-part message: incomplete, but must be persisted.
	complete, _ := r.AddPart("+123", 7, 1, 3, "AAA")
	if complete {
		t.Fatal("message should not be complete after 1/3 parts")
	}
	if store.len() != 1 {
		t.Fatalf("expected 1 persisted part, got %d", store.len())
	}

	// Parts do not disappear until Commit, even once complete.
	r.AddPart("+123", 7, 2, 3, "BBB")
	complete, assembled := r.AddPart("+123", 7, 3, 3, "CCC")
	if !complete {
		t.Fatal("message should be complete after 3/3 parts")
	}
	if assembled != "AAABBBCCC" {
		t.Fatalf("unexpected assembled body: %q", assembled)
	}
	if store.len() != 3 {
		t.Fatalf("parts must remain persisted until Commit; got %d", store.len())
	}

	// Commit removes the persisted parts.
	r.Commit("+123", 7)
	if store.len() != 0 {
		t.Fatalf("expected 0 persisted parts after Commit, got %d", store.len())
	}
}

func TestReassembler_RehydratesIncompleteAcrossRestart(t *testing.T) {
	store := newMemPartStore()

	// First "process": receive 2 of 3 parts, then simulate a restart.
	r1 := NewReassemblerWithStore(0, store)
	r1.AddPart("+1", 9, 1, 3, "one")
	r1.AddPart("+1", 9, 3, 3, "three")
	if store.len() != 2 {
		t.Fatalf("expected 2 persisted parts before restart, got %d", store.len())
	}

	// "Restart": a fresh reassembler over the same store rehydrates the parts.
	r2 := NewReassemblerWithStore(0, store)
	if got := r2.PendingCount(); got != 1 {
		t.Fatalf("expected 1 pending message after rehydrate, got %d", got)
	}

	// The missing middle part arrives after restart -> completes.
	complete, assembled := r2.AddPart("+1", 9, 2, 3, "two")
	if !complete {
		t.Fatal("message should complete once the final missing part arrives post-restart")
	}
	if assembled != "onetwothree" {
		t.Fatalf("unexpected assembled body: %q", assembled)
	}
	r2.Commit("+1", 9)
	if store.len() != 0 {
		t.Fatalf("expected store emptied after commit, got %d", store.len())
	}
}

func TestReassembler_StaleCleanupPurgesStore(t *testing.T) {
	store := newMemPartStore()
	// Very short stale timeout so the entry ages out immediately.
	r := NewReassemblerWithStore(time.Nanosecond, store)

	r.AddPart("+5", 1, 1, 2, "half")
	if store.len() != 1 {
		t.Fatalf("expected 1 persisted part, got %d", store.len())
	}

	time.Sleep(2 * time.Millisecond)

	// Any subsequent AddPart triggers stale cleanup, which must purge the store.
	r.AddPart("+9", 2, 1, 2, "other")

	// The stale "+5"/1 entry and its persisted part must be gone; only the new
	// "+9"/2 part remains.
	if got := r.PendingCount(); got != 1 {
		t.Fatalf("expected 1 pending after stale cleanup, got %d", got)
	}
	found := false
	for _, p := range store.Snapshot() {
		if p.Sender == "+5" {
			found = true
		}
	}
	if found {
		t.Fatal("stale part for +5 should have been purged from the store")
	}
}

func TestReassembler_NonDurableReportsNotDurable(t *testing.T) {
	r := NewReassembler(0)
	if r.Durable() {
		t.Fatal("in-memory reassembler must report Durable() == false")
	}
	// Behaves as before: completes without a store.
	r.AddPart("+1", 1, 1, 2, "a")
	complete, assembled := r.AddPart("+1", 1, 2, 2, "b")
	if !complete || assembled != "ab" {
		t.Fatalf("unexpected result: complete=%v assembled=%q", complete, assembled)
	}
}
