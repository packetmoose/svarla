package modem

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// Default command timeouts.
const (
	DefaultTimeout = 30 * time.Second
	VTSTimeout     = 5 * time.Second
	CMGSTimeout    = 60 * time.Second
	CMGRTimeout    = 60 * time.Second // SIM storage reads can be slow on some modems
)

// Errors returned by command execution.
var (
	ErrTimeout    = errors.New("modem: command timed out")
	ErrGeneric    = errors.New("modem: ERROR")
	ErrPortClosed = errors.New("modem: serial port closed")
	ErrNotReady   = errors.New("modem: not in ready state")
)

// CMEError represents a +CME ERROR response from the modem.
type CMEError struct {
	Code string
}

func (e *CMEError) Error() string {
	return fmt.Sprintf("modem: +CME ERROR: %s", e.Code)
}

// CMSError represents a +CMS ERROR response from the modem.
type CMSError struct {
	Code string
}

func (e *CMSError) Error() string {
	return fmt.Sprintf("modem: +CMS ERROR: %s", e.Code)
}

// command represents an AT command to be executed by the command queue.
type command struct {
	cmd     string
	timeout time.Duration
	// response receives the final result. Buffered with cap 1.
	response chan commandResult
	// completed is closed when the command has finished (result delivered).
	// This signals the dispatch loop to proceed to the next command.
	completed chan struct{}
	// smsBody is the message body + Ctrl-Z for two-phase SMS send.
	// When non-empty, executeCommand will wait for the ">" prompt after
	// writing cmd, then write smsBody separately.
	smsBody string
	// promptReady is signaled by the readLoop when it detects the "> " prompt
	// during a two-phase SMS send. Only used when smsBody is non-empty.
	promptReady chan struct{}
}

// commandResult holds the result of a completed AT command.
type commandResult struct {
	// lines contains all intermediate response lines (excluding the final result code).
	lines []string
	// err is nil on OK, or the appropriate error for ERROR / +CME / +CMS / timeout.
	err error
}

// TimeoutForCommand returns the appropriate timeout for a given AT command.
// Special cases: AT+VTS → 5s, AT+CMGS → 60s, AT+CMGR/AT+CMGL → 60s. Everything else → 30s.
func TimeoutForCommand(cmd string) time.Duration {
	upper := strings.ToUpper(strings.TrimSpace(cmd))
	if strings.HasPrefix(upper, "AT+VTS") {
		return VTSTimeout
	}
	if strings.HasPrefix(upper, "AT+CMGS") {
		return CMGSTimeout
	}
	if strings.HasPrefix(upper, "AT+CMGR") || strings.HasPrefix(upper, "AT+CMGL") {
		return CMGRTimeout
	}
	return DefaultTimeout
}

// isCMGSCommand returns true if the command is an SMS send command (AT+CMGS).
// This is used to determine whether ESC should be sent after a timeout to
// abort text input mode on the modem.
func isCMGSCommand(cmd string) bool {
	return strings.HasPrefix(strings.ToUpper(strings.TrimSpace(cmd)), "AT+CMGS")
}

// ResultCode identifies the type of final result code from the modem.
type ResultCode int

const (
	ResultNone ResultCode = iota
	ResultOK
	ResultError
	ResultCMEError
	ResultCMSError
)

// ParseResultCode checks if a line is a final result code.
// Returns the result code type and any error detail (for +CME/+CMS).
func ParseResultCode(line string) (ResultCode, string) {
	trimmed := strings.TrimSpace(line)

	if trimmed == "OK" {
		return ResultOK, ""
	}
	if trimmed == "ERROR" {
		return ResultError, ""
	}
	if strings.HasPrefix(trimmed, "+CME ERROR:") {
		code := strings.TrimSpace(strings.TrimPrefix(trimmed, "+CME ERROR:"))
		return ResultCMEError, code
	}
	if strings.HasPrefix(trimmed, "+CMS ERROR:") {
		code := strings.TrimSpace(strings.TrimPrefix(trimmed, "+CMS ERROR:"))
		return ResultCMSError, code
	}

	return ResultNone, ""
}

// ResultToError converts a parsed result code into an appropriate error.
// Returns nil for ResultOK.
func ResultToError(code ResultCode, detail string) error {
	switch code {
	case ResultOK:
		return nil
	case ResultError:
		return ErrGeneric
	case ResultCMEError:
		return &CMEError{Code: detail}
	case ResultCMSError:
		return &CMSError{Code: detail}
	default:
		return nil
	}
}
