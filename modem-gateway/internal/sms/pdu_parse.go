package sms

import (
	"fmt"
	"time"
)

// SMS PDU parsing per 3GPP TS 23.040 / GSM 07.05.
//
// Handles the two inbound PDU types delivered by the modem in PDU mode:
//   - SMS-DELIVER (TP-MTI = 0): a received text message.
//   - SMS-STATUS-REPORT (TP-MTI = 2): a delivery/status report for a message
//     we previously sent.

// parsedMessage is the result of parsing an inbound SMS-DELIVER PDU.
type parsedMessage struct {
	Sender    string
	Body      string
	Timestamp time.Time
	// Concat is non-nil when the message carries a concatenation UDH.
	Concat *ConcatInfo
}

// pduReader is a small cursor over the decoded PDU byte slice.
type pduReader struct {
	data []byte
	pos  int
}

func (r *pduReader) remaining() int { return len(r.data) - r.pos }

func (r *pduReader) u8() (byte, error) {
	if r.pos >= len(r.data) {
		return 0, fmt.Errorf("sms: PDU truncated at offset %d", r.pos)
	}
	b := r.data[r.pos]
	r.pos++
	return b, nil
}

func (r *pduReader) bytes(n int) ([]byte, error) {
	if r.pos+n > len(r.data) {
		return nil, fmt.Errorf("sms: PDU wants %d bytes at offset %d, only %d left", n, r.pos, r.remaining())
	}
	b := r.data[r.pos : r.pos+n]
	r.pos += n
	return b, nil
}

// hexToBytes decodes a hex string into bytes. Whitespace is ignored.
func hexToBytes(s string) ([]byte, error) {
	// Strip whitespace.
	clean := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == ' ' || c == '\t' || c == '\r' || c == '\n' {
			continue
		}
		clean = append(clean, c)
	}
	if len(clean)%2 != 0 {
		return nil, fmt.Errorf("sms: odd-length hex PDU (%d)", len(clean))
	}
	out := make([]byte, len(clean)/2)
	for i := 0; i < len(clean); i += 2 {
		hi, ok1 := hexNibble(clean[i])
		lo, ok2 := hexNibble(clean[i+1])
		if !ok1 || !ok2 {
			return nil, fmt.Errorf("sms: invalid hex byte %q", clean[i:i+2])
		}
		out[i/2] = hi<<4 | lo
	}
	return out, nil
}

func hexNibble(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	}
	return 0, false
}

// pduMTI returns the TP-MTI (message type) of a hex PDU without fully parsing
// it: 0 = SMS-DELIVER, 2 = SMS-STATUS-REPORT. Returns -1 on parse failure.
func pduMTI(hexPDU string) int {
	data, err := hexToBytes(hexPDU)
	if err != nil {
		return -1
	}
	r := &pduReader{data: data}
	smscLen, err := r.u8()
	if err != nil {
		return -1
	}
	if _, err := r.bytes(int(smscLen)); err != nil {
		return -1
	}
	fo, err := r.u8()
	if err != nil {
		return -1
	}
	return int(fo & 0x03)
}

// parseDeliverPDU parses a hex-encoded SMS-DELIVER PDU into a parsedMessage.
func parseDeliverPDU(hexPDU string) (parsedMessage, error) {
	data, err := hexToBytes(hexPDU)
	if err != nil {
		return parsedMessage{}, err
	}
	r := &pduReader{data: data}

	// SMSC: length octet, then that many octets (type-of-address + digits).
	smscLen, err := r.u8()
	if err != nil {
		return parsedMessage{}, err
	}
	if _, err := r.bytes(int(smscLen)); err != nil {
		return parsedMessage{}, err
	}

	// TP first octet.
	fo, err := r.u8()
	if err != nil {
		return parsedMessage{}, err
	}
	if fo&0x03 != 0x00 {
		return parsedMessage{}, fmt.Errorf("sms: not an SMS-DELIVER PDU (MTI=%d)", fo&0x03)
	}
	hasUDH := fo&0x40 != 0

	// TP-OA (originating address).
	sender, err := parseAddress(r)
	if err != nil {
		return parsedMessage{}, err
	}

	// TP-PID.
	if _, err := r.u8(); err != nil {
		return parsedMessage{}, err
	}
	// TP-DCS.
	dcs, err := r.u8()
	if err != nil {
		return parsedMessage{}, err
	}
	// TP-SCTS: 7 octets, semi-octet swapped.
	scts, err := r.bytes(7)
	if err != nil {
		return parsedMessage{}, err
	}
	timestamp := parseSCTS(scts)

	// TP-UDL.
	udl, err := r.u8()
	if err != nil {
		return parsedMessage{}, err
	}

	// Remaining bytes are the user data.
	ud := r.data[r.pos:]

	body, concat, err := decodeUserData(dcs, int(udl), hasUDH, ud)
	if err != nil {
		return parsedMessage{}, err
	}

	return parsedMessage{
		Sender:    sender,
		Body:      body,
		Timestamp: timestamp,
		Concat:    concat,
	}, nil
}

