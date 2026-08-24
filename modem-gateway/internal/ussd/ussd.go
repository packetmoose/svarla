// Package ussd implements USSD session management for carrier service
// interactions via AT+CUSD commands.
package ussd

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/packetmoose/svarla/modem-gateway/internal/modem"
)

// StepTimeout is the maximum time to wait for a USSD response from the network.
const StepTimeout = 30 * time.Second

// Errors returned by the USSD manager.
var (
	ErrCallActive     = errors.New("ussd: not available during active voice call")
	ErrSessionActive  = errors.New("ussd: session already active")
	ErrNoSession      = errors.New("ussd: no active session")
	ErrTimeout        = errors.New("ussd: network response timed out")
	ErrSessionPending = errors.New("ussd: session is pending a response")
)

// SessionState represents the current state of a USSD session.
type SessionState int

const (
	// StateIdle means no active USSD session.
	StateIdle SessionState = iota
	// StatePending means a USSD command was sent and we are awaiting a response.
	StatePending
	// StateActive means a multi-step session is in progress (network expects more input).
	StateActive
)

// String returns a human-readable representation of the session state.
func (s SessionState) String() string {
	switch s {
	case StateIdle:
		return "Idle"
	case StatePending:
		return "Pending"
	case StateActive:
		return "Active"
	default:
		return fmt.Sprintf("Unknown(%d)", int(s))
	}
}

// Response holds the result of a USSD command or follow-up input.
type Response struct {
	// Text is the network response text.
	Text string
	// SessionActive is true if the session expects more input from the user.
	SessionActive bool
}

// Manager handles USSD session state and AT+CUSD command execution.
type Manager struct {
	modem *modem.Modem

	mu         sync.Mutex
	state      SessionState
	callActive bool

	// responseCh receives parsed +CUSD URC responses. It is created
	// when a command is sent and consumed by the waiting goroutine.
	responseCh chan cusdResult
}

// cusdResult is the internal representation of a parsed +CUSD URC delivery.
type cusdResult struct {
	response *Response
	err      error
}

// New creates a new USSD Manager and registers the +CUSD URC handler on the modem.
func New(m *modem.Modem) *Manager {
	mgr := &Manager{
		modem: m,
		state: StateIdle,
	}

	m.OnURC(func(urc modem.URC) {
		if urc.Prefix == "+CUSD" {
			mgr.handleCUSD(urc)
		}
	})

	return mgr
}

// Execute initiates a new USSD session by sending AT+CUSD=1,"<code>".
// Returns the network response or an error. If the network indicates more
// input is needed, Response.SessionActive will be true.
func (mgr *Manager) Execute(code string) (*Response, error) {
	mgr.mu.Lock()

	if mgr.callActive {
		mgr.mu.Unlock()
		return nil, ErrCallActive
	}

	if mgr.state != StateIdle {
		mgr.mu.Unlock()
		return nil, ErrSessionActive
	}

	// Transition to pending and create the response channel.
	mgr.state = StatePending
	mgr.responseCh = make(chan cusdResult, 1)
	mgr.mu.Unlock()

	// Send the USSD command.
	cmd := fmt.Sprintf("AT+CUSD=1,\"%s\"", code)
	_, err := mgr.modem.SendCommand(cmd, StepTimeout)
	if err != nil {
		mgr.mu.Lock()
		mgr.state = StateIdle
		mgr.responseCh = nil
		mgr.mu.Unlock()
		return nil, fmt.Errorf("ussd: command failed: %w", err)
	}

	// Wait for the +CUSD URC response or timeout.
	return mgr.waitForResponse()
}

// SendInput sends a follow-up input in an active multi-step USSD session.
// The session must be in StateActive (i.e., a previous Execute or SendInput
// returned Response.SessionActive == true).
func (mgr *Manager) SendInput(input string) (*Response, error) {
	mgr.mu.Lock()

	if mgr.callActive {
		mgr.mu.Unlock()
		return nil, ErrCallActive
	}

	if mgr.state != StateActive {
		mgr.mu.Unlock()
		return nil, ErrNoSession
	}

	// Transition to pending and create the response channel.
	mgr.state = StatePending
	mgr.responseCh = make(chan cusdResult, 1)
	mgr.mu.Unlock()

	// Send the follow-up input.
	cmd := fmt.Sprintf("AT+CUSD=1,\"%s\"", input)
	_, err := mgr.modem.SendCommand(cmd, StepTimeout)
	if err != nil {
		mgr.mu.Lock()
		mgr.state = StateIdle
		mgr.responseCh = nil
		mgr.mu.Unlock()
		return nil, fmt.Errorf("ussd: input failed: %w", err)
	}

	// Wait for the +CUSD URC response or timeout.
	return mgr.waitForResponse()
}

