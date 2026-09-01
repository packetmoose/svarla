package signaling

import (
	"context"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// statusInterval is the period between status queries.
	statusInterval = 30 * time.Second

	// statusQueryTimeout is the maximum time to wait for a single AT status query.
	statusQueryTimeout = 5 * time.Second
)

// StatusPayload is the payload sent in a "status" signaling message.
type StatusPayload struct {
	Type                    string   `json:"type"`
	Signal                  int      `json:"signal"`
	Network                 string   `json:"network"`
	Operator                string   `json:"operator"`
	ModemModel              string   `json:"modemModel,omitempty"`
	ModemManufacturer       string   `json:"modemManufacturer,omitempty"`
	Firmware                string   `json:"firmware,omitempty"`
	Stale                   []string `json:"stale,omitempty"`
	ModemUnsupportedWarning string   `json:"modemUnsupportedWarning,omitempty"`
}

// ModemCommander is the interface required by StatusReporter for sending AT commands.
// It is satisfied by *modem.Modem.
type ModemCommander interface {
	SendCommand(cmd string, timeout time.Duration) (string, error)
}

// StatusSender is the interface required by StatusReporter for sending signaling messages.
// It is satisfied by *Client.
type StatusSender interface {
	Send(msg Message) error
}

// ModemInfo holds static modem identification data for status reports.
type ModemInfo struct {
	Model              string
	Manufacturer       string
	Firmware           string
	UnsupportedWarning string
}

// StatusReporter periodically queries the modem for signal, network registration,
// and operator information, then sends a status message via the signaling client.
type StatusReporter struct {
	modem     ModemCommander
	client    StatusSender
	modemInfo ModemInfo

	mu         sync.Mutex
	lastSignal int
	lastNet    string
	lastOp     string

	cancel context.CancelFunc
	done   chan struct{}
}

// NewStatusReporter creates a new StatusReporter.
func NewStatusReporter(modem ModemCommander, client StatusSender, info ModemInfo) *StatusReporter {
	return &StatusReporter{
		modem:      modem,
		client:     client,
		modemInfo:  info,
		lastSignal: 99, // unknown
		lastNet:    "unknown",
		lastOp:     "",
		done:       make(chan struct{}),
	}
}

// Start begins the periodic status reporting cycle. It sends an immediate status
// report (including modem identification info), then queries every 30 seconds.
// The provided context can be used for parent cancellation.
func (sr *StatusReporter) Start(ctx context.Context) {
	ctx, sr.cancel = context.WithCancel(ctx)

	go sr.run(ctx)
}

// Stop halts the periodic status reporting.
func (sr *StatusReporter) Stop() {
	if sr.cancel != nil {
		sr.cancel()
	}
	<-sr.done
}

func (sr *StatusReporter) run(ctx context.Context) {
	defer close(sr.done)

	// Send immediate initial status with modem info.
	sr.reportStatus(true)

	ticker := time.NewTicker(statusInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sr.reportStatus(false)
		}
	}
}

// reportStatus queries the modem and sends a status message.
// If initial is true, modem identification fields are included.
func (sr *StatusReporter) reportStatus(initial bool) {
	signal, network, operator, stale := sr.queryAll()

	payload := StatusPayload{
		Type:     TypeStatus,
		Signal:   signal,
		Network:  network,
		Operator: operator,
	}

	if len(stale) > 0 {
		payload.Stale = stale
	}

	if initial {
		payload.ModemModel = sr.modemInfo.Model
		payload.ModemManufacturer = sr.modemInfo.Manufacturer
		payload.Firmware = sr.modemInfo.Firmware
		if sr.modemInfo.UnsupportedWarning != "" {
			payload.ModemUnsupportedWarning = sr.modemInfo.UnsupportedWarning
		}
	}

	msg, err := NewMessage(TypeStatus, payload)
	if err != nil {
		slog.Error("Failed to create status message", "error", err)
		return
	}

	if err := sr.client.Send(msg); err != nil {
		slog.Warn("Failed to send status message", "error", err)
	}
}

// queryAll queries AT+CSQ, AT+CREG, and AT+COPS with a 5-second timeout each.
// If a query times out or fails, the last known value is used and the field is
// marked as stale.
func (sr *StatusReporter) queryAll() (signal int, network string, operator string, stale []string) {
	sr.mu.Lock()
	defer sr.mu.Unlock()

	// Query signal strength.
	sig, err := sr.querySignal()
	if err != nil {
		slog.Warn("Status query AT+CSQ failed, using last known value", "error", err)
		sig = sr.lastSignal
		stale = append(stale, "signal")
	} else {
		sr.lastSignal = sig
	}

	// Query network registration.
	net, err := sr.queryNetwork()
	if err != nil {
		slog.Warn("Status query AT+CREG failed, using last known value", "error", err)
		net = sr.lastNet
		stale = append(stale, "network")
	} else {
		sr.lastNet = net
	}

	// Query operator.
	op, err := sr.queryOperator()
	if err != nil {
		slog.Warn("Status query AT+COPS failed, using last known value", "error", err)
		op = sr.lastOp
		stale = append(stale, "operator")
	} else {
		sr.lastOp = op
	}

	// If the modem reports measurable signal but network status is "unknown" (CREG stat 4),
	// it likely means the modem sees a cell tower but hasn't completed registration yet.
	// Report "searching" which is more informative than "unknown" for the user.
	if net == "unknown" && sig > 0 {
		net = "searching"
	}

	return sig, net, op, stale
}