// isGSM7DCS reports whether a DCS value selects the GSM-7 default alphabet.
// The general data-coding group (top nibble 0x0) uses bits 3–2 to select the
// alphabet: 00 = GSM-7, 01 = 8-bit, 10 = UCS-2. We treat anything that isn't
// clearly 8-bit or UCS-2 as GSM-7 (the common case).
func isGSM7DCS(dcs byte) bool {
	// UCS-2: bits 3..2 == 10.
	if dcs&0x0C == 0x08 {
		return false
	}
	// 8-bit data: bits 3..2 == 01. We don't decode arbitrary 8-bit payloads as
	// text; fall back to GSM-7 handling would be wrong, but 8-bit user messages
	// are rare. Treat as GSM-7 only when not 8-bit/UCS-2.
	if dcs&0x0C == 0x04 {
		return false
	}
	return true
}

// decodeUserData decodes the TP-UD field into a string, handling an optional
// UDH and choosing GSM-7 vs UCS-2 by DCS. Returns the decoded body and any
// concatenation info found in the UDH.
func decodeUserData(dcs byte, udl int, hasUDH bool, ud []byte) (string, *ConcatInfo, error) {
	gsm7 := isGSM7DCS(dcs)

	var concat *ConcatInfo
	udhLenOctets := 0
	if hasUDH {
		if len(ud) == 0 {
			return "", nil, fmt.Errorf("sms: UDHI set but user data empty")
		}
		udhl := int(ud[0])
		udhLenOctets = udhl + 1 // include the UDHL byte itself
		if udhLenOctets > len(ud) {
			return "", nil, fmt.Errorf("sms: UDH length %d exceeds user data %d", udhLenOctets, len(ud))
		}
		concat = parseConcatFromUDH(ud[1:udhLenOctets])
	}

	if gsm7 {
		// UDL for GSM-7 is a septet count. If a UDH is present, the header plus
		// fill bits occupy whole septet positions at the start of the septet
		// stream; we skip those and decode the remainder.
		septets := unpackSeptets(ud, udl, 0)
		if hasUDH {
			// Number of septet positions consumed by the UDH (incl. fill bits).
			udhSeptets := (udhLenOctets*8 + 6) / 7 // ceil(bits/7)
			if udhSeptets <= len(septets) {
				septets = septets[udhSeptets:]
			} else {
				septets = nil
			}
		}
		return decodeGSM7(septets), concat, nil
	}

	// UCS-2 (or 8-bit fallback): user data is raw octets. Skip the UDH bytes.
	msgBytes := ud
	if hasUDH {
		msgBytes = ud[udhLenOctets:]
	}
	return DecodeUCS2(msgBytes), concat, nil
}

// parseConcatFromUDH scans UDH information elements for a concatenation IE and
// returns the concat info, or nil if none is present. Supports the 8-bit
// reference IEI 0x00 and the 16-bit reference IEI 0x08.
func parseConcatFromUDH(udh []byte) *ConcatInfo {
	i := 0
	for i+2 <= len(udh) {
		iei := udh[i]
		iedl := int(udh[i+1])
		if i+2+iedl > len(udh) {
			break
		}
		ie := udh[i+2 : i+2+iedl]
		switch iei {
		case 0x00: // concatenated SMS, 8-bit reference
			if len(ie) == 3 {
				return &ConcatInfo{
					RefNum:     int(ie[0]),
					TotalParts: int(ie[1]),
					SeqNum:     int(ie[2]),
				}
			}
		case 0x08: // concatenated SMS, 16-bit reference
			if len(ie) == 4 {
				return &ConcatInfo{
					RefNum:     int(ie[0])<<8 | int(ie[1]),
					TotalParts: int(ie[2]),
					SeqNum:     int(ie[3]),
				}
			}
		}
		i += 2 + iedl
	}
	return nil
}

