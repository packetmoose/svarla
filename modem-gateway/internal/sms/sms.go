// Package sms handles SMS send and receive operations via AT commands,
// including concatenated SMS reassembly and UCS-2 encoding support.
package sms

import (
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/packetmoose/svarla/modem-gateway/internal/modem"
)

// SendTimeout is the timeout for AT+CMGS commands (60 seconds).
const SendTimeout = 60 * time.Second

// IncomingSMS represents a received SMS message.
type IncomingSMS struct {
	// MessageID is a unique identifier for this message (storage index).
	MessageID string
	// From is the sender's phone number.
	From string
	// To is the recipient's phone number (may be empty if not available from modem).
	To string
	// Body is the message text content.
	Body string
	// Timestamp is when the message was sent/received.
	Timestamp time.Time
	// Multipart is true if this message is part of a concatenated SMS
	// (detected via the UDHI bit in the TP first-octet). Not serialized.
	Multipart bool `json:"-"`
}

// DeliveryReport represents an SMS delivery status report.
type DeliveryReport struct {
	// MessageRef is the message reference from the original send.
	MessageRef int
	// Status is the delivery status (e.g., "DELIVERED", "FAILED").
	Status string
}

// drainedMsg holds a message read during boot drain along with its storage index.
type drainedMsg struct {
	msg   IncomingSMS
	index int
}

// concatWindow is how long to wait for additional parts of a multi-part SMS
// received via live +CMTI notifications before flushing what we have.
const concatWindow = 5 * time.Second

// pendingConcat buffers parts of a multi-part SMS being received live, grouped
// by sender, since the SIM7600 in text mode does not expose UDH ref/seq numbers.
type pendingConcat struct {
	parts     []IncomingSMS
	timer     *time.Timer
	firstSeen time.Time
}

// Manager handles SMS send and receive operations using the modem.
type Manager struct {
	modem    *modem.Modem
	textMode bool

	reassembler *Reassembler

	mu               sync.RWMutex
	receivedHandlers []func(IncomingSMS)
	deliveryHandlers []func(DeliveryReport)

	// concatMu protects the live multi-part reassembly buffer.
	concatMu      sync.Mutex
	pendingConcat map[string]*pendingConcat
}

// New creates a new SMS Manager.
// textMode should be true if AT+CMGF=1 succeeded during modem initialization.
func New(m *modem.Modem, textMode bool) *Manager {
	return &Manager{
		modem:         m,
		textMode:      textMode,
		reassembler:   NewReassembler(0), // Use default 5-minute stale timeout
		pendingConcat: make(map[string]*pendingConcat),
	}
}

// Send sends an SMS message to the specified number.
// In text mode, it uses AT+CMGS with the message body terminated by Ctrl-Z.
// Returns the message reference number on success, or an error with reason.
func (mgr *Manager) Send(to, body string) (int, error) {
	if !mgr.textMode {
		return 0, fmt.Errorf("sms: PDU mode send not yet implemented")
	}

	return mgr.sendTextMode(to, body)
}

// sendTextMode sends an SMS in text mode via AT+CMGS.
// Uses two-phase sending: first sends AT+CMGS="number" to enter text input
// mode, waits for the ">" prompt, then sends the message body + Ctrl-Z.
//
// If the message body contains characters outside GSM-7, the Data Coding Scheme
// is set to UCS-2 (0x08) via AT+CSCS and AT+CSMP before sending.
func (mgr *Manager) sendTextMode(to, body string) (int, error) {
	useUCS2 := NeedsUCS2(body)

	if useUCS2 {
		// Switch character set to UCS2 for the modem to interpret the message.
		if _, err := mgr.modem.SendCommand("AT+CSCS=\"UCS2\"", 0); err != nil {
			slog.Warn("Failed to set character set to UCS2", "error", err)
		}

		// Set Data Coding Scheme to UCS-2 (0x08) via AT+CSMP.
		// Format: AT+CSMP=<fo>,<vp>,<pid>,<dcs>
		// fo=49 (submit, request delivery report), vp=167 (24h), pid=0, dcs=8 (UCS-2)
		if _, err := mgr.modem.SendCommand("AT+CSMP=49,167,0,8", 0); err != nil {
			slog.Warn("Failed to set CSMP for UCS-2", "error", err)
		}

		// Encode the body and recipient as UCS-2 hex strings.
		ucs2Body := encodeUCS2Hex(body)
		ucs2To := encodeUCS2Hex(to)
		header := fmt.Sprintf("AT+CMGS=\"%s\"", ucs2To)

		resp, err := mgr.modem.SendSMSCommand(header, ucs2Body, SendTimeout)

		// Restore GSM character set and DCS after sending.
		mgr.restoreGSMSettings()

		if err != nil {
			return 0, fmt.Errorf("sms: send failed (UCS-2): %w", err)
		}

		ref, parseErr := parseCMGSResponse(resp)
		if parseErr != nil {
			return 0, fmt.Errorf("sms: send succeeded but could not parse reference: %w", parseErr)
		}

		return ref, nil
	}

	// GSM-7 send: standard text mode.
	header := fmt.Sprintf("AT+CMGS=\"%s\"", to)

	resp, err := mgr.modem.SendSMSCommand(header, body, SendTimeout)
	if err != nil {
		return 0, fmt.Errorf("sms: send failed: %w", err)
	}

	// Parse the response for +CMGS: <ref>
	ref, parseErr := parseCMGSResponse(resp)
	if parseErr != nil {
		return 0, fmt.Errorf("sms: send succeeded but could not parse reference: %w", parseErr)
	}

	return ref, nil
}

// cmgsRefRegex matches "+CMGS: <number>" in the modem response.
var cmgsRefRegex = regexp.MustCompile(`\+CMGS:\s*(\d+)`)

