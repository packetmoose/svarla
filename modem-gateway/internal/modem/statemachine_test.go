package modem

import (
	"errors"
	"testing"
)

func TestStateMachine_InitialState(t *testing.T) {
	sm := NewStateMachine()
	if sm.State() != StateDisconnected {
		t.Errorf("initial state = %v, want Disconnected", sm.State())
	}
}

func TestStateMachine_TransitionToInitializing(t *testing.T) {
	tests := []struct {
		name      string
		initial   ModemState
		wantErr   bool
		wantState ModemState
	}{
		{name: "from Disconnected", initial: StateDisconnected, wantErr: false, wantState: StateInitializing},
		{name: "from Error", initial: StateError, wantErr: false, wantState: StateInitializing},
		{name: "from Ready (invalid)", initial: StateReady, wantErr: true, wantState: StateReady},
		{name: "from InCall (invalid)", initial: StateInCall, wantErr: true, wantState: StateInCall},
		{name: "from Initializing (invalid)", initial: StateInitializing, wantErr: true, wantState: StateInitializing},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sm := &StateMachine{state: tt.initial}
			err := sm.TransitionToInitializing()
			if (err != nil) != tt.wantErr {
				t.Errorf("TransitionToInitializing() error = %v, wantErr %v", err, tt.wantErr)
			}
			if sm.State() != tt.wantState {
				t.Errorf("state after = %v, want %v", sm.State(), tt.wantState)
			}
		})
	}
}

func TestStateMachine_TransitionToReady(t *testing.T) {
	tests := []struct {
		name      string
		initial   ModemState
		wantErr   bool
		wantState ModemState
	}{
		{name: "from Initializing", initial: StateInitializing, wantErr: false, wantState: StateReady},
		{name: "from InCall", initial: StateInCall, wantErr: false, wantState: StateReady},
		{name: "from Disconnected (invalid)", initial: StateDisconnected, wantErr: true, wantState: StateDisconnected},
		{name: "from Ready (invalid)", initial: StateReady, wantErr: true, wantState: StateReady},
		{name: "from Error (invalid)", initial: StateError, wantErr: true, wantState: StateError},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sm := &StateMachine{state: tt.initial}
			err := sm.TransitionToReady()
			if (err != nil) != tt.wantErr {
				t.Errorf("TransitionToReady() error = %v, wantErr %v", err, tt.wantErr)
			}
			if sm.State() != tt.wantState {
				t.Errorf("state after = %v, want %v", sm.State(), tt.wantState)
			}
		})
	}
}

func TestStateMachine_TransitionToInCall(t *testing.T) {
	tests := []struct {
		name      string
		initial   ModemState
		wantErr   bool
		wantState ModemState
	}{
		{name: "from Ready", initial: StateReady, wantErr: false, wantState: StateInCall},
		{name: "from Disconnected (invalid)", initial: StateDisconnected, wantErr: true, wantState: StateDisconnected},
		{name: "from Initializing (invalid)", initial: StateInitializing, wantErr: true, wantState: StateInitializing},
		{name: "from InCall (invalid)", initial: StateInCall, wantErr: true, wantState: StateInCall},
		{name: "from Error (invalid)", initial: StateError, wantErr: true, wantState: StateError},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sm := &StateMachine{state: tt.initial}
			err := sm.TransitionToInCall()
			if (err != nil) != tt.wantErr {
				t.Errorf("TransitionToInCall() error = %v, wantErr %v", err, tt.wantErr)
			}
			if sm.State() != tt.wantState {
				t.Errorf("state after = %v, want %v", sm.State(), tt.wantState)
			}
		})
	}
}

