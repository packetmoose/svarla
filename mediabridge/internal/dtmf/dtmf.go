// Package dtmf implements RFC 2833 telephone-event DTMF detection and relay
// between WebRTC and SIP legs of a MediaBridge session.
//
// RFC 2833 defines how DTMF tones are carried as named telephone events in RTP.
// The payload format is:
//
//	 0                   1                   2                   3
//	 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//	|     event     |E|R| volume    |          duration             |
//	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//
// The event field (8 bits) identifies the DTMF digit (0-15 mapping to 0-9, *, #, A-D).
// The E (end) bit signals the final packet of an event.
// The volume field (6 bits) is the power level.
// The duration field (16 bits) is in timestamp units.
package dtmf

import (
	"encoding/binary"
	"fmt"
	"log/slog"
	"sync"
)

// TelephoneEventPayloadType is the typical RTP payload type for telephone-event.
// This can vary per SDP negotiation; 101 is a common default.
const TelephoneEventPayloadType = 101

// PayloadSize is the expected size of an RFC 2833 telephone-event payload.
const PayloadSize = 4

// Event represents a parsed RFC 2833 telephone-event.
type Event struct {
	// EventCode is the raw event code (0-15).
	EventCode uint8
	// End indicates this is the final packet for this event (E bit set).
	End bool
	// Volume is the power level (0-63, where 0 is loudest).
	Volume uint8
	// Duration is the event duration in timestamp units.
	Duration uint16
}

// ParsePayload parses an RFC 2833 telephone-event payload from raw bytes.
// The payload must be exactly 4 bytes.
func ParsePayload(data []byte) (Event, error) {
	if len(data) < PayloadSize {
		return Event{}, fmt.Errorf("telephone-event payload too short: %d bytes (need %d)", len(data), PayloadSize)
	}

	eventCode := data[0]
	endBit := (data[1] & 0x80) != 0
	volume := data[1] & 0x3F
	duration := binary.BigEndian.Uint16(data[2:4])

	return Event{
		EventCode: eventCode,
		End:       endBit,
		Volume:    volume,
		Duration:  duration,
	}, nil
}

// EncodePayload encodes an RFC 2833 telephone-event into a 4-byte payload.
func EncodePayload(evt Event) []byte {
	data := make([]byte, PayloadSize)
	data[0] = evt.EventCode

	var flags uint8
	if evt.End {
		flags |= 0x80
	}
	flags |= evt.Volume & 0x3F
	data[1] = flags

	binary.BigEndian.PutUint16(data[2:4], evt.Duration)
	return data
}

// EventCodeToDigit maps an RFC 2833 event code to its DTMF digit character.
// Returns the digit character and true if valid, or 0 and false if the code
// is out of the standard DTMF range (0-15).
func EventCodeToDigit(code uint8) (rune, bool) {
	if int(code) >= len(eventCodeMap) {
		return 0, false
	}
	return eventCodeMap[code], true
}

// DigitToEventCode maps a DTMF digit character to its RFC 2833 event code.
// Returns the event code and true if valid, or 0 and false if the digit is
// not a recognized DTMF character.
func DigitToEventCode(digit rune) (uint8, bool) {
	code, ok := digitToCodeMap[digit]
	return code, ok
}

// eventCodeMap maps RFC 2833 event codes 0-15 to DTMF characters.
// Codes 0-9 map to digits '0'-'9', 10 = '*', 11 = '#', 12-15 = 'A'-'D'.
var eventCodeMap = [16]rune{
	'0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
	'*', '#', 'A', 'B', 'C', 'D',
}

// digitToCodeMap is the reverse mapping from digit characters to event codes.
var digitToCodeMap = map[rune]uint8{
	'0': 0, '1': 1, '2': 2, '3': 3, '4': 4,
	'5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
	'*': 10, '#': 11,
	'A': 12, 'B': 13, 'C': 14, 'D': 15,
	'a': 12, 'b': 13, 'c': 14, 'd': 15,
}

// Detector tracks RFC 2833 events and deduplicates them using the end bit.
// It only reports a digit once per key-press by waiting for the end packet.
type Detector struct {
	mu     sync.Mutex
	logger *slog.Logger

	// active tracks whether we're currently in a DTMF event (non-end packets
	// received). Key is the event code.
	active map[uint8]bool

	// ended tracks whether we've already reported the end of a particular event
	// code, suppressing redundant end packets.
	ended map[uint8]bool

	// onDigit is called when a complete DTMF digit is detected (end bit received).
	onDigit func(digit string)
}

// NewDetector creates a DTMF detector that calls onDigit when a complete
// DTMF tone is detected (i.e., the end bit is received).
func NewDetector(onDigit func(digit string), logger *slog.Logger) *Detector {
	return &Detector{
		logger:  logger,
		active:  make(map[uint8]bool),
		ended:   make(map[uint8]bool),
		onDigit: onDigit,
	}
}

// ProcessPacket handles an incoming RFC 2833 telephone-event payload.
// It deduplicates events by only reporting digits on the first end packet.
// Subsequent redundant end packets for the same event are suppressed.
func (d *Detector) ProcessPacket(payload []byte) {
	evt, err := ParsePayload(payload)
	if err != nil {
		d.logger.Debug("failed to parse telephone-event", slog.String("error", err.Error()))
		return
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	if evt.End {
		// Check if we've already reported this event (ended[code] == true means
		// we already fired the callback for this key-press).
		if d.ended[evt.EventCode] {
			// Redundant end packet — suppress.
			return
		}

		// Report the digit (first end packet for this key-press).
		d.ended[evt.EventCode] = true
		delete(d.active, evt.EventCode)

		digit, ok := EventCodeToDigit(evt.EventCode)
		if ok && d.onDigit != nil {
			d.onDigit(string(digit))
		}
	} else {
		// Non-end packet: mark as active and clear ended flag (new key-press).
		if !d.active[evt.EventCode] {
			// New event start — clear ended state from any previous press.
			d.ended[evt.EventCode] = false
		}
		d.active[evt.EventCode] = true
	}
}

// Reset clears any in-progress tracking state.
func (d *Detector) Reset() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.active = make(map[uint8]bool)
	d.ended = make(map[uint8]bool)
}