// parseCMGSResponse extracts the message reference number from a +CMGS response.
func parseCMGSResponse(resp string) (int, error) {
	matches := cmgsRefRegex.FindStringSubmatch(resp)
	if matches == nil {
		return 0, fmt.Errorf("no +CMGS reference found in response: %q", resp)
	}

	ref, err := strconv.Atoi(matches[1])
	if err != nil {
		return 0, fmt.Errorf("invalid +CMGS reference %q: %w", matches[1], err)
	}

	return ref, nil
}

// encodeUCS2Hex encodes a string as UCS-2 and returns the hex representation.
// This is used for sending UCS-2 encoded SMS in text mode where the modem
// expects hex-encoded UCS-2 characters.
func encodeUCS2Hex(text string) string {
	data := EncodeUCS2(text)
	hex := ""
	for _, b := range data {
		hex += fmt.Sprintf("%02X", b)
	}
	return hex
}

// restoreGSMSettings restores the modem character set and DCS to GSM defaults
// after a UCS-2 send operation.
func (mgr *Manager) restoreGSMSettings() {
	if _, err := mgr.modem.SendCommand("AT+CSCS=\"GSM\"", 0); err != nil {
		slog.Warn("Failed to restore character set to GSM", "error", err)
	}
	// Restore DCS to GSM-7 (0x00) with delivery report request.
	// fo=49 (submit, request delivery report), vp=167 (24h), pid=0, dcs=0 (GSM-7)
	if _, err := mgr.modem.SendCommand("AT+CSMP=49,167,0,0", 0); err != nil {
		slog.Warn("Failed to restore CSMP for GSM-7", "error", err)
	}
}

// ConfigureDeliveryReports configures the modem to request delivery reports
// for outgoing SMS messages via AT+CSMP.
// This should be called during modem initialization after SMS text mode is set.
// Format: AT+CSMP=<fo>,<vp>,<pid>,<dcs>
// fo=49: SMS-SUBMIT with status report request (bit 5 set = TP-SRR)
// vp=167: validity period = 24 hours (relative format)
// pid=0: protocol identifier (default)
// dcs=0: data coding scheme (GSM-7 default)
func (mgr *Manager) ConfigureDeliveryReports() error {
	_, err := mgr.modem.SendCommand("AT+CSMP=49,167,0,0", 0)
	if err != nil {
		return fmt.Errorf("sms: failed to configure delivery reports via AT+CSMP: %w", err)
	}
	slog.Debug("Delivery reports configured via AT+CSMP")
	return nil
}

// DrainStoredMessages reads all messages stored on the SIM/modem, delivers them
// to registered handlers, and deletes them from storage. This should be called
// once during initialization (after handlers are registered) to process any
// messages that arrived while the gateway was offline, and to clear stale
// messages that would otherwise trigger duplicate +CMTI/+CDSI notifications.
//
// It lists messages from both "SM" (SIM) and "ME" (modem) storage using
// AT+CMGL="ALL", reads each individually with AT+CMGR (which enables
// concatenation reassembly), processes them, and deletes with AT+CMGD.
func (mgr *Manager) DrainStoredMessages() {
	if !mgr.textMode {
		return
	}

	storages := []string{"SM", "ME", "SR"}
	totalDrained := 0

	for _, storage := range storages {
		// Select storage for reading.
		cmd := fmt.Sprintf("AT+CPMS=\"%s\"", storage)
		if _, err := mgr.modem.SendCommand(cmd, 0); err != nil {
			slog.Debug("Cannot select storage for drain, skipping", "storage", storage, "error", err)
			continue
		}

		// List all messages to get their indices.
		resp, err := mgr.modem.SendCommand("AT+CMGL=\"ALL\"", 0)
		if err != nil {
			slog.Debug("AT+CMGL failed for storage, skipping", "storage", storage, "error", err)
			continue
		}

		if strings.TrimSpace(resp) == "" {
			continue
		}

		// Extract indices from CMGL response.
		lines := strings.Split(resp, "\n")
		var indices []int
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "+CMGL:") {
				continue
			}
			afterPrefix := strings.TrimPrefix(line, "+CMGL:")
			parts := strings.SplitN(strings.TrimSpace(afterPrefix), ",", 2)
			if len(parts) < 1 {
				continue
			}
			index, err := strconv.Atoi(strings.TrimSpace(parts[0]))
			if err != nil {
				continue
			}
			indices = append(indices, index)
		}

		if len(indices) == 0 {
			continue
		}

		slog.Info("Draining stored messages", "storage", storage, "count", len(indices))

		// Read each message individually.
		var messages []drainedMsg

		for _, idx := range indices {
			msg, concatInfo, err := mgr.readMessageWithConcat(idx)
			if err != nil {
				slog.Warn("Failed to read stored message during drain", "storage", storage, "index", idx, "error", err)
				// Still try to delete it so we don't loop on a corrupt message.
				mgr.modem.SendCommand(fmt.Sprintf("AT+CMGD=%d", idx), 0)
				continue
			}

			// Delete from storage after successful read.
			if _, err := mgr.modem.SendCommand(fmt.Sprintf("AT+CMGD=%d", idx), 0); err != nil {
				slog.Warn("Failed to delete drained message", "storage", storage, "index", idx, "error", err)
			}

			// If UDH-based concatenation info is available, use the reassembler.
			if concatInfo != nil {
				slog.Debug("Drain: concatenated SMS part (UDH)",
					"refNum", concatInfo.RefNum,
					"seqNum", concatInfo.SeqNum,
					"totalParts", concatInfo.TotalParts,
					"from", msg.From,
				)

				complete, assembled := mgr.reassembler.AddPart(
					msg.From,
					concatInfo.RefNum,
					concatInfo.SeqNum,
					concatInfo.TotalParts,
					msg.Body,
				)

				if !complete {
					continue
				}

				msg.Body = assembled
				messages = append(messages, drainedMsg{msg: msg, index: idx})
				continue
			}

			messages = append(messages, drainedMsg{msg: msg, index: idx})
		}

		// Group messages by sender + timestamp (within 2 seconds) for
		// concatenation reassembly. The SIM7600 in text mode doesn't expose
		// UDH, so we use sender + timestamp proximity as a heuristic.
		// Messages with consecutive indices from the same sender within a
		// 2-second window are treated as parts of one concatenated SMS.
		delivered := groupAndDeliver(messages, mgr)
		totalDrained += delivered
	}

	if totalDrained > 0 {
		slog.Info("Boot drain complete", "totalMessages", totalDrained)
	} else {
		slog.Debug("No stored messages found during boot drain")
	}

	// Restore preferred message storage to SM so that +CMTI notifications
	// can be read correctly with AT+CMGR.
	if _, err := mgr.modem.SendCommand("AT+CPMS=\"SM\"", 0); err != nil {
		slog.Warn("Failed to restore CPMS after drain", "error", err)
	}
}

