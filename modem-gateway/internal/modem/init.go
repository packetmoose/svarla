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
	Info ModemInfo
}

// RunInitSequence performs the modem initialization sequence:
//  1. Detect modem presence (ATE0 with exponential backoff)
//  2. Configure modem settings (verbose results, caller ID, DTMF, SMS notifications)
//  3. Set SMS PDU mode (AT+CMGF=0) — all SMS encoding/decoding is done in-process
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
	//
	// The <mt>=1 mode stores each new SMS and emits a +CMTI indication rather
	// than routing the message body directly to the TE (<mt>=2). This is
	// deliberate and load-bearing for durability: because delivery is stored
	// first, the network/SMSC acknowledgement is tied to successful storage. If
	// SIM/modem storage is full the message is not stored, no +CMTI is emitted,
	// and the SMSC holds the message and retries later — so a full buffer
	// degrades to "delivered later" rather than a lost message. Do not switch
	// to <mt>=2 (direct-to-TE) without providing an equivalent durability path.
	//
	// We route new incoming SMS via +CMTI and explicitly disable delivery-report
	// routing (<ds>=0). Delivery/status reports are not used: the SIM7600G-H
	// rejects live +CDS push (<ds>=1) and its stored reports (+CDSI) are not
	// retrievable — the "SR" storage always reports zero used entries and
	// AT+CMGR returns "Invalid memory index". Requesting them only produced
	// useless churn, so we neither request (no TP-SRR) nor route them.
	cnmiCmds := []string{
		"AT+CNMI=2,1,0,0,0", // +CMTI for new SMS, no delivery-report routing
		"AT+CNMI=2,1,0",     // shorter form for firmware that rejects the 5-arg variant
	}
	cnmiOK := false
	for _, cmd := range cnmiCmds {
		if _, err := m.SendCommand(cmd, 0); err == nil {
			slog.Info("SMS notification routing configured", "cmd", cmd)
			cnmiOK = true
			break
		}
	}
	if !cnmiOK {
		slog.Warn("AT+CNMI configuration failed — incoming SMS notifications may not work")
	}

	// Phase 3: SMS PDU mode (AT+CMGF=0). We build and parse SMS PDUs in-process
	// (see internal/sms), which gives full control over GSM-7/UCS-2 encoding and
	// concatenation and avoids the modem text-mode charset ambiguities. PDU mode
	// is required; if it fails, SMS cannot work correctly, so this is fatal.
	if _, err := m.SendCommand("AT+CMGF=0", 0); err != nil {
		m.SetState(StateError)
		return nil, fmt.Errorf("modem init: AT+CMGF=0 (PDU mode) failed: %w", err)
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
		"smsMode", "PDU",
	)

	return &InitResult{
		Info: info,
	}, nil
}

// detectModem attempts to contact the modem with ATE0 (disable echo).
// If the command fails, it retries with exponential backoff (2s → 30s)
// until success or context cancellation.
//
// Before the first attempt, an ESC byte (0x1B) is written to the serial port
// to abort any pending text input mode (e.g. from a previous AT+CMGS that
// timed out). This is a no-op if the modem is already in command mode.
func detectModem(ctx context.Context, m *Modem) error {
	// Send ESC to escape any lingering text input mode from a prior session.
	// If the modem is in command mode, ESC is harmless (ignored or returns ERROR).
	m.WriteRaw([]byte{0x1B, '\r', '\n'})
	// Brief pause so the modem processes ESC and emits any response before
	// we flush and attempt ATE0.
	time.Sleep(200 * time.Millisecond)

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