func TestStateMachine_TransitionToError(t *testing.T) {
	testErr := errors.New("test error")

	// TransitionToError should work from any state.
	states := []ModemState{StateDisconnected, StateInitializing, StateReady, StateInCall, StateError}
	for _, initial := range states {
		sm := &StateMachine{state: initial}
		sm.TransitionToError(testErr)
		if sm.State() != StateError {
			t.Errorf("TransitionToError from %v: state = %v, want Error", initial, sm.State())
		}
		if sm.LastError() != testErr {
			t.Errorf("TransitionToError from %v: LastError = %v, want %v", initial, sm.LastError(), testErr)
		}
	}
}

func TestStateMachine_TransitionToDisconnected(t *testing.T) {
	// TransitionToDisconnected should work from any state.
	states := []ModemState{StateDisconnected, StateInitializing, StateReady, StateInCall, StateError}
	for _, initial := range states {
		sm := &StateMachine{state: initial}
		sm.TransitionToDisconnected()
		if sm.State() != StateDisconnected {
			t.Errorf("TransitionToDisconnected from %v: state = %v, want Disconnected", initial, sm.State())
		}
	}
}

func TestStateMachine_OnStateChange(t *testing.T) {
	sm := NewStateMachine()

	var transitions []struct{ from, to ModemState }
	sm.OnStateChange(func(from, to ModemState) {
		transitions = append(transitions, struct{ from, to ModemState }{from, to})
	})

	// Perform a full lifecycle: Disconnected → Initializing → Ready → InCall → Ready
	_ = sm.TransitionToInitializing()
	_ = sm.TransitionToReady()
	_ = sm.TransitionToInCall()
	_ = sm.TransitionToReady()

	expected := []struct{ from, to ModemState }{
		{StateDisconnected, StateInitializing},
		{StateInitializing, StateReady},
		{StateReady, StateInCall},
		{StateInCall, StateReady},
	}

	if len(transitions) != len(expected) {
		t.Fatalf("got %d transitions, want %d", len(transitions), len(expected))
	}
	for i, tr := range transitions {
		if tr.from != expected[i].from || tr.to != expected[i].to {
			t.Errorf("transition[%d] = {%v → %v}, want {%v → %v}",
				i, tr.from, tr.to, expected[i].from, expected[i].to)
		}
	}
}

func TestStateMachine_RegisterURCHandler_NoCarrier(t *testing.T) {
	// Create a mock serial port that we can write to.
	mockPort := &mockSerialPort{
		readData: []byte(""),
	}

	m := New(mockPort)
	sm := &StateMachine{state: StateInCall}
	sm.RegisterURCHandler(m)

	// Simulate a NO CARRIER URC being dispatched.
	m.dispatchURC("NO CARRIER")

	if sm.State() != StateReady {
		t.Errorf("after NO CARRIER: state = %v, want Ready", sm.State())
	}
}

func TestStateMachine_RegisterURCHandler_NoCarrier_NotInCall(t *testing.T) {
	// When not in InCall state, NO CARRIER should not change state.
	mockPort := &mockSerialPort{
		readData: []byte(""),
	}

	m := New(mockPort)
	sm := &StateMachine{state: StateReady}
	sm.RegisterURCHandler(m)

	// Simulate NO CARRIER when already in Ready state.
	m.dispatchURC("NO CARRIER")

	if sm.State() != StateReady {
		t.Errorf("after NO CARRIER from Ready: state = %v, want Ready", sm.State())
	}
}

// mockSerialPort is a test double for SerialPort.
type mockSerialPort struct {
	readData  []byte
	readPos   int
	writeData []byte
	closed    bool
}

func (m *mockSerialPort) Read(p []byte) (int, error) {
	if m.readPos >= len(m.readData) {
		// Block forever (simulate no more data).
		select {}
	}
	n := copy(p, m.readData[m.readPos:])
	m.readPos += n
	return n, nil
}

func (m *mockSerialPort) Write(p []byte) (int, error) {
	m.writeData = append(m.writeData, p...)
	return len(p), nil
}

func (m *mockSerialPort) Close() error {
	m.closed = true
	return nil
}
