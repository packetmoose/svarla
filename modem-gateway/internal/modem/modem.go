// Package modem provides AT command communication with the USB modem,
// including command serialization, URC parsing, and state machine management.
package modem

import (
	"bufio"
	"fmt"
	"strings"
	"sync"
	"time"
)

// URC represents an unsolicited result code received from the modem.
type URC struct {
	// Raw is the full line received (e.g. "+CLIP: \"+15551234567\",145").
	Raw string
	// Prefix is the URC identifier (e.g. "+CLIP", "RING", "+CMTI").
	Prefix string
	// Data is the remainder after the prefix and colon, trimmed (empty for RING).
	Data string
}

// URCHandler is a callback invoked when an unsolicited result code is received.
type URCHandler func(urc URC)

// Modem manages AT command communication over a serial port.
// It serializes commands through a single-goroutine queue and dispatches
// unsolicited result codes (URCs) to registered handlers.
type Modem struct {
	port SerialPort

	mu       sync.RWMutex
	state    ModemState
	closed   bool
	handlers []URCHandler

	cmdQueue chan *command
	done     chan struct{}

	// pendingMu protects pendingCmd and pendingLines.
	pendingMu    sync.Mutex
	pendingCmd   *command
	pendingLines []string
}

// New creates a new Modem instance using the given serial port.
// Call Open() to start the reader and command queue goroutines.
func New(port SerialPort) *Modem {
	return &Modem{
		port:     port,
		state:    StateDisconnected,
		cmdQueue: make(chan *command, 64),
		done:     make(chan struct{}),
	}
}

// Open starts the serial reader and command dispatcher goroutines.
// The modem transitions to StateInitializing.
func (m *Modem) Open() {
	m.mu.Lock()
	m.state = StateInitializing
	m.mu.Unlock()

	go m.readLoop()
	go m.dispatchLoop()
}

// State returns the current modem state.
func (m *Modem) State() ModemState {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.state
}

// SetState sets the modem state. This is used by higher-level components
// (init sequence, call manager) to drive state transitions.
func (m *Modem) SetState(state ModemState) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state = state
}

// OnURC registers a handler function that is called for each URC received
// from the modem. Multiple handlers can be registered. Handlers are called
// synchronously from the reader goroutine, so they should not block.
func (m *Modem) OnURC(handler URCHandler) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.handlers = append(m.handlers, handler)
}

// SendCommand sends an AT command to the modem and waits for the final
// result code (OK, ERROR, +CME ERROR, +CMS ERROR) or timeout.
// Pass timeout=0 to use the default timeout for the command type.
// Returns the intermediate response lines (excluding the final result code)
// joined by newlines, or an error.
func (m *Modem) SendCommand(cmd string, timeout time.Duration) (string, error) {
	m.mu.RLock()
	if m.closed {
		m.mu.RUnlock()
		return "", ErrPortClosed
	}
	m.mu.RUnlock()

	if timeout == 0 {
		timeout = TimeoutForCommand(cmd)
	}

	c := &command{
		cmd:       cmd,
		timeout:   timeout,
		response:  make(chan commandResult, 1),
		completed: make(chan struct{}),
	}

	// Submit to the command queue.
	select {
	case m.cmdQueue <- c:
	case <-m.done:
		return "", ErrPortClosed
	}

	// Wait for the command to complete.
	select {
	case result := <-c.response:
		if result.err != nil {
			return strings.Join(result.lines, "\n"), result.err
		}
		return strings.Join(result.lines, "\n"), nil
	case <-m.done:
		return "", ErrPortClosed
	}
}

// Close shuts down the modem manager, closing the serial port and
// stopping all goroutines. Any pending commands will receive ErrPortClosed.
func (m *Modem) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	m.state = StateDisconnected
	m.mu.Unlock()

	close(m.done)
	return m.port.Close()
}

// dispatchLoop is the single goroutine that serializes AT command execution.
// It reads commands from the queue one at a time, executes them, and waits
// for completion before processing the next command.
func (m *Modem) dispatchLoop() {
	for {
		select {
		case cmd := <-m.cmdQueue:
			m.executeCommand(cmd)
		case <-m.done:
			// Drain remaining commands with errors.
			for {
				select {
				case cmd := <-m.cmdQueue:
					cmd.response <- commandResult{err: ErrPortClosed}
				default:
					return
				}
			}
		}
	}
}