// groupAndDeliver groups drained messages by sender + timestamp proximity,
// concatenates bodies of grouped messages, and delivers to handlers.
// Returns the number of logical messages delivered.
func groupAndDeliver(messages []drainedMsg, mgr *Manager) int {
	if len(messages) == 0 {
		return 0
	}

	type group struct {
		msgs []IncomingSMS
	}

	var groups []group
	var currentGroup group

	for i, dm := range messages {
		if i == 0 {
			currentGroup.msgs = append(currentGroup.msgs, dm.msg)
			continue
		}

		prev := messages[i-1].msg
		curr := dm.msg

		// Group if same sender and timestamps within 2 seconds.
		sameGroup := prev.From == curr.From &&
			!prev.Timestamp.IsZero() && !curr.Timestamp.IsZero() &&
			absDuration(prev.Timestamp.Sub(curr.Timestamp)) <= 2*time.Second

		if sameGroup {
			currentGroup.msgs = append(currentGroup.msgs, curr)
		} else {
			groups = append(groups, currentGroup)
			currentGroup = group{msgs: []IncomingSMS{curr}}
		}
	}
	groups = append(groups, currentGroup)

	// Deliver each group as a single message.
	delivered := 0
	for _, g := range groups {
		var combined IncomingSMS
		if len(g.msgs) == 1 {
			combined = g.msgs[0]
		} else {
			// Concatenate bodies in order.
			var bodyParts []string
			for _, m := range g.msgs {
				bodyParts = append(bodyParts, m.Body)
			}
			combined = g.msgs[0]
			combined.Body = strings.Join(bodyParts, "")
			slog.Debug("Reassembled concatenated SMS from drain",
				"from", combined.From, "parts", len(g.msgs))
		}

		// Deliver (assigns a unique MessageID for server-side dedup).
		mgr.deliverIncoming(combined)
		delivered++
	}

	return delivered
}