// Cancel terminates the active USSD session by sending AT+CUSD=2.
// Returns an error if no session is active or if the command fails.
func (mgr *Manager) Cancel() error {
	mgr.mu.Lock()

	if mgr.state == StateIdle {
		mgr.mu.Unlock()
		return ErrNoSession
	}

	// Cancel regardless of pending/active state.
	mgr.state = StateIdle
	mgr.responseCh = nil
	mgr.mu.Unlock()

	_, err := mgr.modem.SendCommand("AT+CUSD=2", StepTimeout)
	if err != nil {
		return fmt.Errorf("ussd: cancel failed: %w", err)
	}

	return nil
}

// IsActive returns true if a USSD session is in progress (pending or active).
func (mgr *Manager) IsActive() bool {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	return mgr.state != StateIdle
}

// State returns the current session state.
func (mgr *Manager) State() SessionState {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	return mgr.state
}

// SetCallActive tracks whether a voice call is currently in progress.
// When a call is active, USSD operations are rejected.
func (mgr *Manager) SetCallActive(active bool) {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	mgr.callActive = active
}

// waitForResponse blocks until a +CUSD URC is received or the timeout expires.
// On timeout, it cancels the USSD session on the modem.
func (mgr *Manager) waitForResponse() (*Response, error) {
	mgr.mu.Lock()
	ch := mgr.responseCh
	mgr.mu.Unlock()

	if ch == nil {
		return nil, ErrNoSession
	}

	timer := time.NewTimer(StepTimeout)
	defer timer.Stop()

	select {
	case result := <-ch:
		if result.err != nil {
			return nil, result.err
		}
		return result.response, nil
	case <-timer.C:
		// Timeout — cancel the session on the modem.
		mgr.mu.Lock()
		mgr.state = StateIdle
		mgr.responseCh = nil
		mgr.mu.Unlock()

		// Best-effort cancel; ignore errors since we're already in error state.
		if _, err := mgr.modem.SendCommand("AT+CUSD=2", 5*time.Second); err != nil {
			slog.Debug("USSD timeout cancel failed", "error", err)
		}

		return nil, ErrTimeout
	}
}

// handleCUSD processes a +CUSD URC from the modem.
// It parses the status, determines the session state, and delivers the
// response to the waiting Execute/SendInput call via the response channel.
func (mgr *Manager) handleCUSD(urc modem.URC) {
	info, err := modem.ParseCUSD(urc.Data)
	if err != nil {
		slog.Error("Failed to parse +CUSD URC", "error", err, "data", urc.Data)

		mgr.mu.Lock()
		ch := mgr.responseCh
		if ch != nil {
			mgr.state = StateIdle
			mgr.responseCh = nil
		}
		mgr.mu.Unlock()

		if ch != nil {
			ch <- cusdResult{err: fmt.Errorf("ussd: failed to parse response: %w", err)}
		}
		return
	}

	slog.Debug("USSD response received", "status", info.Status, "text", info.Text)

	// Determine new state based on CUSD status code:
	// 0 = no further action needed (session complete)
	// 1 = further user action required (session active)
	// 2 = terminated by network
	// 3 = other local client responded
	// 4 = operation not supported
	// 5 = network timeout
	var resp *Response
	var respErr error

	switch info.Status {
	case 0: // No further action — session complete.
		resp = &Response{
			Text:          info.Text,
			SessionActive: false,
		}
		mgr.mu.Lock()
		mgr.state = StateIdle
		ch := mgr.responseCh
		mgr.responseCh = nil
		mgr.mu.Unlock()

		if ch != nil {
			ch <- cusdResult{response: resp}
		}
		return

	case 1: // Further action required — session stays active.
		resp = &Response{
			Text:          info.Text,
			SessionActive: true,
		}
		mgr.mu.Lock()
		mgr.state = StateActive
		ch := mgr.responseCh
		mgr.responseCh = nil
		mgr.mu.Unlock()

		if ch != nil {
			ch <- cusdResult{response: resp}
		}
		return

	case 2: // Terminated by network.
		resp = &Response{
			Text:          info.Text,
			SessionActive: false,
		}
		mgr.mu.Lock()
		mgr.state = StateIdle
		ch := mgr.responseCh
		mgr.responseCh = nil
		mgr.mu.Unlock()

		if ch != nil {
			ch <- cusdResult{response: resp}
		}
		return

	case 4: // Operation not supported.
		respErr = fmt.Errorf("ussd: operation not supported by network")

	case 5: // Network timeout.
		respErr = fmt.Errorf("ussd: network timeout")

	default: // Status 3 or unknown — treat as session ended.
		respErr = fmt.Errorf("ussd: unexpected status %d", info.Status)
	}

	// Error cases — reset session state.
	mgr.mu.Lock()
	mgr.state = StateIdle
	ch := mgr.responseCh
	mgr.responseCh = nil
	mgr.mu.Unlock()

	if ch != nil {
		ch <- cusdResult{err: respErr}
	}
}
