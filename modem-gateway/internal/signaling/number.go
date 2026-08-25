package signaling

import (
	"fmt"
	"log/slog"
	"regexp"
	"strings"

	"github.com/packetmoose/svarla/modem-gateway/internal/config"
	"github.com/packetmoose/svarla/modem-gateway/internal/modem"
)

// NumberReportPayload is the payload for number_report messages sent to Svarla.
type NumberReportPayload struct {
	Type         string   `json:"type"`
	Number       string   `json:"number,omitempty"`
	Capabilities []string `json:"capabilities"`
	Unavailable  bool     `json:"unavailable,omitempty"`
}

// NumberReporter discovers the SIM phone number and reports it to the Svarla
// server on each connection or reconnection.
type NumberReporter struct {
	modem  *modem.Modem
	client MessageSender
	config *config.Config

	// cachedNumber stores the last discovered number to avoid re-querying.
	cachedNumber string
}

// NewNumberReporter creates a new NumberReporter.
func NewNumberReporter(m *modem.Modem, client MessageSender, cfg *config.Config) *NumberReporter {
	return &NumberReporter{
		modem:  m,
		client: client,
		config: cfg,
	}
}

// Discover attempts to determine the SIM phone number.
// It first tries AT+CNUM; if that fails or returns no number, it falls
// back to the phoneNumber field in the modem configuration.
// Returns the number in E.164 format or an empty string if unavailable.
func (nr *NumberReporter) Discover() (string, error) {
	// Try AT+CNUM first.
	number, err := nr.queryATCNUM()
	if err != nil {
		slog.Debug("AT+CNUM query failed, falling back to config", "error", err)
	}

	if number != "" {
		nr.cachedNumber = number
		slog.Info("Phone number discovered via AT+CNUM", "number", number)
		return number, nil
	}

	// Fall back to config field.
	if nr.config.Modem.PhoneNumber != "" {
		nr.cachedNumber = nr.config.Modem.PhoneNumber
		slog.Info("Phone number from configuration", "number", nr.cachedNumber)
		return nr.cachedNumber, nil
	}

	slog.Warn("No phone number available (AT+CNUM returned nothing, no config override)")
	nr.cachedNumber = ""
	return "", nil
}

// Report sends a number_report message to the Svarla server with the current
// discovered number and capabilities. If no number is available, it sends
// a number_unavailable report.
func (nr *NumberReporter) Report() error {
	payload := nr.buildPayload()

	msg, err := NewMessage(TypeNumberReport, payload)
	if err != nil {
		return fmt.Errorf("number reporter: failed to build message: %w", err)
	}

	if err := nr.client.Send(msg); err != nil {
		return fmt.Errorf("number reporter: failed to send: %w", err)
	}

	if payload.Unavailable {
		slog.Info("Reported number unavailable to server")
	} else {
		slog.Info("Reported number to server", "number", payload.Number, "capabilities", payload.Capabilities)
	}

	return nil
}

// ReportOnConnect discovers the number (if not already cached) and reports
// it to the server. This should be called after each successful connection
// or reconnection.
func (nr *NumberReporter) ReportOnConnect() {
	// Re-discover on each connect in case the SIM changed.
	_, err := nr.Discover()
	if err != nil {
		slog.Error("Number discovery failed on connect", "error", err)
	}

	if err := nr.Report(); err != nil {
		slog.Error("Number report failed on connect", "error", err)
	}
}

// buildPayload constructs the NumberReportPayload based on current state.
func (nr *NumberReporter) buildPayload() NumberReportPayload {
	capabilities := nr.determineCapabilities()

	if nr.cachedNumber == "" {
		return NumberReportPayload{
			Type:         TypeNumberReport,
			Capabilities: capabilities,
			Unavailable:  true,
		}
	}

	return NumberReportPayload{
		Type:         TypeNumberReport,
		Number:       nr.cachedNumber,
		Capabilities: capabilities,
	}
}

// determineCapabilities returns the list of capabilities this modem supports.
// SMS is always available when the modem is connected.
// VOICE is available when voiceEnabled is true AND a PCM audio port is configured/available.
func (nr *NumberReporter) determineCapabilities() []string {
	caps := []string{"SMS"}

	if nr.config.IsVoiceEnabled() && nr.config.Modem.PcmAudioPort != "" {
		caps = append(caps, "VOICE")
	}

	return caps
}

// cnumRegex parses the AT+CNUM response format: +CNUM: "<name>","<number>",<type>
// The name field may be empty. The number should be in E.164 format.
var cnumRegex = regexp.MustCompile(`\+CNUM:\s*"[^"]*",\s*"([^"]+)",\s*\d+`)

// queryATCNUM sends AT+CNUM to the modem and parses the response to extract
// the subscriber number. Returns empty string if no number is found.
func (nr *NumberReporter) queryATCNUM() (string, error) {
	resp, err := nr.modem.SendCommand("AT+CNUM", 0)
	if err != nil {
		return "", fmt.Errorf("AT+CNUM failed: %w", err)
	}

	// Response may contain multiple lines; find the +CNUM line.
	for _, line := range strings.Split(resp, "\n") {
		line = strings.TrimSpace(line)
		matches := cnumRegex.FindStringSubmatch(line)
		if matches != nil && len(matches) >= 2 {
			number := strings.TrimSpace(matches[1])
			if number != "" {
				return number, nil
			}
		}
	}

	return "", nil
}