// executeCommand writes the command to the serial port and blocks until
// the reader delivers a response or the timeout expires.
// Only one command executes at a time (enforced by dispatchLoop).
func (m *Modem) executeCommand(cmd *command) {
	// Register this as the pending command so the reader routes lines here.
	m.pendingMu.Lock()
	m.pendingCmd = cmd
	m.pendingLines = nil
	m.pendingMu.Unlock()

	defer func() {
		m.pendingMu.Lock()
		m.pendingCmd = nil
		m.pendingLines = nil
		m.pendingMu.Unlock()
	}()

	// Write command to serial port.
	line := cmd.cmd + "\r\n"
	if _, err := m.port.Write([]byte(line)); err != nil {
		cmd.response <- commandResult{err: fmt.Errorf("modem: write failed: %w", err)}
		return
	}

	// Wait for the reader to deliver the result or timeout.
	timer := time.NewTimer(cmd.timeout)
	defer timer.Stop()

	select {
	case <-cmd.completed:
		// Reader delivered the result to cmd.response. Done.
	case <-timer.C:
		// Timeout. Try to deliver timeout error. The reader might
		// deliver at the same moment, so use non-blocking send.
		select {
		case cmd.response <- commandResult{err: ErrTimeout}:
		default:
		}
	case <-m.done:
		select {
		case cmd.response <- commandResult{err: ErrPortClosed}:
		default:
		}
	}
}

// readLoop continuously reads lines from the serial port and routes them
// to either the pending command or URC handlers.
func (m *Modem) readLoop() {
	scanner := bufio.NewScanner(m.port)
	for scanner.Scan() {
		select {
		case <-m.done:
			return
		default:
		}

		line := scanner.Text()
		// Skip empty lines (common in AT responses).
		if strings.TrimSpace(line) == "" {
			continue
		}

		// Check if this line is a final result code for a pending command.
		code, detail := ParseResultCode(line)
		if code != ResultNone {
			m.pendingMu.Lock()
			cmd := m.pendingCmd
			lines := m.pendingLines
			m.pendingLines = nil
			m.pendingMu.Unlock()

			if cmd != nil {
				// Deliver result. Non-blocking because the channel is
				// buffered (cap 1) and the timeout path also sends non-blocking.
				select {
				case cmd.response <- commandResult{lines: lines, err: ResultToError(code, detail)}:
				default:
				}
				// Signal that the command is done so dispatchLoop proceeds.
				close(cmd.completed)
			}
			continue
		}

		// Known URCs are dispatched even during command execution.
		if isKnownURC(line) {
			m.dispatchURC(line)
			continue
		}

		// Accumulate as command response line if a command is pending.
		m.pendingMu.Lock()
		hasPending := m.pendingCmd != nil
		if hasPending {
			m.pendingLines = append(m.pendingLines, line)
		}
		m.pendingMu.Unlock()

		if !hasPending {
			// No pending command — treat as URC.
			m.dispatchURC(line)
		}
	}
}

// dispatchURC parses a line into a URC and calls all registered handlers.
func (m *Modem) dispatchURC(line string) {
	urc := parseURC(line)

	m.mu.RLock()
	handlers := make([]URCHandler, len(m.handlers))
	copy(handlers, m.handlers)
	m.mu.RUnlock()

	for _, h := range handlers {
		h(urc)
	}
}

// parseURC splits a raw URC line into prefix and data components.
func parseURC(line string) URC {
	trimmed := strings.TrimSpace(line)

	// URCs with colon separator (e.g. "+CLIP: data")
	if idx := strings.Index(trimmed, ":"); idx >= 0 {
		prefix := strings.TrimSpace(trimmed[:idx])
		data := strings.TrimSpace(trimmed[idx+1:])
		return URC{Raw: trimmed, Prefix: prefix, Data: data}
	}

	// URCs without data (e.g. "RING", "NO CARRIER")
	return URC{Raw: trimmed, Prefix: trimmed, Data: ""}
}

// knownURCPrefixes are URC indicators that should be dispatched even if
// a command is pending, because they arrive asynchronously from the modem.
var knownURCPrefixes = []string{
	"RING",
	"+CLIP:",
	"+CMTI:",
	"+CUSD:",
	"+DTMF:",
	"+CREG:",
	"+CDS:",
	"NO CARRIER",
	"+CRING:",
}

// isKnownURC checks if a line starts with a known URC prefix.
func isKnownURC(line string) bool {
	trimmed := strings.TrimSpace(line)
	for _, prefix := range knownURCPrefixes {
		if strings.HasPrefix(trimmed, prefix) {
			return true
		}
	}
	return false
}
