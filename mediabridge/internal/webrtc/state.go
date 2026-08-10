// Package webrtc provides WebRTC endpoint management using Pion with ICE Lite.
package webrtc

import (
	"fmt"
	"sync"
)

// SessionState represents the state of a MediaBridge session.
type SessionState int

const (
	// StateCreated indicates the session has been allocated but no connections exist.
	StateCreated SessionState = iota
	// StateWaitingClient indicates an SDP answer was generated, waiting for WebRTC connection.
	StateWaitingClient
	// StateClientConnected indicates WebRTC is established, waiting for provider leg.
	StateClientConnected
	// StateBridging indicates the provider leg is connecting.
	StateBridging
	// StateActive indicates both legs are connected and audio flows bidirectionally.
	StateActive
	// StateClosing indicates teardown is in progress.
	StateClosing
	// StateDestroyed indicates the session has been cleaned up.
	StateDestroyed
)

// String returns the human-readable name of the session state.
func (s SessionState) String() string {
	switch s {
	case StateCreated:
		return "CREATED"
	case StateWaitingClient:
		return "WAITING_CLIENT"
	case StateClientConnected:
		return "CLIENT_CONNECTED"
	case StateBridging:
		return "BRIDGING"
	case StateActive:
		return "ACTIVE"
	case StateClosing:
		return "CLOSING"
	case StateDestroyed:
		return "DESTROYED"
	default:
		return "UNKNOWN"
	}
}

// validTransitions defines which state transitions are allowed.
var validTransitions = map[SessionState][]SessionState{
	StateCreated:         {StateWaitingClient, StateClosing, StateDestroyed},
	StateWaitingClient:   {StateClientConnected, StateClosing, StateDestroyed},
	StateClientConnected: {StateBridging, StateClosing, StateDestroyed},
	StateBridging:        {StateActive, StateClosing, StateDestroyed},
	StateActive:          {StateClosing, StateDestroyed},
	StateClosing:         {StateDestroyed},
	StateDestroyed:       {},
}

// SessionStateMachine manages session state transitions with validation.
type SessionStateMachine struct {
	mu    sync.RWMutex
	state SessionState
}

// NewSessionStateMachine creates a new state machine starting in CREATED state.
func NewSessionStateMachine() *SessionStateMachine {
	return &SessionStateMachine{state: StateCreated}
}

// State returns the current state.
func (sm *SessionStateMachine) State() SessionState {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.state
}

// Transition attempts to move to the target state.
// Returns an error if the transition is not valid.
func (sm *SessionStateMachine) Transition(target SessionState) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	allowed := validTransitions[sm.state]
	for _, s := range allowed {
		if s == target {
			sm.state = target
			return nil
		}
	}
	return fmt.Errorf("invalid state transition from %s to %s", sm.state, target)
}
