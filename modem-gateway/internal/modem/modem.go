// Package modem provides AT command communication with the USB modem,
// including command serialization, URC parsing, and state machine management.
package modem

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
)

// logLevelVerbose is the custom log level for raw AT command tracing.
// Matches config.LevelVerbose (-8) without importing the config package.
const logLevelVerbose = slog.Level(-8)

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

	// logger is used for debug-level AT command tracing. When nil, no
	// command-level logging is emitted.
	logger *slog.Logger
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

// SetLogger enables debug logging of AT commands and responses.
// Pass a configured *slog.Logger to see all serial traffic. Pass nil to disable.
func (m *Modem) SetLogger(l *slog.Logger) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.logger = l
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
// in separate goroutines so they may safely call SendCommand without
// deadlocking the readLoop.
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

// SendSMSCommand sends an SMS using two-phase AT+CMGS interaction:
//  1. Sends the CMGS header (AT+CMGS="number"\r) and waits for the ">" prompt.
//  2. Sends the message body followed by Ctrl-Z (0x1A) and waits for the final result.
//
// This two-phase approach is required because the SIM7600 (and many other modems)
// needs to transition into text input mode before accepting the message body.
// Writing everything in a single burst causes the body/Ctrl-Z to be lost.
//
// Returns the response (containing +CMGS: <ref>) on success, or an error.
func (m *Modem) SendSMSCommand(header string, body string, timeout time.Duration) (string, error) {
	m.mu.RLock()
	if m.closed {
		m.mu.RUnlock()
		return "", ErrPortClosed
	}
	m.mu.RUnlock()

	if timeout == 0 {
		timeout = CMGSTimeout
	}

	c := &command{
		cmd:         header,
		timeout:     timeout,
		response:    make(chan commandResult, 1),
		completed:   make(chan struct{}),
		smsBody:     body + "\x1A",
		promptReady: make(chan struct{}, 1),
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

// WriteRaw writes raw bytes directly to the serial port, bypassing the command
// queue. This is used for sending escape sequences (e.g. ESC to abort text
// input mode) where a full command/response cycle is not expected.
// It is safe to call before Open() has been called.
func (m *Modem) WriteRaw(data []byte) {
	m.mu.RLock()
	if m.closed {
		m.mu.RUnlock()
		return
	}
	m.mu.RUnlock()

	if m.logger != nil {
		m.logger.Log(context.Background(), logLevelVerbose, "AT RAW TX", "bytes", fmt.Sprintf("%q", data))
	}
	_, _ = m.port.Write(data)
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
//
// For two-phase SMS sends (cmd.smsBody non-empty), it writes the CMGS header,
// waits for the ">" prompt from the modem, then writes the body + Ctrl-Z.
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
	if m.logger != nil {
		m.logger.Log(context.Background(), logLevelVerbose, "AT TX", "cmd", cmd.cmd)
	}
	if _, err := m.port.Write([]byte(line)); err != nil {
		cmd.response <- commandResult{err: fmt.Errorf("modem: write failed: %w", err)}
		return
	}

	// Two-phase SMS send: wait for the "> " prompt, then write body + Ctrl-Z.
	if cmd.smsBody != "" {
		promptTimer := time.NewTimer(10 * time.Second)
		select {
		case <-cmd.promptReady:
			// Modem is ready for the message body.
			promptTimer.Stop()
		case <-promptTimer.C:
			// Modem never sent "> " prompt — it may have returned ERROR directly
			// (handled by readLoop delivering to cmd.completed), or something is wrong.
			// Check if the command already completed (e.g. with ERROR).
			select {
			case <-cmd.completed:
				return
			default:
			}
			// Genuinely timed out waiting for prompt.
			if m.logger != nil {
				m.logger.Log(context.Background(), logLevelVerbose, "AT SMS prompt timeout", "cmd", cmd.cmd)
			}
			select {
			case cmd.response <- commandResult{err: fmt.Errorf("modem: timed out waiting for SMS input prompt")}:
			default:
			}
			close(cmd.completed)
			return
		case <-cmd.completed:
			// Command already completed (e.g. modem returned ERROR before prompt).
			promptTimer.Stop()
			return
		case <-m.done:
			promptTimer.Stop()
			select {
			case cmd.response <- commandResult{err: ErrPortClosed}:
			default:
			}
			return
		}

		// Write the SMS body + Ctrl-Z.
		if m.logger != nil {
			m.logger.Log(context.Background(), logLevelVerbose, "AT TX (SMS body)", "body", cmd.smsBody)
		}
		if _, err := m.port.Write([]byte(cmd.smsBody)); err != nil {
			cmd.response <- commandResult{err: fmt.Errorf("modem: SMS body write failed: %w", err)}
			close(cmd.completed)
			return
		}
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
		if m.logger != nil {
			m.logger.Log(context.Background(), logLevelVerbose, "AT TIMEOUT", "cmd", cmd.cmd, "timeout", cmd.timeout)
		}
		select {
		case cmd.response <- commandResult{err: ErrTimeout}:
		default:
		}

		// If this was a CMGS (SMS send) command, the modem is likely stuck
		// in text input mode waiting for Ctrl-Z or ESC. Send ESC (0x1B) to
		// abort the text input and return the modem to command mode.
		if isCMGSCommand(cmd.cmd) {
			if m.logger != nil {
				m.logger.Log(context.Background(), logLevelVerbose, "AT TX (ESC to abort text mode)", "cmd", "0x1B")
			}
			_, _ = m.port.Write([]byte{0x1B})
			// Give the modem time to process ESC and emit a result code
			// before we move to the next command.
			escDrain := time.NewTimer(2 * time.Second)
			select {
			case <-cmd.completed:
			case <-escDrain.C:
			case <-m.done:
			}
			escDrain.Stop()
		} else {
			// Drain: wait briefly for the reader to close cmd.completed so it
			// doesn't accidentally deliver a stale result to the next command.
			// This prevents the "every other command fails" cascade.
			drain := time.NewTimer(500 * time.Millisecond)
			select {
			case <-cmd.completed:
			case <-drain.C:
			case <-m.done:
			}
			drain.Stop()
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
	scanner.Split(scanATLines)
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

		if m.logger != nil {
			m.logger.Log(context.Background(), logLevelVerbose, "AT RX", "line", line)
		}

		// Detect SMS text input prompt "> " for two-phase SMS sending.
		// When the modem enters text input mode, it sends "> " to indicate
		// it's ready to accept the message body.
		if strings.TrimRight(line, " ") == ">" {
			m.pendingMu.Lock()
			cmd := m.pendingCmd
			m.pendingMu.Unlock()
			if cmd != nil && cmd.promptReady != nil {
				select {
				case cmd.promptReady <- struct{}{}:
				default:
				}
			}
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

		// Filter out command echo (modem may echo back the command we sent).
		m.pendingMu.Lock()
		pendingCmd := m.pendingCmd
		m.pendingMu.Unlock()
		if pendingCmd != nil && strings.EqualFold(strings.TrimSpace(line), strings.TrimSpace(pendingCmd.cmd)) {
			if m.logger != nil {
				m.logger.Log(context.Background(), logLevelVerbose, "AT ECHO (filtered)", "line", line)
			}
			continue
		}

		// Known URCs are dispatched even during command execution.
		// However, some URCs (like +CREG:) are also valid solicited responses
		// to queries (AT+CREG?). When a command is pending, dispatch the URC
		// AND accumulate the line as a response so the command gets it.
		if isKnownURC(line) {
			if m.logger != nil {
				m.logger.Log(context.Background(), logLevelVerbose, "AT URC", "line", line)
			}
			m.dispatchURC(line)

			// Also accumulate as response line if a command is pending,
			// since this may be the solicited answer to that command.
			m.pendingMu.Lock()
			if m.pendingCmd != nil {
				m.pendingLines = append(m.pendingLines, line)
			}
			m.pendingMu.Unlock()
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
// Handlers are called in a new goroutine so they can safely call SendCommand
// without deadlocking the readLoop (which delivers command responses).
func (m *Modem) dispatchURC(line string) {
	urc := parseURC(line)

	m.mu.RLock()
	handlers := make([]URCHandler, len(m.handlers))
	copy(handlers, m.handlers)
	m.mu.RUnlock()

	for _, h := range handlers {
		go h(urc)
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
	"+CDSI:",
	"+CUSD:",
	"+DTMF:",
	"+CREG:",
	"+CDS:",
	"NO CARRIER",
	"+CRING:",
	"MISSED_CALL:",
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

// scanATLines is a bufio.SplitFunc that splits on \r\n, bare \r, or bare \n.
// AT modems commonly use \r\n but may also use bare \r as a line delimiter,
// which the default bufio.ScanLines does not handle. This ensures every
// response token is delivered promptly regardless of the modem's line ending style.
//
// Special case: the SMS text input prompt "> " (greater-than + space) is emitted
// by the modem without a trailing line ending. This function detects it and
// returns it immediately so the two-phase SMS send doesn't block waiting for
// a newline that never arrives.
func scanATLines(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}

	// Look for the first \r or \n.
	for i := 0; i < len(data); i++ {
		if data[i] == '\n' {
			// Bare \n or the \n in a \r\n pair (the \r was already consumed).
			return i + 1, data[:i], nil
		}
		if data[i] == '\r' {
			// Check if followed by \n (i.e. \r\n).
			if i+1 < len(data) {
				if data[i+1] == '\n' {
					return i + 2, data[:i], nil
				}
				// Bare \r — treat as line ending.
				return i + 1, data[:i], nil
			}
			// \r at end of buffer — need more data to decide if \r\n follows.
			if atEOF {
				return len(data), data[:i], nil
			}
			// Request more data.
			return 0, nil, nil
		}
	}

	// No line ending found — check for the SMS text input prompt "> ".
	// The modem emits this without a trailing CR/LF, so we must detect it
	// and return it immediately to unblock the two-phase SMS send.
	trimmed := string(data)
	if trimmed == "> " || trimmed == ">" {
		return len(data), data, nil
	}

	// No line ending found.
	if atEOF {
		return len(data), data, nil
	}
	// Request more data.
	return 0, nil, nil
}
