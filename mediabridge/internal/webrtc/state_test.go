package webrtc

import (
	"testing"
)

func TestSessionState_String(t *testing.T) {
	tests := []struct {
		state    SessionState
		expected string
	}{
		{StateCreated, "CREATED"},
		{StateWaitingClient, "WAITING_CLIENT"},
		{StateClientConnected, "CLIENT_CONNECTED"},
		{StateBridging, "BRIDGING"},
		{StateActive, "ACTIVE"},
		{StateClosing, "CLOSING"},
		{StateDestroyed, "DESTROYED"},
		{SessionState(99), "UNKNOWN"},
	}

	for _, tt := range tests {
		t.Run(tt.expected, func(t *testing.T) {
			if got := tt.state.String(); got != tt.expected {
				t.Errorf("SessionState(%d).String() = %q, want %q", tt.state, got, tt.expected)
			}
		})
	}
}

func TestSessionStateMachine_InitialState(t *testing.T) {
	sm := NewSessionStateMachine()
	if sm.State() != StateCreated {
		t.Errorf("initial state = %v, want CREATED", sm.State())
	}
}

func TestSessionStateMachine_ValidTransitions(t *testing.T) {
	// Test the full happy-path lifecycle.
	sm := NewSessionStateMachine()

	transitions := []SessionState{
		StateWaitingClient,
		StateClientConnected,
		StateBridging,
		StateActive,
		StateClosing,
		StateDestroyed,
	}

	for _, target := range transitions {
		if err := sm.Transition(target); err != nil {
			t.Errorf("Transition to %s failed: %v", target, err)
		}
		if sm.State() != target {
			t.Errorf("state after transition = %v, want %v", sm.State(), target)
		}
	}
}

func TestSessionStateMachine_InvalidTransitions(t *testing.T) {
	tests := []struct {
		name   string
		from   SessionState
		to     SessionState
	}{
		{"CREATED to ACTIVE", StateCreated, StateActive},
		{"CREATED to BRIDGING", StateCreated, StateBridging},
		{"WAITING_CLIENT to ACTIVE", StateWaitingClient, StateActive},
		{"CLIENT_CONNECTED to ACTIVE", StateClientConnected, StateActive},
		{"ACTIVE to CREATED", StateActive, StateCreated},
		{"DESTROYED to CREATED", StateDestroyed, StateCreated},
		{"CLOSING to ACTIVE", StateClosing, StateActive},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sm := &SessionStateMachine{state: tt.from}
			err := sm.Transition(tt.to)
			if err == nil {
				t.Errorf("Transition from %s to %s should fail", tt.from, tt.to)
			}
		})
	}
}

func TestSessionStateMachine_SkipToClosing(t *testing.T) {
	// Any non-terminal state should be able to transition to CLOSING.
	states := []SessionState{
		StateCreated,
		StateWaitingClient,
		StateClientConnected,
		StateBridging,
		StateActive,
	}

	for _, from := range states {
		t.Run(from.String()+"_to_CLOSING", func(t *testing.T) {
			sm := &SessionStateMachine{state: from}
			if err := sm.Transition(StateClosing); err != nil {
				t.Errorf("Transition from %s to CLOSING failed: %v", from, err)
			}
		})
	}
}

func TestSessionStateMachine_SkipToDestroyed(t *testing.T) {
	// Any state should be able to transition to DESTROYED (except DESTROYED itself).
	states := []SessionState{
		StateCreated,
		StateWaitingClient,
		StateClientConnected,
		StateBridging,
		StateActive,
		StateClosing,
	}

	for _, from := range states {
		t.Run(from.String()+"_to_DESTROYED", func(t *testing.T) {
			sm := &SessionStateMachine{state: from}
			if err := sm.Transition(StateDestroyed); err != nil {
				t.Errorf("Transition from %s to DESTROYED failed: %v", from, err)
			}
		})
	}
}

func TestSessionStateMachine_ConcurrentAccess(t *testing.T) {
	sm := NewSessionStateMachine()

	// Transition to WAITING_CLIENT first.
	if err := sm.Transition(StateWaitingClient); err != nil {
		t.Fatal(err)
	}

	// Run concurrent reads while transitioning.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 1000; i++ {
			_ = sm.State()
		}
	}()

	// Transition while reads are happening.
	_ = sm.Transition(StateClientConnected)
	<-done
}
