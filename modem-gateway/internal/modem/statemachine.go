package modem

import (
	"fmt"
	"sync"
)

// StateChangeHandler is called when the modem state transitions.
type StateChangeHandler func(from, to ModemState)

// StateMachine manages modem state transitions and enforces valid transitions.
// It is designed to be used by higher-level components (call manager, init sequence)
// that call transition methods after AT commands succeed or URCs are received.
type StateMachine struct {
	mu       sync.RWMutex
	state    ModemState
	lastErr  error
	handlers []StateChangeHandler
}

// NewStateMachine creates a new StateMachine starting in StateDisconnected.
func NewStateMachine() *StateMachine {
	return &StateMachine{
		state: StateDisconnected,
	}
}

// State returns the current modem state.
func (sm *StateMachine) State() ModemState {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.state
}

// LastError returns the last error that caused a transition to StateError.
func (sm *StateMachine) LastError() error {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.lastErr
}

// OnStateChange registers a handler that is called on every state transition.
// Handlers are called synchronously under the lock, so they should not block.
func (sm *StateMachine) OnStateChange(handler StateChangeHandler) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.handlers = append(sm.handlers, handler)
}

// TransitionToInitializing transitions from Disconnected → Initializing.
// Called when the serial port is opened and the init sequence begins.
func (sm *StateMachine) TransitionToInitializing() error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if sm.state != StateDisconnected && sm.state != StateError {
		return fmt.Errorf("modem: cannot transition to Initializing from %s", sm.state)
	}

	prev := sm.state
	sm.state = StateInitializing
	sm.lastErr = nil
	sm.notifyHandlers(prev, sm.state)
	return nil
}

// TransitionToReady transitions to Ready state.
// Valid from: Initializing (init complete), InCall (call ended via ATH or NO CARRIER).
func (sm *StateMachine) TransitionToReady() error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if sm.state != StateInitializing && sm.state != StateInCall {
		return fmt.Errorf("modem: cannot transition to Ready from %s", sm.state)
	}

	prev := sm.state
	sm.state = StateReady
	sm.lastErr = nil
	sm.notifyHandlers(prev, sm.state)
	return nil
}

// TransitionToInCall transitions from Ready → InCall.
// Called after ATD<number>; or ATA succeeds (call established).
func (sm *StateMachine) TransitionToInCall() error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if sm.state != StateReady {
		return fmt.Errorf("modem: cannot transition to InCall from %s", sm.state)
	}

	prev := sm.state
	sm.state = StateInCall
	sm.lastErr = nil
	sm.notifyHandlers(prev, sm.state)
	return nil
}

// TransitionToError transitions to Error state from any state.
// Called on fatal modem errors (port closed, unresponsive).
func (sm *StateMachine) TransitionToError(err error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	prev := sm.state
	sm.state = StateError
	sm.lastErr = err
	sm.notifyHandlers(prev, sm.state)
}

// TransitionToDisconnected transitions to Disconnected state from any state.
// Called when the serial port is closed or modem is physically disconnected.
func (sm *StateMachine) TransitionToDisconnected() {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	prev := sm.state
	sm.state = StateDisconnected
	sm.lastErr = nil
	sm.notifyHandlers(prev, sm.state)
}

// RegisterURCHandler registers a URC handler on the modem that triggers
// state transitions based on relevant URCs:
//   - "NO CARRIER" → TransitionToReady (call ended by remote party)
func (sm *StateMachine) RegisterURCHandler(m *Modem) {
	m.OnURC(func(urc URC) {
		switch urc.Prefix {
		case "NO CARRIER":
			sm.mu.RLock()
			inCall := sm.state == StateInCall
			sm.mu.RUnlock()

			if inCall {
				// Ignore error — if we're not in InCall (race condition),
				// TransitionToReady will return an error which we can safely discard.
				_ = sm.TransitionToReady()
			}
		}
	})
}

// notifyHandlers calls all registered state change handlers.
// Must be called with sm.mu held.
func (sm *StateMachine) notifyHandlers(from, to ModemState) {
	for _, h := range sm.handlers {
		h(from, to)
	}
}
