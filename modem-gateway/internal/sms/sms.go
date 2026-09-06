// Package sms handles SMS send and receive operations via AT commands,
// including concatenated SMS reassembly and UCS-2 encoding support.
package sms

import (
	"crypto/sha256"
	"encoding/hex"
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

// ConcatInfo holds concatenation header information for a multi-part SMS,
// extracted from the User Data Header of a received PDU.
type ConcatInfo struct {
	// RefNum is the concatenation reference number shared by all parts.
	RefNum int
	// SeqNum is the 1-based sequence number of this part.
	SeqNum int
	// TotalParts is the total number of parts in the message.
	TotalParts int
}

// Manager handles SMS send and receive operations using the modem.
type Manager struct {
	modem *modem.Modem

	reassembler *Reassembler

	// ownNumber returns the modem's own phone number (E.164) so that incoming
	// messages can be tagged with the correct "to" field. The function may
	// return an empty string if the number has not been discovered yet.
	ownNumber func() string

	mu               sync.RWMutex
	receivedHandlers []func(IncomingSMS) error
	deliveryHandlers []func(DeliveryReport)

	// concatRef supplies the 8-bit reference number stamped into the
	// concatenation UDH of multi-part outbound messages. It increments once per
	// multi-part message so all parts of a message share a reference while
	// successive messages differ.
	concatRef atomic.Uint32
}

// New creates a new SMS Manager. The modem is driven in PDU mode (AT+CMGF=0);
// all encoding/decoding is handled in this package rather than by the modem's
// text-mode character-set interpretation. ownNumber is called to fill the "to"
// field on received messages; pass nil if the number is not available.
func New(m *modem.Modem, ownNumber func() string) *Manager {
	if ownNumber == nil {
		ownNumber = func() string { return "" }
	}
	return &Manager{
		modem:       m,
		ownNumber:   ownNumber,
		reassembler: NewReassembler(0), // Use default 5-minute stale timeout
	}
}

// nextConcatRef returns the next 8-bit concatenation reference number.
func (mgr *Manager) nextConcatRef() byte {
	return byte(mgr.concatRef.Add(1))
}

// Send sends an SMS message to the specified number using PDU mode.
//
// The body is encoded adaptively: GSM-7 when every character fits the GSM
// default alphabet (including å ä ö è é € and the extension symbols), otherwise
// UCS-2. Messages longer than a single part are split and sent as a
// concatenated SMS with a User Data Header so the receiver reassembles them
// into one message — the same scheme modern phones use.
//
// Returns the modem's message reference from the final part's +CMGS response.
// The reference is informational only; the caller identifies the message by its
// own request ID.
func (mgr *Manager) Send(to, body string) (int, error) {
	// A single reference ties all parts of this message together. It is unused
	// for single-part messages but harmless to allocate.
	ref := mgr.nextConcatRef()

	// We do not request a status report (requestSR=false). The SIM7600G-H does
	// not support live +CDS push (AT+CNMI ...,<ds>=1 returns "Operation not
	// supported") and, while it emits +CDSI for a stored report, that report is
	// not retrievable — the "SR" storage always reports zero used entries and
	// AT+CMGR returns "Invalid memory index". Requesting reports we cannot read
	// only produces useless +CDSI churn, so we disable them.
	parts, err := encodeMessage(to, body, ref, false)
	if err != nil {
		return 0, fmt.Errorf("sms: encode failed: %w", err)
	}

	lastRef := 0
	for i, part := range parts {
		header := fmt.Sprintf("AT+CMGS=%d", part.TPDULen)
		resp, sendErr := mgr.modem.SendSMSCommand(header, part.PDU, SendTimeout)
		if sendErr != nil {
			if len(parts) > 1 {
				return 0, fmt.Errorf("sms: send failed on part %d/%d: %w", i+1, len(parts), sendErr)
			}
			return 0, fmt.Errorf("sms: send failed: %w", sendErr)
		}

		msgRef, parseErr := parseCMGSResponse(resp)
		if parseErr != nil {
			// The send itself succeeded (no error from the modem); only the
			// reference could not be parsed. Log and continue rather than
			// reporting a failure the caller would surface to the user.
			slog.Warn("Sent SMS part but could not parse +CMGS reference",
				"part", i+1, "total", len(parts), "error", parseErr)
			continue
		}
		lastRef = msgRef
	}

	if len(parts) > 1 {
		slog.Debug("Sent concatenated SMS", "to", to, "parts", len(parts), "ref", ref)
	}
	return lastRef, nil
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

// extractPDUFromCMGR extracts the hex PDU line from an AT+CMGR response.
// In PDU mode the response is:
//
//	+CMGR: <stat>,[<alpha>],<length>
//	<hex PDU>
//
// The PDU is the last non-empty, non-header line. Returns the PDU hex string.
func extractPDUFromCMGR(resp string) (string, error) {
	lines := strings.Split(resp, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" || strings.HasPrefix(line, "+CMGR:") {
			continue
		}
		return line, nil
	}
	return "", fmt.Errorf("sms: no PDU found in CMGR response: %q", resp)
}

// readMessage reads and parses an SMS from modem storage at the given index.
// The modem is in PDU mode, so AT+CMGR returns a raw hex PDU which we parse
// ourselves. Returns the message and, if the message is part of a concatenated
// SMS, its concatenation info (nil otherwise).
func (mgr *Manager) readMessage(index int) (IncomingSMS, *ConcatInfo, error) {
	resp, err := mgr.modem.SendCommand(fmt.Sprintf("AT+CMGR=%d", index), 0)
	if err != nil {
		return IncomingSMS{}, nil, fmt.Errorf("sms: AT+CMGR=%d failed: %w", index, err)
	}

	pduHex, err := extractPDUFromCMGR(resp)
	if err != nil {
		return IncomingSMS{}, nil, err
	}

	parsed, err := parseDeliverPDU(pduHex)
	if err != nil {
		return IncomingSMS{}, nil, fmt.Errorf("sms: parse CMGR PDU (index %d): %w", index, err)
	}

	msg := IncomingSMS{
		MessageID: deterministicMessageID(parsed),
		From:      parsed.Sender,
		To:        mgr.ownNumber(),
		Body:      parsed.Body,
		Timestamp: parsed.Timestamp,
		Multipart: parsed.Concat != nil,
	}
	return msg, parsed.Concat, nil
}

// deterministicMessageID derives a stable, globally-unique message ID from the
// PDU's invariant content so that re-reading the same message (e.g. after a
// crash before the modem delete, or a redelivery from the SMSC) yields the same
// ID. The server deduplicates inbound SMS by this ID, so stability across
// retries is what prevents duplicates.
//
// For a concatenated message, all parts must collapse to a single ID: we key on
// the sender plus the concatenation reference and total-parts count (shared by
// every part), independent of the per-part body which is only fully known once
// reassembled. For a single-part message we key on sender, service-centre
// timestamp, and body.
func deterministicMessageID(p parsedMessage) string {
	h := sha256.New()
	if p.Concat != nil {
		fmt.Fprintf(h, "concat|%s|%d|%d", p.Sender, p.Concat.RefNum, p.Concat.TotalParts)
	} else {
		fmt.Fprintf(h, "single|%s|%d|%s", p.Sender, p.Timestamp.UnixNano(), p.Body)
	}
	sum := h.Sum(nil)
	return "in-" + hex.EncodeToString(sum[:16])
}

// DrainStoredMessages reads all messages stored on the SIM/modem, delivers them
// to registered handlers, and deletes them from storage. It is called once
// during initialization (after handlers are registered) to process any messages
// that arrived while the gateway was offline and to clear stale messages that
// would otherwise trigger duplicate +CMTI/+CDSI notifications.
//
// It lists messages from SM/ME/SR storage using AT+CMGL=4 ("ALL" in PDU mode),
// reads each with AT+CMGR, parses the PDU, reassembles concatenated parts via
// the reassembler, and deletes each with AT+CMGD.
func (mgr *Manager) DrainStoredMessages() {
	storages := []string{"SM", "ME", "SR"}
	totalDrained := 0

	for _, storage := range storages {
		// Select storage for reading.
		if _, err := mgr.modem.SendCommand(fmt.Sprintf("AT+CPMS=%q", storage), 0); err != nil {
			slog.Debug("Cannot select storage for drain, skipping", "storage", storage, "error", err)
			continue
		}

		// List all messages to get their indices. In PDU mode the status filter
		// is numeric: 4 = all messages.
		resp, err := mgr.modem.SendCommand("AT+CMGL=4", 0)
		if err != nil {
			slog.Debug("AT+CMGL failed for storage, skipping", "storage", storage, "error", err)
			continue
		}
		if strings.TrimSpace(resp) == "" {
			continue
		}

		indices := parseCMGLIndices(resp)
		if len(indices) == 0 {
			continue
		}

		slog.Info("Draining stored messages", "storage", storage, "count", len(indices))

		for _, idx := range indices {
			mgr.processStoredIndex(idx, &totalDrained)
		}
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

// processStoredIndex reads, delivers, and deletes a single stored message during
// drain. It increments *delivered when a complete message is delivered.
func (mgr *Manager) processStoredIndex(idx int, delivered *int) {
	msg, concat, err := mgr.readMessage(idx)
	if err != nil {
		slog.Warn("Failed to read stored message during drain", "index", idx, "error", err)
		// Delete only a message we could not read at all, so we don't loop
		// forever on a corrupt entry. A readable message is never deleted
		// before it is durably persisted (below).
		mgr.deleteStored(idx)
		return
	}

	if concat != nil {
		complete, assembled := mgr.reassembler.AddPart(
			msg.From, concat.RefNum, concat.SeqNum, concat.TotalParts, msg.Body,
		)
		if !complete {
			// Incomplete concat part: leave it in storage until the message
			// completes and is persisted (see handleCMTI). Do not delete now.
			return
		}
		msg.Body = assembled
	}

	// Persist BEFORE deleting from storage.
	if err := mgr.deliverIncoming(msg); err != nil {
		slog.Error("Failed to persist drained SMS; leaving in modem storage for retry",
			"index", idx, "messageId", msg.MessageID, "error", err)
		return
	}

	mgr.deleteStored(idx)
	if concat != nil {
		mgr.deleteConcatParts(msg.From, concat.RefNum, concat.TotalParts)
	}
	*delivered++
}

// parseCMGLIndices extracts the storage indices from an AT+CMGL response.
// Each stored message begins with a "+CMGL: <index>,..." header line.
func parseCMGLIndices(resp string) []int {
	var indices []int
	for _, line := range strings.Split(resp, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "+CMGL:") {
			continue
		}
		after := strings.TrimSpace(strings.TrimPrefix(line, "+CMGL:"))
		fields := strings.SplitN(after, ",", 2)
		idx, err := strconv.Atoi(strings.TrimSpace(fields[0]))
		if err != nil {
			continue
		}
		indices = append(indices, idx)
	}
	return indices
}

// OnReceived registers a handler that is called when an SMS is received.
// Multiple handlers can be registered. A handler returns an error if it failed
// to durably take ownership of the message (e.g. failed to persist it); the
// receive path uses that signal to keep the message in modem storage for a
// later retry instead of deleting it.
func (mgr *Manager) OnReceived(handler func(IncomingSMS) error) {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	mgr.receivedHandlers = append(mgr.receivedHandlers, handler)
}

// OnDeliveryReport registers a handler for SMS delivery status reports.
//
// NOTE: Delivery reports are not currently emitted. The target hardware
// (SIM7600G-H) cannot deliver them — it rejects live +CDS push and its stored
// status reports (+CDSI) are not retrievable — so we do not request them (see
// Send). The registration hook is retained so that delivery-report support can
// be re-enabled without touching callers if a capable modem is used later.
func (mgr *Manager) OnDeliveryReport(handler func(DeliveryReport)) {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	mgr.deliveryHandlers = append(mgr.deliveryHandlers, handler)
}

// RegisterURCHandlers registers URC handlers on the modem for SMS-related URCs.
// This must be called after creating the Manager to enable SMS receive.
//
// Only +CMTI (new incoming SMS) is handled. Delivery-report URCs (+CDS/+CDSI)
// are intentionally not handled: we don't request status reports because this
// modem cannot surface them (see Send).
func (mgr *Manager) RegisterURCHandlers() {
	mgr.modem.OnURC(func(urc modem.URC) {
		switch urc.Prefix {
		case "+CMTI":
			mgr.handleCMTI(urc)
		}
	})
}

// handleCMTI processes a +CMTI URC (new SMS arrival notification). It reads the
// message from storage as a PDU, and for concatenated messages feeds the part
// to the reassembler, delivering only once all parts have arrived.
func (mgr *Manager) handleCMTI(urc modem.URC) {
	info, err := modem.ParseCMTI(urc.Data)
	if err != nil {
		slog.Error("Failed to parse +CMTI URC", "error", err, "data", urc.Data)
		return
	}

	slog.Debug("SMS arrival notification", "storage", info.Storage, "index", info.Index)

	msg, concat, err := mgr.readMessage(info.Index)
	if err != nil {
		slog.Error("Failed to read SMS", "error", err, "index", info.Index)
		// Leave the message in storage; a later +CMTI or the boot drain will
		// retry. Deleting an unread/corrupt message here would lose it.
		return
	}

	if concat != nil {
		slog.Debug("Concatenated SMS part received",
			"refNum", concat.RefNum, "seqNum", concat.SeqNum, "totalParts", concat.TotalParts)
		complete, assembled := mgr.reassembler.AddPart(
			msg.From, concat.RefNum, concat.SeqNum, concat.TotalParts, msg.Body,
		)
		if !complete {
			// This part is now held in the reassembler (in memory). We must not
			// delete it from modem storage until the whole message is durably
			// persisted, otherwise a crash would lose the buffered parts. Leave
			// it on the SIM; the boot drain re-reads and re-feeds parts on
			// restart. The SIM's storage capacity is the backstop, and the SMSC
			// holds undelivered messages if storage fills.
			return
		}
		msg.Body = assembled
	}

	// Persist BEFORE deleting from modem storage. Only once the received
	// handler has durably taken ownership (persisted to the buffer) do we
	// delete from the SIM/modem. If persistence fails, the message stays in
	// storage for a later retry.
	if err := mgr.deliverIncoming(msg); err != nil {
		slog.Error("Failed to persist incoming SMS; leaving in modem storage for retry",
			"error", err, "index", info.Index, "messageId", msg.MessageID)
		return
	}

	mgr.deleteStored(info.Index)
	// For a completed concatenated message, delete every part still held in
	// storage as well, so parts read earlier (which we intentionally left) are
	// cleaned up now that the message is durably persisted.
	if concat != nil {
		mgr.deleteConcatParts(msg.From, concat.RefNum, concat.TotalParts)
	}
}

// deleteStored removes a single message from modem storage by index, logging on
// failure. Deletion is best-effort: a failed delete only risks a duplicate
// redelivery, which the server deduplicates by MessageID.
func (mgr *Manager) deleteStored(index int) {
	if _, err := mgr.modem.SendCommand(fmt.Sprintf("AT+CMGD=%d", index), 0); err != nil {
		slog.Warn("Failed to delete SMS from storage", "error", err, "index", index)
	}
}

// deleteConcatParts scans storage for the remaining parts of a now-persisted
// concatenated message (matching sender and concat reference) and deletes them.
// Parts of an incomplete concat message are intentionally left in storage until
// the message completes and is persisted; this cleans them up afterwards.
func (mgr *Manager) deleteConcatParts(sender string, refNum, totalParts int) {
	resp, err := mgr.modem.SendCommand("AT+CMGL=4", 0)
	if err != nil || strings.TrimSpace(resp) == "" {
		return
	}
	for _, idx := range parseCMGLIndices(resp) {
		part, concat, err := mgr.readMessage(idx)
		if err != nil || concat == nil {
			continue
		}
		if part.From == sender && concat.RefNum == refNum && concat.TotalParts == totalParts {
			mgr.deleteStored(idx)
		}
	}
}

// deliverIncoming notifies all registered received handlers of a message. The
// MessageID is set deterministically at read time (see deterministicMessageID)
// so the server can deduplicate redelivered messages correctly. It returns the
// first error reported by a handler, allowing the caller to withhold deletion
// of the message from modem storage until it has been durably persisted.
func (mgr *Manager) deliverIncoming(msg IncomingSMS) error {
	mgr.mu.RLock()
	handlers := make([]func(IncomingSMS) error, len(mgr.receivedHandlers))
	copy(handlers, mgr.receivedHandlers)
	mgr.mu.RUnlock()

	var firstErr error
	for _, h := range handlers {
		if err := h(msg); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