// absDuration returns the absolute value of a time.Duration.
func absDuration(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

// OnReceived registers a handler that is called when an SMS is received.
// Multiple handlers can be registered.
func (mgr *Manager) OnReceived(handler func(IncomingSMS)) {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	mgr.receivedHandlers = append(mgr.receivedHandlers, handler)
}

// OnDeliveryReport registers a handler that is called when a delivery report is received.
// Multiple handlers can be registered.
func (mgr *Manager) OnDeliveryReport(handler func(DeliveryReport)) {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	mgr.deliveryHandlers = append(mgr.deliveryHandlers, handler)
}

// RegisterURCHandlers registers URC handlers on the modem for SMS-related URCs.
// This must be called after creating the Manager to enable SMS receive functionality.
func (mgr *Manager) RegisterURCHandlers() {
	mgr.modem.OnURC(func(urc modem.URC) {
		switch urc.Prefix {
		case "+CMTI":
			mgr.handleCMTI(urc)
		case "+CDS":
			mgr.handleCDS(urc)
		case "+CDSI":
			mgr.handleCDSI(urc)
		}
	})
}

// handleCMTI processes a +CMTI URC (new SMS arrival notification).
// It reads the message from storage, parses it, and either:
// - For single-part messages: notifies handlers directly.
// - For multi-part (concatenated) messages: adds the part to the reassembler
//   and notifies handlers only when all parts are received.
func (mgr *Manager) handleCMTI(urc modem.URC) {
	info, err := modem.ParseCMTI(urc.Data)
	if err != nil {
		slog.Error("Failed to parse +CMTI URC", "error", err, "data", urc.Data)
		return
	}

	slog.Debug("SMS arrival notification", "storage", info.Storage, "index", info.Index)

	// Read the message from storage.
	msg, concatInfo, err := mgr.readMessageWithConcat(info.Index)
	if err != nil {
		slog.Error("Failed to read SMS", "error", err, "index", info.Index)
		return
	}

	// Delete the message from storage after successful read.
	if _, err := mgr.modem.SendCommand(fmt.Sprintf("AT+CMGD=%d", info.Index), 0); err != nil {
		slog.Warn("Failed to delete read SMS from storage", "error", err, "index", info.Index)
	}

	// If UDH-based concatenation info is available (some modems expose it),
	// feed it to the reassembler for precise ordering.
	if concatInfo != nil {
		slog.Debug("Concatenated SMS part received (UDH)",
			"refNum", concatInfo.RefNum,
			"seqNum", concatInfo.SeqNum,
			"totalParts", concatInfo.TotalParts,
		)

		complete, assembled := mgr.reassembler.AddPart(
			msg.From,
			concatInfo.RefNum,
			concatInfo.SeqNum,
			concatInfo.TotalParts,
			msg.Body,
		)

		if !complete {
			// Not all parts received yet; wait for more.
			return
		}

		// All parts received — replace body with the fully assembled message.
		msg.Body = assembled
		mgr.deliverIncoming(msg)
		return
	}

	// If the modem flagged this as a multi-part message (UDHI bit) but didn't
	// expose the UDH (SIM7600 text mode), buffer it and group by sender using
	// a short time window.
	if msg.Multipart {
		mgr.bufferConcatPart(msg)
		return
	}

	// Single-part message — deliver immediately.
	mgr.deliverIncoming(msg)
}

// bufferConcatPart accumulates a part of a multi-part SMS (received live) keyed
// by sender, and flushes the concatenated result after a short window during
// which no further parts arrive.
func (mgr *Manager) bufferConcatPart(msg IncomingSMS) {
	mgr.concatMu.Lock()
	defer mgr.concatMu.Unlock()

	pc, ok := mgr.pendingConcat[msg.From]
	if !ok {
		pc = &pendingConcat{firstSeen: time.Now()}
		mgr.pendingConcat[msg.From] = pc
	}
	pc.parts = append(pc.parts, msg)

	// Reset the flush timer each time a new part arrives.
	if pc.timer != nil {
		pc.timer.Stop()
	}
	sender := msg.From
	pc.timer = time.AfterFunc(concatWindow, func() {
		mgr.flushConcat(sender)
	})
}

// flushConcat concatenates all buffered parts for a sender and delivers the
// combined message.
func (mgr *Manager) flushConcat(sender string) {
	mgr.concatMu.Lock()
	pc, ok := mgr.pendingConcat[sender]
	if !ok {
		mgr.concatMu.Unlock()
		return
	}
	delete(mgr.pendingConcat, sender)
	mgr.concatMu.Unlock()

	if len(pc.parts) == 0 {
		return
	}

	combined := pc.parts[0]
	if len(pc.parts) > 1 {
		var sb strings.Builder
		for _, p := range pc.parts {
			sb.WriteString(p.Body)
		}
		combined.Body = sb.String()
		slog.Debug("Reassembled live concatenated SMS", "from", sender, "parts", len(pc.parts))
	}

	mgr.deliverIncoming(combined)
}

// deliverIncoming notifies all registered received handlers of a message.
// It assigns a globally-unique MessageID so the server can deduplicate
// correctly (the raw storage index is reused across messages and is not unique).
func (mgr *Manager) deliverIncoming(msg IncomingSMS) {
	msg.MessageID = newMessageID()

	mgr.mu.RLock()
	handlers := make([]func(IncomingSMS), len(mgr.receivedHandlers))
	copy(handlers, mgr.receivedHandlers)
	mgr.mu.RUnlock()

	for _, h := range handlers {
		h(msg)
	}
}

// messageIDCounter provides a monotonic component for unique message IDs.
var messageIDCounter atomic.Uint64

// newMessageID generates a unique message ID for an incoming SMS.
// Format: "in-<unixNano>-<counter>".
func newMessageID() string {
	return fmt.Sprintf("in-%d-%d", time.Now().UnixNano(), messageIDCounter.Add(1))
}

// readMessage reads an SMS from modem storage at the given index.
// In text mode, the response format is:
// +CMGR: "<status>","<from>",,"<timestamp>"
// <body>
func (mgr *Manager) readMessage(index int) (IncomingSMS, error) {
	resp, err := mgr.modem.SendCommand(fmt.Sprintf("AT+CMGR=%d", index), 0)
	if err != nil {
		return IncomingSMS{}, fmt.Errorf("sms: AT+CMGR=%d failed: %w", index, err)
	}

	if !mgr.textMode {
		return IncomingSMS{}, fmt.Errorf("sms: PDU mode read not yet implemented")
	}

	return parseTextModeMessage(resp, index)
}

// ConcatInfo holds concatenation header information for a multi-part SMS.
type ConcatInfo struct {
	// RefNum is the concatenation reference number shared by all parts.
	RefNum int
	// SeqNum is the 1-based sequence number of this part.
	SeqNum int
	// TotalParts is the total number of parts in the message.
	TotalParts int
}

// readMessageWithConcat reads an SMS from modem storage and extracts
// concatenation info if present. Returns the message, optional concat info
// (nil for single-part messages), and any error.
//
// In text mode with AT+CSDH=1 (show detailed header), the modem includes
// UDH length info. We also attempt to parse UDH from the body if the modem
// includes it inline (common with AT+UDHI indications).
func (mgr *Manager) readMessageWithConcat(index int) (IncomingSMS, *ConcatInfo, error) {
	resp, err := mgr.modem.SendCommand(fmt.Sprintf("AT+CMGR=%d", index), 0)
	if err != nil {
		return IncomingSMS{}, nil, fmt.Errorf("sms: AT+CMGR=%d failed: %w", index, err)
	}

	if !mgr.textMode {
		return IncomingSMS{}, nil, fmt.Errorf("sms: PDU mode read not yet implemented")
	}

	msg, err := parseTextModeMessage(resp, index)
	if err != nil {
		return IncomingSMS{}, nil, err
	}

	// Try to detect UCS-2 encoding in the body and decode if needed.
	// If the body appears to be hex-encoded UCS-2 (common when modem reports
	// DCS=8 in text mode), decode it.
	if looksLikeUCS2Hex(msg.Body) {
		decoded := decodeUCS2HexString(msg.Body)
		if decoded != "" {
			msg.Body = decoded
		}
	}

	// Try to extract concatenation info from the +CMGR response header.
	// Some modems include concatenation info in the header when AT+CSDH=1.
	concatInfo := parseConcatInfoFromResponse(resp)

	return msg, concatInfo, nil
}

// cmgrHeaderRegex matches the +CMGR header line in text mode.
// Format: +CMGR: "<status>","<from>"[,"<name>"],"<timestamp>"
// Examples:
//
//	+CMGR: "REC UNREAD","+15551234567",,"24/01/15,10:30:00+00"
//	+CMGR: "REC READ","+15551234567","","24/01/15,10:30:00+00"
var cmgrHeaderRegex = regexp.MustCompile(`\+CMGR:\s*"([^"]*)",\s*"([^"]*)"`)

// parseTextModeMessage parses a text-mode AT+CMGR response into an IncomingSMS.
func parseTextModeMessage(resp string, index int) (IncomingSMS, error) {
	lines := strings.Split(resp, "\n")
	if len(lines) < 2 {
		return IncomingSMS{}, fmt.Errorf("sms: incomplete CMGR response (expected header + body): %q", resp)
	}

	// Find the +CMGR header line.
	headerIdx := -1
	for i, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "+CMGR:") {
			headerIdx = i
			break
		}
	}
	if headerIdx < 0 {
		return IncomingSMS{}, fmt.Errorf("sms: no +CMGR header found in response: %q", resp)
	}

	headerLine := lines[headerIdx]

	// Extract sender from header.
	matches := cmgrHeaderRegex.FindStringSubmatch(headerLine)
	if matches == nil {
		return IncomingSMS{}, fmt.Errorf("sms: failed to parse +CMGR header: %q", headerLine)
	}
	from := matches[2]

	// Extract timestamp from header.
	timestamp := parseTimestampFromHeader(headerLine)

	// Body is everything after the header line.
	var bodyLines []string
	for i := headerIdx + 1; i < len(lines); i++ {
		line := lines[i]
		// Skip empty trailing lines.
		if strings.TrimSpace(line) == "" && i == len(lines)-1 {
			continue
		}
		bodyLines = append(bodyLines, line)
	}
	body := strings.Join(bodyLines, "\n")

	// The modem outputs text in Latin-1 (ISO-8859-1) when using GSM character set.
	// Convert to UTF-8 so the body is properly encoded for JSON transmission.
	body = latin1ToUTF8(body)

	// Detect the UDHI bit (0x40) in the TP first-octet <fo> field, present in the
	// extended header when AT+CSDH=1 is enabled. If set, this message is part of
	// a concatenated SMS.
	multipart := headerHasUDHI(headerLine)

	return IncomingSMS{
		MessageID: strconv.Itoa(index),
		From:      from,
		To:        "", // Recipient not available in +CMGR response
		Body:      body,
		Timestamp: timestamp,
		Multipart: multipart,
	}, nil
}

