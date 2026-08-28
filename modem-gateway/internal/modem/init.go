package modem

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

// Backoff limits for modem detection retries.
const (
	initBackoffMin = 2 * time.Second
	initBackoffMax = 30 * time.Second
)

// knownModemPatterns lists glob-style prefixes for modems known to be compatible.
var knownModemPatterns = []string{
	"SIM7600",
	"SIM7500",
	"A7600",
	"SIMCOM_SIM7600",
}

// ModemInfo holds identification data queried from the modem during initialization.
type ModemInfo struct {
	Model              string
	Manufacturer       string
	Firmware           string
	UnsupportedWarning string // non-empty if modem model not recognized
}

// InitResult is returned by RunInitSequence on success.
type InitResult struct {
	Info     ModemInfo
	TextMode bool // true if AT+CMGF=1 succeeded
	// CNMIDeliveryStatus indicates which <ds> parameter succeeded for AT+CNMI.
	// 1 = direct +CDS push, 2 = +CDSI index notification, 0 = no notification (needs polling),
	// -1 = AT+CNMI failed entirely.
	CNMIDeliveryStatus int
}

// RunInitSequence performs the modem initialization sequence:
//  1. Detect modem presence (ATE0 with exponential backoff)
//  2. Configure modem settings (verbose results, caller ID, DTMF, SMS notifications)
//  3. Set SMS mode (text mode preferred, PDU fallback)
//  4. Query modem identification (model, manufacturer, firmware)
//  5. Compatibility check against known-supported patterns
//
// On success, the modem state transitions to StateReady.
// The context allows cancellation of the backoff/retry loop.
func RunInitSequence(ctx context.Context, m *Modem) (*InitResult, error) {
	// Phase 1: Detect modem with exponential backoff.
	if err := detectModem(ctx, m); err != nil {
		return nil, fmt.Errorf("modem init: detection failed: %w", err)
	}

	// Phase 2: Configure modem.
	configCmds := []struct {
		cmd      string
		desc     string
		optional bool // if true, failure is logged but not fatal
	}{
		{"ATV1", "verbose result codes", false},
		{"AT+CLIP=1", "caller ID presentation", false},
		{"AT+DDET=1", "DTMF detection", true},
		{"AT+CATR=0", "route all URCs to this port", true},
	}

	for _, c := range configCmds {
		if _, err := m.SendCommand(c.cmd, 0); err != nil {
			if c.optional {
				slog.Warn("Optional modem config command failed (continuing)",
					"cmd", c.cmd, "desc", c.desc, "error", err)
				continue
			}
			m.SetState(StateError)
			return nil, fmt.Errorf("modem init: %s (%s) failed: %w", c.cmd, c.desc, err)
		}
	}

	// Configure SMS notification routing (AT+CNMI).
	// Try preferred parameters first, then fall back to alternatives.
	// SIM7600 series doesn't support <ds>=1 (direct +CDS routing) in some
	// firmware versions, so we try <ds>=2 and finally <ds>=0 as fallbacks.
	type cnmiVariant struct {
		cmd string
		ds  int
	}
	cnmiVariants := []cnmiVariant{
		{"AT+CNMI=2,1,0,1,0", 1}, // preferred: +CMTI for new SMS, +CDS for delivery reports
		{"AT+CNMI=2,1,0,2,0", 2}, // fallback 1: +CMTI for new SMS, +CDSI for delivery reports
		{"AT+CNMI=2,1,0,0,0", 0}, // fallback 2: +CMTI for new SMS, no delivery report routing
	}
	cnmiDS := -1
	for _, v := range cnmiVariants {
		if _, err := m.SendCommand(v.cmd, 0); err == nil {
			slog.Info("SMS notification routing configured", "cmd", v.cmd)
			cnmiDS = v.ds
			break
		}
	}
	if cnmiDS == -1 {
		slog.Warn("AT+CNMI configuration failed with all variants — incoming SMS notifications may not work")
	}

	// Phase 3: SMS mode — prefer text mode, fallback to PDU.
	textMode := true
	if _, err := m.SendCommand("AT+CMGF=1", 0); err != nil {
		slog.Warn("AT+CMGF=1 (text mode) not supported, falling back to PDU mode", "error", err)
		if _, err2 := m.SendCommand("AT+CMGF=0", 0); err2 != nil {
			m.SetState(StateError)
			return nil, fmt.Errorf("modem init: AT+CMGF=0 (PDU mode) failed: %w", err2)
		}
		textMode = false
	}

	// Phase 4: Query modem identification.
	info, err := queryModemInfo(m)
	if err != nil {
		m.SetState(StateError)
		return nil, fmt.Errorf("modem init: identification query failed: %w", err)
	}

	// Phase 5: Compatibility check.
	if !isKnownModel(info.Model) {
		info.UnsupportedWarning = fmt.Sprintf("modem model %q is not in the list of known-supported devices; operation may be unreliable", info.Model)
		slog.Warn("Unrecognized modem model", "model", info.Model, "warning", info.UnsupportedWarning)
	}

	// Transition to ready state.
	m.SetState(StateReady)

	slog.Info("Modem initialization complete",
		"model", info.Model,
		"manufacturer", info.Manufacturer,
		"firmware", info.Firmware,
		"textMode", textMode,
	)

	return &InitResult{
		Info:               info,
		TextMode:           textMode,
		CNMIDeliveryStatus: cnmiDS,
	}, nil
}

// detectModem attempts to contact the modem with ATE0 (disable echo).
// If the command fails, it retries with exponential backoff (2s → 30s)
// until success or context cancellation.
func detectModem(ctx context.Context, m *Modem) error {
	backoff := initBackoffMin

	for {
		_, err := m.SendCommand("ATE0", DefaultTimeout)
		if err == nil {
			return nil
		}

		slog.Warn("Modem not responding, retrying with backoff",
			"error", err,
			"backoff", backoff,
		)

		// Wait with backoff or context cancellation.
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fmt.Errorf("cancelled while waiting for modem: %w", ctx.Err())
		case <-timer.C:
		}

		// Double the backoff, capped at max.
		backoff *= 2
		if backoff > initBackoffMax {
			backoff = initBackoffMax
		}
	}
}

// queryModemInfo queries modem identification: model, manufacturer, and firmware version.
func queryModemInfo(m *Modem) (ModemInfo, error) {
	model, err := m.SendCommand("AT+CGMM", 0)
	if err != nil {
		return ModemInfo{}, fmt.Errorf("AT+CGMM (model): %w", err)
	}

	manufacturer, err := m.SendCommand("AT+CGMI", 0)
	if err != nil {
		return ModemInfo{}, fmt.Errorf("AT+CGMI (manufacturer): %w", err)
	}

	firmware, err := m.SendCommand("AT+CGMR", 0)
	if err != nil {
		return ModemInfo{}, fmt.Errorf("AT+CGMR (firmware): %w", err)
	}

	return ModemInfo{
		Model:        strings.TrimSpace(model),
		Manufacturer: strings.TrimSpace(manufacturer),
		Firmware:     strings.TrimSpace(firmware),
	}, nil
}

// isKnownModel checks whether the model string starts with a known-supported prefix.
// Matching is case-insensitive.
func isKnownModel(model string) bool {
	upper := strings.ToUpper(strings.TrimSpace(model))
	for _, pattern := range knownModemPatterns {
		if strings.HasPrefix(upper, strings.ToUpper(pattern)) {
			return true
		}
	}
	return false
}
