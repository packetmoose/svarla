package signaling

import (
	"context"
	"log/slog"
	"math"
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
	Band                    string   `json:"band,omitempty"`
	NetworkTech             string   `json:"networkTech,omitempty"`
	ModemModel              string   `json:"modemModel,omitempty"`
	ModemManufacturer       string   `json:"modemManufacturer,omitempty"`
	Firmware                string   `json:"firmware,omitempty"`
	IMEI                    string   `json:"imei,omitempty"`
	IMSI                    string   `json:"imsi,omitempty"`
	ICCID                   string   `json:"iccid,omitempty"`
	MSISDN                  string   `json:"msisdn,omitempty"`
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
	IMEI               string
	IMSI               string
	ICCID              string
	MSISDN             string
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
		lastSignal: 0, // unknown (signal is a percentage; 0 = no/unknown signal)
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
	signal, network, operator, band, networkTech, stale := sr.queryAll()

	payload := StatusPayload{
		Type:        TypeStatus,
		Signal:      signal,
		Network:     network,
		Operator:    operator,
		Band:        band,
		NetworkTech: networkTech,
	}

	if len(stale) > 0 {
		payload.Stale = stale
	}

	if initial {
		payload.ModemModel = sr.modemInfo.Model
		payload.ModemManufacturer = sr.modemInfo.Manufacturer
		payload.Firmware = sr.modemInfo.Firmware
		payload.IMEI = sr.modemInfo.IMEI
		payload.IMSI = sr.modemInfo.IMSI
		payload.ICCID = sr.modemInfo.ICCID
		payload.MSISDN = sr.modemInfo.MSISDN
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
func (sr *StatusReporter) queryAll() (signal int, network string, operator string, band string, tech string, stale []string) {
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

	// Query band and radio access technology (best-effort). AT+CPSI? is a SIMCOM
	// command that returns the current system mode and serving-cell band. It is
	// non-critical: on failure or when the modem is not registered, band and RAT
	// are simply left empty and are NOT marked stale.
	band, tech = sr.queryBandTech()

	return sig, net, op, band, tech, stale
}

// queryBandTech sends AT+CPSI? and extracts the radio access technology and band.
// Returns empty strings on failure or when the modem reports no service.
func (sr *StatusReporter) queryBandTech() (band string, tech string) {
	resp, err := sr.modem.SendCommand("AT+CPSI?", statusQueryTimeout)
	if err != nil {
		slog.Debug("Status query AT+CPSI? failed, band/tech unavailable", "error", err)
		return "", ""
	}
	tech, band = parseCPSI(resp)
	return band, tech
}

// querySignal sends AT+CSQ, parses the raw RSSI value (0-31), and converts it to
// a percentage (0-100) for reporting.
//
// AT+CSQ returns an RSSI index on the 3GPP 0-31 scale (0 = weakest, 31 = strongest)
// plus the special value 99 meaning "not known or not detectable". We convert to a
// percentage so clients can display it directly; 99 (and any parse failure) maps to
// 0, which the UI treats as "no signal".
// Response format: +CSQ: <rssi>,<ber>
func (sr *StatusReporter) querySignal() (int, error) {
	resp, err := sr.modem.SendCommand("AT+CSQ", statusQueryTimeout)
	if err != nil {
		return 0, err
	}

	return csqToPercent(parseCSQ(resp)), nil
}

// csqToPercent converts a raw AT+CSQ RSSI index (0-31, or 99 = unknown) to a
// percentage (0-100). Unknown or out-of-range values map to 0.
func csqToPercent(csq int) int {
	if csq < 0 || csq > 31 {
		return 0
	}
	return int(math.Round(float64(csq) / 31.0 * 100.0))
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

// parseCPSI extracts the radio access technology and serving-cell band from a
// SIMCOM AT+CPSI? response.
//
// Response formats (SIM7600 family):
//
//	LTE:  +CPSI: LTE,Online,<MCC-MNC>,<TAC>,<SCellID>,<PCID>,<BAND>,<freq>,...
//	      e.g. +CPSI: LTE,Online,240-01,0x000B,12345678,257,EUTRAN-BAND3,1300,5,...
//	GSM:  +CPSI: GSM,Online,<MCC-MNC>,<LAC>,<CellID>,<BSIC>,<ARFCN>,...
//	None: +CPSI: NO SERVICE,Online  (or just +CPSI: NO SERVICE)
//
// Returns (tech, band). Either may be empty when unavailable. The band is
// recognized as the field containing a "BAND" token (e.g. "EUTRAN-BAND3").
func parseCPSI(resp string) (tech string, band string) {
	for _, line := range strings.Split(resp, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "+CPSI:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "+CPSI:"))
		parts := strings.Split(data, ",")
		if len(parts) == 0 {
			return "", ""
		}

		tech = strings.TrimSpace(parts[0])
		if strings.EqualFold(tech, "NO SERVICE") || tech == "" {
			return "", ""
		}

		// Find the band field: the token containing "BAND" (case-insensitive),
		// e.g. "EUTRAN-BAND3" or "LTE BAND 3". Normalize to a friendly form.
		for _, p := range parts[1:] {
			p = strings.TrimSpace(p)
			if strings.Contains(strings.ToUpper(p), "BAND") {
				band = normalizeBand(p)
				break
			}
		}

		return tech, band
	}

	return "", ""
}

// normalizeBand converts a known modem band token into a friendlier display
// form, e.g. "EUTRAN-BAND3" -> "B3", "LTE BAND 3" -> "B3".
//
// Only recognized patterns are rewritten. Any other token is returned as the
// original trimmed string, unchanged (including its original casing), so that
// bands from modems/RATs we haven't special-cased (e.g. 5G "NR5G-BANDxx") are
// still shown verbatim rather than being dropped or mangled.
func normalizeBand(raw string) string {
	trimmed := strings.TrimSpace(raw)
	up := strings.ToUpper(trimmed)

	replacements := []struct{ old, new string }{
		{"EUTRAN-BAND", "B"},
		{"EUTRAN BAND", "B"},
		{"LTE BAND ", "B"},
		{"LTE-BAND", "B"},
		{"BAND ", "B"},
	}
	for _, r := range replacements {
		if strings.Contains(up, r.old) {
			return strings.TrimSpace(strings.ReplaceAll(up, r.old, r.new))
		}
	}

	// Unrecognized format: show exactly what the modem reported.
	return trimmed
}