// csdhHeaderRegex matches the extended +CMGR/+CMGL header fields present when
// AT+CSDH=1 is enabled. After the 4 quoted fields, the numeric fields are:
// <tooa>,<fo>,<pid>,<dcs>,<sca>,<tosca>,<length>. We capture <fo> (2nd numeric).
var csdhFoRegex = regexp.MustCompile(`"\s*,\s*(\d+)\s*,\s*(\d+)\s*,`)

// headerHasUDHI returns true if the TP first-octet (<fo>) field in an extended
// SMS header (AT+CSDH=1) has the UDHI bit (0x40) set, indicating the message
// carries a User Data Header (used for concatenation).
func headerHasUDHI(header string) bool {
	m := csdhFoRegex.FindStringSubmatch(header)
	if m == nil {
		return false
	}
	// m[2] is the <fo> field (m[1] is <tooa>).
	fo, err := strconv.Atoi(m[2])
	if err != nil {
		return false
	}
	return fo&0x40 != 0
}

// timestampRegex matches modem timestamp format: YY/MM/DD,HH:MM:SS±TZ
var timestampRegex = regexp.MustCompile(`"(\d{2}/\d{2}/\d{2},\d{2}:\d{2}:\d{2}[+\-]\d{2})"`)

// parseTimestampFromHeader extracts and parses the timestamp from a +CMGR header line.
func parseTimestampFromHeader(header string) time.Time {
	matches := timestampRegex.FindStringSubmatch(header)
	if matches == nil {
		return time.Time{}
	}

	raw := matches[1]
	// Format: YY/MM/DD,HH:MM:SS±TZ where TZ is in quarter-hours from UTC.
	// Example: 24/01/15,10:30:00+00
	t, err := parseModemTimestamp(raw)
	if err != nil {
		slog.Debug("Failed to parse SMS timestamp", "raw", raw, "error", err)
		return time.Time{}
	}
	return t
}