// parseAddress reads a PDU address field (address-length in semi-octets/digits,
// type-of-address, then the address value) and returns the formatted number.
// International numbers (TOA 0x91) get a leading '+'. Alphanumeric addresses
// (TOA type 0xD0) are GSM-7 decoded.
func parseAddress(r *pduReader) (string, error) {
	addrLen, err := r.u8() // number of address digits (semi-octets)
	if err != nil {
		return "", err
	}
	toa, err := r.u8()
	if err != nil {
		return "", err
	}
	if addrLen == 0 {
		return "", nil
	}

	// Octets holding the address value: ceil(addrLen/2).
	nOctets := (int(addrLen) + 1) / 2
	octets, err := r.bytes(nOctets)
	if err != nil {
		return "", err
	}

	// Alphanumeric address: TON == 101 (bits 6..4), i.e. toa & 0x70 == 0x50.
	if toa&0x70 == 0x50 {
		// addrLen counts semi-octets; the number of packed septets is
		// addrLen*4/7.
		septetCount := int(addrLen) * 4 / 7
		septets := unpackSeptets(octets, septetCount, 0)
		return decodeGSM7(septets), nil
	}

	// Numeric address: reverse semi-octet decode.
	var digits []byte
	for _, o := range octets {
		lo := o & 0x0F
		hi := o >> 4
		digits = append(digits, '0'+lo)
		if hi != 0x0F { // 0xF is the odd-length filler
			digits = append(digits, '0'+hi)
		}
	}
	num := string(digits)
	if toa&0x70 == 0x10 { // international
		num = "+" + num
	}
	return num, nil
}

// parseSCTS decodes the 7-octet TP-SCTS service-centre timestamp (semi-octet
// swapped BCD) into a time.Time. The final octet is the timezone in
// quarter-hours (with the sign in bit 3 of its high nibble).
func parseSCTS(b []byte) time.Time {
	if len(b) < 7 {
		return time.Time{}
	}
	dec := func(o byte) int {
		return int(o&0x0F)*10 + int(o>>4)
	}
	year := dec(b[0]) + 2000
	month := dec(b[1])
	day := dec(b[2])
	hour := dec(b[3])
	minute := dec(b[4])
	second := dec(b[5])

	// Timezone: low nibble is tens, high nibble is units, bit 3 of the swapped
	// value is the sign. Decode the quarter-hour offset.
	tzByte := b[6]
	// The sign bit is bit 3 of the *low* semi-octet before swap; after our
	// dec() swap treatment, extract it from the raw byte.
	negative := tzByte&0x08 != 0
	// Clear the sign bit for magnitude decoding.
	tzMagByte := tzByte & 0xF7
	quarters := int(tzMagByte&0x0F)*10 + int(tzMagByte>>4)
	offsetSeconds := quarters * 15 * 60
	if negative {
		offsetSeconds = -offsetSeconds
	}
	loc := time.FixedZone("", offsetSeconds)

	if month < 1 || month > 12 || day < 1 || day > 31 {
		return time.Time{}
	}
	return time.Date(year, time.Month(month), day, hour, minute, second, 0, loc)
}

// parseStatusReportPDU parses an SMS-STATUS-REPORT PDU into a DeliveryReport.
func parseStatusReportPDU(hexPDU string) (DeliveryReport, error) {
	data, err := hexToBytes(hexPDU)
	if err != nil {
		return DeliveryReport{}, err
	}
	r := &pduReader{data: data}

	// SMSC.
	smscLen, err := r.u8()
	if err != nil {
		return DeliveryReport{}, err
	}
	if _, err := r.bytes(int(smscLen)); err != nil {
		return DeliveryReport{}, err
	}

	// TP first octet — expect MTI = 2 (STATUS-REPORT).
	fo, err := r.u8()
	if err != nil {
		return DeliveryReport{}, err
	}
	if fo&0x03 != 0x02 {
		return DeliveryReport{}, fmt.Errorf("sms: not a status-report PDU (MTI=%d)", fo&0x03)
	}

	// TP-MR (message reference of the original submit).
	mr, err := r.u8()
	if err != nil {
		return DeliveryReport{}, err
	}

	// TP-RA (recipient address) — skip it.
	if _, err := parseAddress(r); err != nil {
		return DeliveryReport{}, err
	}

	// TP-SCTS (7 octets) and TP-DT (7 octets) — skip both.
	if _, err := r.bytes(7); err != nil {
		return DeliveryReport{}, err
	}
	if _, err := r.bytes(7); err != nil {
		return DeliveryReport{}, err
	}

	// TP-ST (status).
	st, err := r.u8()
	if err != nil {
		return DeliveryReport{}, err
	}

	return DeliveryReport{
		MessageRef: int(mr),
		Status:     statusFromTPST(st),
	}, nil
}

// statusFromTPST maps a TP-ST status octet to our DELIVERED/FAILED/UNKNOWN
// vocabulary (3GPP TS 23.040 §9.2.3.15).
//
//	0x00–0x1F: completed (0x00 = delivered) — short message transaction done.
//	0x20–0x3F: temporary error, SC still trying — treat as UNKNOWN (pending).
//	0x40+:     permanent error / failure.
func statusFromTPST(st byte) string {
	switch {
	case st == 0x00:
		return "DELIVERED"
	case st < 0x20:
		// Other "completed" codes (e.g. forwarded) — count as delivered.
		return "DELIVERED"
	case st < 0x40:
		return "UNKNOWN"
	default:
		return "FAILED"
	}
}
