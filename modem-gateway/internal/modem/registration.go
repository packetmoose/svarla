package modem

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
)

// Registration-related errors.
var (
	// ErrPINRequired is returned when the SIM requires a PIN but none is configured.
	ErrPINRequired = errors.New("modem: SIM PIN required but not configured")
	// ErrPINRejected is returned when the modem rejects the configured PIN.
	ErrPINRejected = errors.New("modem: SIM PIN rejected by modem")
)

// RegistrationConfig holds the configuration for network registration behavior.
type RegistrationConfig struct {
	// SelfRegistration enables active network registration management.
	// When false (default), the modem-gateway does not manage registration
	// and assumes the host OS handles it (passive mode).
	SelfRegistration bool
	// SimPin is the optional SIM PIN for automatic unlock.
	SimPin string
}

// RegistrationManager handles modem network registration according to the
// configured mode:
//   - Passive mode (default): no registration management, host OS handles it.
//   - Self-registration mode: issues AT+COPS=0 for automatic operator selection,
//     monitors AT+CREG for registration state, and handles SIM PIN unlock.
type RegistrationManager struct {
	modem  *Modem
	config RegistrationConfig

	mu          sync.RWMutex
	pinRejected bool // true if PIN was rejected; never retry
}

// NewRegistrationManager creates a new RegistrationManager with the given modem
// and configuration.
func NewRegistrationManager(modem *Modem, config RegistrationConfig) *RegistrationManager {
	return &RegistrationManager{
		modem:  modem,
		config: config,
	}
}

// Initialize runs the network registration initialization sequence.
// In passive mode, this is a no-op. In self-registration mode, it:
//  1. Checks SIM status and unlocks with PIN if needed.
//  2. Issues AT+COPS=0 for automatic operator selection.
//
// The context allows cancellation of long-running operations.
func (rm *RegistrationManager) Initialize(ctx context.Context) error {
	if !rm.config.SelfRegistration {
		slog.Debug("Network registration: passive mode, skipping registration management")
		return nil
	}

	slog.Info("Network registration: self-registration mode enabled")

	// Step 1: Handle SIM PIN if required.
	if err := rm.handleSIMPin(ctx); err != nil {
		return err
	}

	// Step 2: Issue AT+COPS=0 for automatic operator selection.
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("registration cancelled: %w", err)
	}

	slog.Debug("Issuing AT+COPS=0 for automatic operator selection")
	if _, err := rm.modem.SendCommand("AT+COPS=0", DefaultTimeout); err != nil {
		return fmt.Errorf("network registration: AT+COPS=0 failed: %w", err)
	}

	slog.Info("Network registration: automatic operator selection initiated")
	return nil
}

// IsRegistered queries the modem's current network registration status via AT+CREG?
// and returns true if registered on home network or roaming.
func (rm *RegistrationManager) IsRegistered() bool {
	resp, err := rm.modem.SendCommand("AT+CREG?", DefaultTimeout)
	if err != nil {
		slog.Warn("Failed to query registration status", "error", err)
		return false
	}

	stat := parseRegistrationStatus(resp)
	// stat == 1: registered home, stat == 5: registered roaming
	return stat == 1 || stat == 5
}

// handleSIMPin checks the SIM status and unlocks with PIN if necessary.
func (rm *RegistrationManager) handleSIMPin(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("registration cancelled: %w", err)
	}

	// Check current SIM status.
	resp, err := rm.modem.SendCommand("AT+CPIN?", DefaultTimeout)
	if err != nil {
		return fmt.Errorf("network registration: AT+CPIN? failed: %w", err)
	}

	status := parseCPINResponse(resp)

	switch status {
	case "READY":
		// SIM is unlocked, no PIN needed.
		slog.Debug("SIM is ready, no PIN required")
		return nil

	case "SIM PIN":
		// SIM requires PIN unlock.
		return rm.unlockSIM(ctx)

	default:
		// Other states (SIM PUK, etc.) — we can't handle these.
		return fmt.Errorf("network registration: unexpected SIM status: %s", status)
	}
}

// unlockSIM attempts to unlock the SIM with the configured PIN.
func (rm *RegistrationManager) unlockSIM(ctx context.Context) error {
	rm.mu.RLock()
	rejected := rm.pinRejected
	rm.mu.RUnlock()

	if rejected {
		return ErrPINRejected
	}

	if rm.config.SimPin == "" {
		return ErrPINRequired
	}

	if err := ctx.Err(); err != nil {
		return fmt.Errorf("registration cancelled: %w", err)
	}

	slog.Info("SIM PIN required, attempting unlock")
	cmd := fmt.Sprintf("AT+CPIN=%s", rm.config.SimPin)
	_, err := rm.modem.SendCommand(cmd, DefaultTimeout)
	if err != nil {
		// Mark PIN as rejected so we never retry.
		rm.mu.Lock()
		rm.pinRejected = true
		rm.mu.Unlock()

		slog.Error("SIM PIN rejected", "error", err)
		return ErrPINRejected
	}

	// Give the modem a moment to complete initialization after PIN unlock.
	select {
	case <-ctx.Done():
		return fmt.Errorf("registration cancelled: %w", ctx.Err())
	case <-time.After(2 * time.Second):
	}

	slog.Info("SIM PIN accepted, SIM unlocked")
	return nil
}

// parseCPINResponse extracts the SIM status from an AT+CPIN? response.
// Expected format: "+CPIN: READY" or "+CPIN: SIM PIN" etc.
func parseCPINResponse(resp string) string {
	for _, line := range strings.Split(resp, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "+CPIN:") {
			return strings.TrimSpace(strings.TrimPrefix(trimmed, "+CPIN:"))
		}
	}
	// If no +CPIN: prefix found, the response itself might be the status.
	return strings.TrimSpace(resp)
}

// parseRegistrationStatus extracts the registration stat value from AT+CREG? response.
// Expected format: "+CREG: <n>,<stat>" where stat is:
//
//	0 = not registered, not searching
//	1 = registered, home network
//	2 = not registered, searching
//	3 = registration denied
//	4 = unknown
//	5 = registered, roaming
//
// Returns -1 if parsing fails.
func parseRegistrationStatus(resp string) int {
	for _, line := range strings.Split(resp, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "+CREG:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(trimmed, "+CREG:"))
		// Format: "<n>,<stat>" or just "<stat>"
		parts := strings.Split(data, ",")
		if len(parts) >= 2 {
			// <n>,<stat>[,...]
			return parseDigit(parts[1])
		}
		if len(parts) == 1 {
			return parseDigit(parts[0])
		}
	}
	return -1
}

// parseDigit parses a single digit string to int, returning -1 on failure.
func parseDigit(s string) int {
	s = strings.TrimSpace(s)
	if len(s) == 1 && s[0] >= '0' && s[0] <= '9' {
		return int(s[0] - '0')
	}
	return -1
}