// parseModemTimestamp parses the modem timestamp format YY/MM/DD,HH:MM:SS±TZ.
// TZ is expressed in quarter-hours offset from UTC.
func parseModemTimestamp(raw string) (time.Time, error) {
	// Expected: "24/01/15,10:30:00+00" or "24/01/15,10:30:00-08"
	if len(raw) < 20 {
		return time.Time{}, fmt.Errorf("timestamp too short: %q", raw)
	}

	// Parse date and time parts.
	parts := strings.SplitN(raw, ",", 2)
	if len(parts) != 2 {
		return time.Time{}, fmt.Errorf("invalid timestamp format: %q", raw)
	}

	datePart := parts[0] // YY/MM/DD
	timePart := parts[1] // HH:MM:SS±TZ

	// Parse date.
	dateParts := strings.Split(datePart, "/")
	if len(dateParts) != 3 {
		return time.Time{}, fmt.Errorf("invalid date format: %q", datePart)
	}
	year, err := strconv.Atoi(dateParts[0])
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid year: %w", err)
	}
	year += 2000 // Convert YY to YYYY
	month, err := strconv.Atoi(dateParts[1])
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid month: %w", err)
	}
	day, err := strconv.Atoi(dateParts[2])
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid day: %w", err)
	}

	// Parse time and timezone offset.
	// timePart format: HH:MM:SS±TZ (TZ in quarter-hours)
	var sign int
	var tzIdx int
	plusIdx := strings.LastIndex(timePart, "+")
	minusIdx := strings.LastIndex(timePart, "-")

	if plusIdx > 0 {
		sign = 1
		tzIdx = plusIdx
	} else if minusIdx > 0 {
		sign = -1
		tzIdx = minusIdx
	} else {
		// No timezone offset, assume UTC.
		sign = 0
		tzIdx = len(timePart)
	}

	timeStr := timePart[:tzIdx] // HH:MM:SS
	timeParts := strings.Split(timeStr, ":")
	if len(timeParts) != 3 {
		return time.Time{}, fmt.Errorf("invalid time format: %q", timeStr)
	}
	hour, err := strconv.Atoi(timeParts[0])
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid hour: %w", err)
	}
	minute, err := strconv.Atoi(timeParts[1])
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid minute: %w", err)
	}
	second, err := strconv.Atoi(timeParts[2])
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid second: %w", err)
	}

	// Parse timezone offset in quarter-hours.
	offsetQuarters := 0
	if sign != 0 && tzIdx < len(timePart) {
		tzStr := timePart[tzIdx+1:]
		offsetQuarters, err = strconv.Atoi(tzStr)
		if err != nil {
			return time.Time{}, fmt.Errorf("invalid timezone offset: %q: %w", tzStr, err)
		}
	}

	// Convert quarter-hours to seconds for time.FixedZone.
	offsetSeconds := sign * offsetQuarters * 15 * 60
	loc := time.FixedZone("", offsetSeconds)

	return time.Date(year, time.Month(month), day, hour, minute, second, 0, loc), nil
}

// handleCDS processes a +CDS URC (delivery status report).
func (mgr *Manager) handleCDS(urc modem.URC) {
	data := urc.Data
	if data == "" {
		slog.Debug("Empty +CDS URC received")
		return
	}

	report, err := parseDeliveryReport(data)
	if err != nil {
		slog.Error("Failed to parse delivery report", "error", err, "data", data)
		return
	}

	// Notify all registered handlers.
	mgr.mu.RLock()
	handlers := make([]func(DeliveryReport), len(mgr.deliveryHandlers))
	copy(handlers, mgr.deliveryHandlers)
	mgr.mu.RUnlock()

	for _, h := range handlers {
		h(report)
	}
}

// deliveryRefRegex extracts the message reference from a +CDS delivery report.
// Text mode format varies, but typically includes: <fo>,<mr>,<ra>,<tora>,<scts>,<dt>,<st>
// Where <mr> is the message reference.
var deliveryRefRegex = regexp.MustCompile(`^\s*\d+,\s*(\d+)`)

// parseDeliveryReport parses a +CDS delivery report.
// Format: <fo>,<mr>,<ra>,<tora>,<scts>,<dt>,<st>
// Example: 6,3,"+15551234567",129,"24/01/15,10:30:00+00","24/01/15,10:30:05+00",0
func parseDeliveryReport(data string) (DeliveryReport, error) {
	matches := deliveryRefRegex.FindStringSubmatch(data)
	if matches == nil {
		return DeliveryReport{}, fmt.Errorf("sms: failed to parse delivery report: %q", data)
	}

	ref, err := strconv.Atoi(matches[1])
	if err != nil {
		return DeliveryReport{}, fmt.Errorf("sms: invalid message reference in delivery report: %w", err)
	}

	// Parse status from the last field.
	status := parseDeliveryStatus(data)

	return DeliveryReport{
		MessageRef: ref,
		Status:     status,
	}, nil
}

// parseDeliveryStatus extracts the delivery status from the last field of a +CDS report.
// Status 0 = delivered, non-zero = failed.
func parseDeliveryStatus(data string) string {
	parts := strings.Split(data, ",")
	if len(parts) < 7 {
		return "UNKNOWN"
	}

	// The status is the last field.
	statusStr := strings.TrimSpace(parts[len(parts)-1])
	statusCode, err := strconv.Atoi(statusStr)
	if err != nil {
		return "UNKNOWN"
	}

	if statusCode == 0 {
		return "DELIVERED"
	}
	return "FAILED"
}

// concatInfoRegex matches concatenation info sometimes included in extended +CMGR headers.
// Some modems with AT+CSDH=1 report: ...,<udhl>,<udh>...
// The UDH for concatenation (IEI 0x00) format:
// 05 00 03 <refNum> <totalParts> <seqNum>
// Or (IEI 0x08) for 16-bit reference:
// 06 08 04 <refNumHi> <refNumLo> <totalParts> <seqNum>
var concatUDHRegex = regexp.MustCompile(`(?i)0500030?([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})`)
var concatUDH16Regex = regexp.MustCompile(`(?i)060804([0-9A-F]{4})([0-9A-F]{2})([0-9A-F]{2})`)