// querySignal sends AT+CSQ and parses the signal strength value (0-31).
// The raw CSQ value 99 means "not known or not detectable" and is mapped to 0
// so that clients don't misinterpret it as a high percentage.
// Response format: +CSQ: <rssi>,<ber>
func (sr *StatusReporter) querySignal() (int, error) {
	resp, err := sr.modem.SendCommand("AT+CSQ", statusQueryTimeout)
	if err != nil {
		return 0, err
	}

	val := parseCSQ(resp)
	if val == 99 {
		return 0, nil
	}
	return val, nil
}

// queryNetwork sends AT+CREG? and parses the registration status.
// Response format: +CREG: <n>,<stat>[,<lac>,<ci>]
func (sr *StatusReporter) queryNetwork() (string, error) {
	resp, err := sr.modem.SendCommand("AT+CREG?", statusQueryTimeout)
	if err != nil {
		return "", err
	}

	return parseCREG(resp), nil
}

// queryOperator sends AT+COPS? and parses the operator name.
// Response format: +COPS: <mode>,<format>,"<operator>"[,<AcT>]
func (sr *StatusReporter) queryOperator() (string, error) {
	resp, err := sr.modem.SendCommand("AT+COPS?", statusQueryTimeout)
	if err != nil {
		return "", err
	}

	return parseCOPS(resp), nil
}

// parseCSQ extracts the RSSI value from an AT+CSQ response.
// Returns 99 (unknown) if parsing fails.
func parseCSQ(resp string) int {
	// Look for the +CSQ: line.
	for _, line := range strings.Split(resp, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "+CSQ:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "+CSQ:"))
		// Format: <rssi>,<ber>
		parts := strings.SplitN(data, ",", 2)
		if len(parts) < 1 {
			return 99
		}
		val, err := strconv.Atoi(strings.TrimSpace(parts[0]))
		if err != nil {
			return 99
		}
		return val
	}

	// If no +CSQ: prefix, try parsing the raw response (some modems return just the values).
	parts := strings.SplitN(strings.TrimSpace(resp), ",", 2)
	if len(parts) >= 1 {
		val, err := strconv.Atoi(strings.TrimSpace(parts[0]))
		if err == nil && val >= 0 && val <= 99 {
			return val
		}
	}

	return 99
}

// parseCREG extracts the registration status from an AT+CREG? response.
// Maps stat values to human-readable strings:
//
//	0 = not_registered, 1 = registered, 2 = searching,
//	3 = denied, 4 = unknown, 5 = roaming
func parseCREG(resp string) string {
	// Look for the +CREG: line.
	for _, line := range strings.Split(resp, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "+CREG:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "+CREG:"))
		// Format: <n>,<stat>[,<lac>,<ci>]
		parts := strings.Split(data, ",")
		if len(parts) < 2 {
			// Some modems return just <stat> without <n>.
			if len(parts) == 1 {
				return cregStatToString(parts[0])
			}
			return "unknown"
		}
		return cregStatToString(parts[1])
	}

	return "unknown"
}

// cregStatToString converts a CREG stat integer string to a human-readable status.
func cregStatToString(s string) string {
	switch strings.TrimSpace(s) {
	case "0":
		return "not_registered"
	case "1":
		return "registered"
	case "2":
		return "searching"
	case "3":
		return "denied"
	case "4":
		return "unknown"
	case "5":
		return "roaming"
	default:
		return "unknown"
	}
}

// parseCOPS extracts the operator name from an AT+COPS? response.
// Response format: +COPS: <mode>,<format>,"<operator>"[,<AcT>]
// Returns empty string if not registered or parsing fails.
func parseCOPS(resp string) string {
	// Look for the +COPS: line.
	for _, line := range strings.Split(resp, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "+COPS:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "+COPS:"))
		// Extract quoted operator name.
		start := strings.Index(data, "\"")
		if start < 0 {
			return ""
		}
		end := strings.Index(data[start+1:], "\"")
		if end < 0 {
			return ""
		}
		return data[start+1 : start+1+end]
	}

	return ""
}
