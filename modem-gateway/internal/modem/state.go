package modem

import "fmt"

// ModemState represents the current operational state of the modem.
type ModemState int

const (
	// StateDisconnected means the serial port is not open or the modem is unreachable.
	StateDisconnected ModemState = iota
	// StateInitializing means the modem is being configured via init commands.
	StateInitializing
	// StateReady means the modem is initialized and available for commands.
	StateReady
	// StateInCall means the modem has an active voice call.
	StateInCall
	// StateError means a fatal error occurred (timeout, port error).
	StateError
)

// String returns a human-readable representation of the modem state.
func (s ModemState) String() string {
	switch s {
	case StateDisconnected:
		return "Disconnected"
	case StateInitializing:
		return "Initializing"
	case StateReady:
		return "Ready"
	case StateInCall:
		return "InCall"
	case StateError:
		return "Error"
	default:
		return fmt.Sprintf("Unknown(%d)", int(s))
	}
}