// parseConcatInfoFromResponse attempts to extract concatenation info from an AT+CMGR response.
// Returns nil if the message is not a concatenated SMS or if concatenation info
// cannot be found in the response.
func parseConcatInfoFromResponse(resp string) *ConcatInfo {
	// Try 8-bit reference number UDH (IEI 0x00).
	matches := concatUDHRegex.FindStringSubmatch(resp)
	if matches != nil {
		refNum, err1 := strconv.ParseInt(matches[1], 16, 32)
		totalParts, err2 := strconv.ParseInt(matches[2], 16, 32)
		seqNum, err3 := strconv.ParseInt(matches[3], 16, 32)
		if err1 == nil && err2 == nil && err3 == nil && totalParts > 1 {
			return &ConcatInfo{
				RefNum:     int(refNum),
				SeqNum:     int(seqNum),
				TotalParts: int(totalParts),
			}
		}
	}

	// Try 16-bit reference number UDH (IEI 0x08).
	matches = concatUDH16Regex.FindStringSubmatch(resp)
	if matches != nil {
		refNum, err1 := strconv.ParseInt(matches[1], 16, 32)
		totalParts, err2 := strconv.ParseInt(matches[2], 16, 32)
		seqNum, err3 := strconv.ParseInt(matches[3], 16, 32)
		if err1 == nil && err2 == nil && err3 == nil && totalParts > 1 {
			return &ConcatInfo{
				RefNum:     int(refNum),
				SeqNum:     int(seqNum),
				TotalParts: int(totalParts),
			}
		}
	}

	return nil
}

// latin1ToUTF8 converts a Latin-1 (ISO-8859-1) encoded string to UTF-8.
// The SIM7600 modem outputs SMS body text in Latin-1 when using the GSM
// character set. Each byte in Latin-1 maps directly to the corresponding
// Unicode code point, so we just need to promote bytes > 127 to multi-byte
// UTF-8 sequences.
func latin1ToUTF8(s string) string {
	// Fast path: if the string is already valid UTF-8 with no high bytes,
	// return it unchanged.
	hasHighByte := false
	for i := 0; i < len(s); i++ {
		if s[i] > 127 {
			hasHighByte = true
			break
		}
	}
	if !hasHighByte {
		return s
	}

	// Convert each byte as a Latin-1 code point to UTF-8.
	runes := make([]rune, 0, len(s))
	for i := 0; i < len(s); i++ {
		runes = append(runes, rune(s[i]))
	}
	return string(runes)
}

// looksLikeUCS2Hex returns true if the body appears to be a hex-encoded UCS-2 string.
// This is a heuristic: the body must be all hex characters and have even length >= 4.
func looksLikeUCS2Hex(body string) bool {
	body = strings.TrimSpace(body)
	if len(body) < 4 || len(body)%4 != 0 {
		return false
	}
	for _, r := range body {
		if !((r >= '0' && r <= '9') || (r >= 'A' && r <= 'F') || (r >= 'a' && r <= 'f')) {
			return false
		}
	}
	return true
}

// decodeUCS2HexString decodes a hex-encoded UCS-2 string into a Go string.
// Returns empty string if decoding fails.
func decodeUCS2HexString(hexStr string) string {
	hexStr = strings.TrimSpace(hexStr)
	if len(hexStr)%2 != 0 {
		return ""
	}

	data := make([]byte, len(hexStr)/2)
	for i := 0; i < len(hexStr); i += 2 {
		b, err := strconv.ParseUint(hexStr[i:i+2], 16, 8)
		if err != nil {
			return ""
		}
		data[i/2] = byte(b)
	}

	return DecodeUCS2(data)
}

// handleCDSI processes a +CDSI URC (delivery status report stored notification).
// This is used when AT+CNMI <ds>=2: the modem stores the delivery report and
// sends a +CDSI notification with the storage location. We read it from storage
// and process it like a +CDS.
//
// Note: some modems (e.g. SIM7600) may also route regular incoming SMS via +CDSI
// instead of +CMTI in certain configurations. If the stored message is not a
// delivery report, we fall back to processing it as a regular incoming SMS.
// Format: +CDSI: "<storage>",<index>
func (mgr *Manager) handleCDSI(urc modem.URC) {
	// +CDSI has the same format as +CMTI: "<storage>",<index>
	info, err := modem.ParseCMTI(urc.Data)
	if err != nil {
		slog.Error("Failed to parse +CDSI URC", "error", err, "data", urc.Data)
		return
	}

	slog.Debug("Delivery report stored notification", "storage", info.Storage, "index", info.Index)

	// The +CDSI URC reports the storage (e.g. "SR") the report was stored in.
	// AT+CMGR reads from the currently-selected read storage, which is normally
	// "SM", so we must select the reported storage first, then restore "SM".
	if info.Storage != "" {
		if _, err := mgr.modem.SendCommand(fmt.Sprintf("AT+CPMS=%q", info.Storage), 0); err != nil {
			slog.Warn("Failed to select storage for delivery report read",
				"storage", info.Storage, "error", err)
		}
		defer func() {
			if _, err := mgr.modem.SendCommand("AT+CPMS=\"SM\"", 0); err != nil {
				slog.Warn("Failed to restore SM storage after delivery report read", "error", err)
			}
		}()
	}

	// Read the delivery report from storage using AT+CMGR.
	resp, err := mgr.modem.SendCommand(fmt.Sprintf("AT+CMGR=%d", info.Index), 0)
	if err != nil {
		slog.Error("Failed to read stored delivery report", "error", err, "index", info.Index)
		return
	}

	// Delete from storage after reading.
	if _, err := mgr.modem.SendCommand(fmt.Sprintf("AT+CMGD=%d", info.Index), 0); err != nil {
		slog.Warn("Failed to delete stored delivery report", "error", err, "index", info.Index)
	}

	// Parse the delivery report from the CMGR response.
	// The response contains the status report data similar to +CDS format.
	report, err := parseDeliveryReportFromCMGR(resp)
	if err != nil {
		// Not a delivery report — this may be a regular incoming SMS that the
		// modem stored in the status report storage. Try parsing as a regular SMS.
		slog.Debug("CDSI response is not a delivery report, trying as incoming SMS",
			"index", info.Index, "parseError", err)

		msg, parseErr := parseTextModeMessage(resp, info.Index)
		if parseErr != nil {
			slog.Error("Failed to parse CDSI stored message as SMS or delivery report",
				"index", info.Index, "deliveryErr", err, "smsErr", parseErr, "resp", resp)
			return
		}

		// Try to decode UCS-2 if applicable.
		if looksLikeUCS2Hex(msg.Body) {
			decoded := decodeUCS2HexString(msg.Body)
			if decoded != "" {
				msg.Body = decoded
			}
		}

		// Deliver as incoming SMS.
		slog.Debug("CDSI stored message processed as incoming SMS",
			"from", msg.From, "index", info.Index)

		mgr.deliverIncoming(msg)
		return
	}

	// Notify all registered delivery report handlers.
	mgr.mu.RLock()
	handlers := make([]func(DeliveryReport), len(mgr.deliveryHandlers))
	copy(handlers, mgr.deliveryHandlers)
	mgr.mu.RUnlock()

	for _, h := range handlers {
		h(report)
	}
}

