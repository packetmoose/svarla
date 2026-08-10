package session

import (
	"fmt"
	"sync"
)

// Store is a thread-safe in-memory store for sessions.
// All state is ephemeral per requirement 4.8.
type Store struct {
	mu       sync.RWMutex
	sessions map[string]*Session
}

// NewStore creates a new empty session store.
func NewStore() *Store {
	return &Store{
		sessions: make(map[string]*Session),
	}
}

// Create adds a new session to the store.
// Returns an error if a session with the same ID already exists.
func (s *Store) Create(sess *Session) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.sessions[sess.ID]; exists {
		return fmt.Errorf("session %s already exists", sess.ID)
	}

	s.sessions[sess.ID] = sess
	return nil
}

// Get retrieves a session by ID. Returns nil if not found.
func (s *Store) Get(id string) *Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sessions[id]
}

// Delete removes a session from the store.
// Returns true if the session was found and deleted.
func (s *Store) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.sessions[id]; !exists {
		return false
	}

	delete(s.sessions, id)
	return true
}

// Count returns the number of active sessions.
func (s *Store) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.sessions)
}

// FindByExpectedCallId searches for a session whose ProviderLeg.ExpectedCallId
// matches the given callId. Returns the session ID or empty string if not found.
func (s *Store) FindByExpectedCallId(callId string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for id, sess := range s.sessions {
		sess.mu.RLock()
		expected := sess.ProviderLeg.ExpectedCallId
		sess.mu.RUnlock()
		if expected == callId {
			return id
		}
	}
	return ""
}
