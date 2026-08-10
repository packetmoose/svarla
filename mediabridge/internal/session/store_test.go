package session

import (
	"testing"
)

func TestNewStore(t *testing.T) {
	store := NewStore()
	if store.Count() != 0 {
		t.Fatalf("expected 0 sessions, got %d", store.Count())
	}
}

func TestStoreCreate(t *testing.T) {
	store := NewStore()
	sess := NewSession("test-1", ProviderLeg{Type: ProviderLegSIP, URI: "sip:test@host:5060"}, Options{Ringback: true})

	if err := store.Create(sess); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if store.Count() != 1 {
		t.Fatalf("expected 1 session, got %d", store.Count())
	}
}

func TestStoreCreateDuplicate(t *testing.T) {
	store := NewStore()
	sess := NewSession("test-1", ProviderLeg{Type: ProviderLegPending}, Options{})

	if err := store.Create(sess); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	sess2 := NewSession("test-1", ProviderLeg{Type: ProviderLegPending}, Options{})
	if err := store.Create(sess2); err == nil {
		t.Fatal("expected error for duplicate session, got nil")
	}
}

func TestStoreGet(t *testing.T) {
	store := NewStore()
	sess := NewSession("test-1", ProviderLeg{Type: ProviderLegWebSocket, URI: "ws://host:9091/audio/test-1"}, Options{})

	_ = store.Create(sess)

	got := store.Get("test-1")
	if got == nil {
		t.Fatal("expected to find session, got nil")
	}
	if got.ID != "test-1" {
		t.Fatalf("expected session ID 'test-1', got '%s'", got.ID)
	}
}

func TestStoreGetNotFound(t *testing.T) {
	store := NewStore()

	got := store.Get("nonexistent")
	if got != nil {
		t.Fatal("expected nil for nonexistent session")
	}
}

func TestStoreDelete(t *testing.T) {
	store := NewStore()
	sess := NewSession("test-1", ProviderLeg{Type: ProviderLegPending}, Options{})
	_ = store.Create(sess)

	if !store.Delete("test-1") {
		t.Fatal("expected Delete to return true")
	}

	if store.Count() != 0 {
		t.Fatalf("expected 0 sessions after delete, got %d", store.Count())
	}
}

func TestStoreDeleteNotFound(t *testing.T) {
	store := NewStore()

	if store.Delete("nonexistent") {
		t.Fatal("expected Delete to return false for nonexistent session")
	}
}

func TestStoreCount(t *testing.T) {
	store := NewStore()

	for i := range 5 {
		sess := NewSession(
			"session-"+string(rune('a'+i)),
			ProviderLeg{Type: ProviderLegPending},
			Options{},
		)
		_ = store.Create(sess)
	}

	if store.Count() != 5 {
		t.Fatalf("expected 5 sessions, got %d", store.Count())
	}
}