// parseDeliveryReportFromCMGR extracts a delivery report from an AT+CMGR response
// that contains a status report. The response typically looks like:
// +CMGR: "REC READ",6,3,"+15551234567",129,"24/01/15,10:30:00+00","24/01/15,10:30:05+00",0
// or has the data on a second line after the +CMGR header.
func parseDeliveryReportFromCMGR(resp string) (DeliveryReport, error) {
	// Try to find delivery report data in the response.
	// First try parsing the full response as a delivery report directly.
	lines := strings.Split(resp, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "+CMGR:") {
			// For status reports, the +CMGR header itself may contain the data
			// after the status field. Try extracting from after "REC READ"/"REC UNREAD".
			if strings.HasPrefix(line, "+CMGR:") {
				// Strip the +CMGR: "STATUS", prefix and try to parse remainder as report.
				idx := strings.Index(line, ",")
				if idx > 0 {
					// Skip the first field (status string) to get the report data.
					afterStatus := line[idx+1:]
					report, err := parseDeliveryReport(afterStatus)
					if err == nil {
						return report, nil
					}
				}
			}
			continue
		}
		// Try parsing non-header lines as delivery report data.
		report, err := parseDeliveryReport(line)
		if err == nil {
			return report, nil
		}
	}

	return DeliveryReport{}, fmt.Errorf("sms: no delivery report data found in CMGR response: %q", resp)
}

// PollDeliveryReports reads all stored status reports from modem storage and
// processes them. This is used when AT+CNMI <ds>=0 (no notification) as a
// periodic polling fallback. It lists status reports with AT+CMGL, processes
// each one, and deletes them from storage.
//
// In text mode, AT+CMGL="ALL" with the modem in status report aware mode
// returns stored delivery reports. We filter for status report entries.
func (mgr *Manager) PollDeliveryReports() {
	if !mgr.textMode {
		// PDU mode polling not implemented.
		return
	}

	// List all stored messages — status reports are stored as "REC READ" or "REC UNREAD".
	// Use AT+CPMS to check the status report storage first, then list.
	resp, err := mgr.modem.SendCommand("AT+CMGL=\"ALL\"", 30*time.Second)
	if err != nil {
		slog.Debug("Delivery report poll AT+CMGL failed", "error", err)
		return
	}

	if strings.TrimSpace(resp) == "" {
		return
	}

	// Parse the response for status report entries.
	// Format: +CMGL: <index>,<stat>,<fo>,<mr>,<ra>,<tora>,<scts>,<dt>,<st>
	// followed by potential body lines.
	lines := strings.Split(resp, "\n")
	var indicesToDelete []int

	for i, line := range lines {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "+CMGL:") {
			continue
		}

		// Extract index from +CMGL header.
		afterPrefix := strings.TrimPrefix(line, "+CMGL:")
		parts := strings.SplitN(strings.TrimSpace(afterPrefix), ",", 2)
		if len(parts) < 2 {
			continue
		}
		index, err := strconv.Atoi(strings.TrimSpace(parts[0]))
		if err != nil {
			continue
		}

		// Check if this is a status report by looking at the stat field.
		// Status reports have stat containing "STATUS REPORT" or specific patterns.
		// On SIM7600, status reports mixed with regular SMS in CMGL.
		// We attempt to parse as delivery report; if it succeeds, it's a status report.
		remainder := parts[1]
		report, err := parseDeliveryReport(remainder)
		if err != nil {
			// Not a status report — might be a regular SMS. Try next line as data.
			if i+1 < len(lines) {
				nextLine := strings.TrimSpace(lines[i+1])
				report, err = parseDeliveryReport(nextLine)
			}
		}
		if err != nil {
			continue
		}

		// Successfully parsed a delivery report.
		indicesToDelete = append(indicesToDelete, index)

		// Notify handlers.
		mgr.mu.RLock()
		handlers := make([]func(DeliveryReport), len(mgr.deliveryHandlers))
		copy(handlers, mgr.deliveryHandlers)
		mgr.mu.RUnlock()

		for _, h := range handlers {
			h(report)
		}
	}

	// Delete processed status reports from storage.
	for _, idx := range indicesToDelete {
		if _, err := mgr.modem.SendCommand(fmt.Sprintf("AT+CMGD=%d", idx), 0); err != nil {
			slog.Warn("Failed to delete polled delivery report", "error", err, "index", idx)
		}
	}

	if len(indicesToDelete) > 0 {
		slog.Debug("Polled delivery reports", "count", len(indicesToDelete))
	}
}
