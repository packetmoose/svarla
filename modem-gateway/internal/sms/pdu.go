package sms

import (
	"fmt"
	"strings"
)

// SMS PDU (Protocol Data Unit) construction per 3GPP TS 23.040 / GSM 07.05.
//
// This file builds SMS-SUBMIT PDUs for sending, including adaptive GSM-7 /
// UCS-2 encoding and multi-part concatenation via a User Data Header (UDH).
// Parsing of received PDUs lives in pdu_parse.go.

// Data Coding Scheme values we emit.
const (
	dcsGSM7 = 0x00 // GSM 7-bit default alphabet
	dcsUCS2 = 0x08 // UCS-2 (UTF-16BE)
)

// Per-part user-data capacities (3GPP TS 23.040).
const (
	// Single-part limits.
	maxGSM7Septets   = 160 // 140 octets * 8 / 7
	maxUCS2CodeUnits = 70  // 140 octets / 2

	// Concatenated-part limits. A 6-octet concat UDH consumes space:
	//   GSM-7: UDH = 6 octets = 48 bits = 7 septets (rounded up), leaving
	//          160 - 7 = 153 septets per part.
	//   UCS-2: UDH = 6 octets, leaving (140 - 6) / 2 = 67 UTF-16 units.
	maxGSM7SeptetsConcat = 153
	maxUCS2UnitsConcat   = 67
)

// concatUDHLen is the total length in octets of a concatenation UDH using an
// 8-bit reference number: UDHL(1) + IEI(1) + IEDL(1) + ref(1) + total(1) + seq(1) = 6.
const concatUDHLen = 6

// encodedPart is one SMS-SUBMIT PDU ready to hand to AT+CMGS.
type encodedPart struct {
	// PDU is the full hex-encoded PDU string (including the leading SMSC
	// length octet "00" meaning "use the SMSC configured on the SIM").
	PDU string
	// TPDULen is the AT+CMGS length argument: the number of PDU octets
	// EXCLUDING the SMSC field. This is len(PDU)/2 minus the 1-octet SMSC field.
	TPDULen int
}

// encodeAddress encodes a destination phone number into its PDU address field
// (without the leading address-length octet, which the caller prepends). It
// returns the type-of-address octet and the semi-octet-swapped BCD digits.
//
// International numbers (leading '+') use TON/NPI 0x91; national numbers use
// 0x81. Non-digit characters are stripped. Odd digit counts are padded with an
// 'F' nibble per the semi-octet convention.
func encodeAddress(number string) (toa byte, digits string, digitCount int) {
	international := strings.HasPrefix(number, "+")
	// Keep only digits.
	var sb strings.Builder
	for _, r := range number {
		if r >= '0' && r <= '9' {
			sb.WriteRune(r)
		}
	}
	clean := sb.String()
	digitCount = len(clean)

	toa = 0x81 // national, ISDN/telephone numbering
	if international {
		toa = 0x91 // international, ISDN/telephone numbering
	}

	// Pad to even length with 'F', then swap each nibble pair.
	padded := clean
	if len(padded)%2 != 0 {
		padded += "F"
	}
	var swapped strings.Builder
	for i := 0; i+1 < len(padded); i += 2 {
		swapped.WriteByte(padded[i+1])
		swapped.WriteByte(padded[i])
	}
	return toa, swapped.String(), digitCount
}

// smsSubmitParams carries the inputs needed to build a single SMS-SUBMIT PDU.
type smsSubmitParams struct {
	to        string // destination number (E.164 with optional leading +)
	dcs       byte   // dcsGSM7 or dcsUCS2
	ud        []byte // packed user data octets (GSM-7 packed septets or UCS-2 bytes)
	udl       int    // TP-UDL: septet count (GSM-7) or octet count (UCS-2), including UDH
	hasUDH    bool   // whether ud already begins with a UDH
	requestSR bool   // request a status (delivery) report
}

// buildSubmitPDU assembles a complete SMS-SUBMIT PDU hex string from params.
func buildSubmitPDU(p smsSubmitParams) encodedPart {
	var b strings.Builder

	// SMSC: length 0 => use the service centre stored on the SIM/modem.
	b.WriteString("00")

	// TP first octet (TP-MTI = SMS-SUBMIT = 0x01), TP-VP relative present
	// (0x10 => VP field is 1 octet, relative format). Set TP-UDHI (0x40) when a
	// UDH is present, and TP-SRR (0x20) to request a delivery report.
	fo := byte(0x01 | 0x10) // SUBMIT + relative validity period
	if p.hasUDH {
		fo |= 0x40 // TP-UDHI
	}
	if p.requestSR {
		fo |= 0x20 // TP-SRR
	}

	// TPDU starts here (everything after the SMSC field counts toward TPDULen).
	var tpdu strings.Builder
	tpdu.WriteString(fmt.Sprintf("%02X", fo))
	// TP-MR (message reference): 0 lets the modem assign it.
	tpdu.WriteString("00")

	// TP-DA (destination address): address-length (digit count), TOA, digits.
	toa, digits, digitCount := encodeAddress(p.to)
	tpdu.WriteString(fmt.Sprintf("%02X", digitCount))
	tpdu.WriteString(fmt.Sprintf("%02X", toa))
	tpdu.WriteString(strings.ToUpper(digits))

	// TP-PID (protocol identifier): 0 = default.
	tpdu.WriteString("00")
	// TP-DCS (data coding scheme).
	tpdu.WriteString(fmt.Sprintf("%02X", p.dcs))
	// TP-VP (validity period, relative): 0xAA = 4 days.
	tpdu.WriteString("AA")
	// TP-UDL (user data length): septets for GSM-7, octets for UCS-2.
	tpdu.WriteString(fmt.Sprintf("%02X", p.udl))
	// TP-UD (user data), hex.
	for _, o := range p.ud {
		tpdu.WriteString(fmt.Sprintf("%02X", o))
	}

	tpduHex := tpdu.String()
	b.WriteString(tpduHex)

	return encodedPart{
		PDU:     strings.ToUpper(b.String()),
		TPDULen: len(tpduHex) / 2,
	}
}

// concatUDH builds a 6-octet concatenation User Data Header (8-bit reference):
// UDHL=05, IEI=00, IEDL=03, ref, total, seq.
func concatUDH(ref byte, total, seq int) []byte {
	return []byte{0x05, 0x00, 0x03, ref, byte(total), byte(seq)}
}

// encodeMessage encodes a full message body into one or more SMS-SUBMIT PDUs,
// choosing GSM-7 or UCS-2 automatically and splitting into concatenated parts
// when the body exceeds a single part.
//
// ref is the concatenation reference number to stamp into multi-part messages
// (ignored for single-part). requestSR requests delivery reports.
func encodeMessage(to, body string, ref byte, requestSR bool) ([]encodedPart, error) {
	if CanEncodeGSM7(body) {
		return encodeGSM7Message(to, body, ref, requestSR)
	}
	return encodeUCS2Message(to, body, ref, requestSR)
}

// encodeGSM7Message encodes body as one or more GSM-7 SMS-SUBMIT PDUs.
func encodeGSM7Message(to, body string, ref byte, requestSR bool) ([]encodedPart, error) {
	septets, ok := gsm7Septets(body)
	if !ok {
		return nil, fmt.Errorf("sms: body not GSM-7 encodable")
	}

	// Single part?
	if len(septets) <= maxGSM7Septets {
		packed := packSeptets(septets, 0)
		part := buildSubmitPDU(smsSubmitParams{
			to:        to,
			dcs:       dcsGSM7,
			ud:        packed,
			udl:       len(septets),
			hasUDH:    false,
			requestSR: requestSR,
		})
		return []encodedPart{part}, nil
	}

	// Multi-part: split on character boundaries so we never break an escape
	// sequence (0x1B + code) across parts. We re-derive septets per part from
	// runes to keep escape pairs intact.
	chunks := splitGSM7(body, maxGSM7SeptetsConcat)
	total := len(chunks)
	parts := make([]encodedPart, 0, total)
	for i, chunk := range chunks {
		seq := i + 1
		udh := concatUDH(ref, total, seq)
		chunkSeptets, _ := gsm7Septets(chunk)

		// The UDH occupies 6 octets = 48 bits. GSM-7 user data must start on a
		// septet boundary, so we insert fillBits so that 48 + fillBits is a
		// multiple of 7. 48 mod 7 = 6, so fillBits = 1.
		const fillBits = 1
		packed := packSeptets(chunkSeptets, fillBits)
		ud := append(append([]byte{}, udh...), packed...)

		// TP-UDL for GSM-7 with UDH = number of septets occupied by
		// (UDH + fill) plus the message septets. UDH+fill occupies
		// ceil((48+1)/7) = 7 septet positions.
		udhSeptets := (concatUDHLen*8 + fillBits) / 7 // = 7
		udl := udhSeptets + len(chunkSeptets)

		part := buildSubmitPDU(smsSubmitParams{
			to:        to,
			dcs:       dcsGSM7,
			ud:        ud,
			udl:       udl,
			hasUDH:    true,
			requestSR: requestSR,
		})
		parts = append(parts, part)
	}
	return parts, nil
}

// encodeUCS2Message encodes body as one or more UCS-2 SMS-SUBMIT PDUs.
func encodeUCS2Message(to, body string, ref byte, requestSR bool) ([]encodedPart, error) {
	units := utf16Units(body)

	// Single part?
	if len(units) <= maxUCS2CodeUnits {
		ud := ucs2Bytes(units)
		part := buildSubmitPDU(smsSubmitParams{
			to:        to,
			dcs:       dcsUCS2,
			ud:        ud,
			udl:       len(ud), // octet count for UCS-2
			hasUDH:    false,
			requestSR: requestSR,
		})
		return []encodedPart{part}, nil
	}

	// Multi-part: split on UTF-16 unit boundaries, never separating a surrogate
	// pair (splitUCS2 guarantees this).
	chunks := splitUCS2(units, maxUCS2UnitsConcat)
	total := len(chunks)
	parts := make([]encodedPart, 0, total)
	for i, chunkUnits := range chunks {
		seq := i + 1
		udh := concatUDH(ref, total, seq)
		msgBytes := ucs2Bytes(chunkUnits)
		ud := append(append([]byte{}, udh...), msgBytes...)
		// TP-UDL for UCS-2 = total octet count including the UDH.
		udl := concatUDHLen + len(msgBytes)

		part := buildSubmitPDU(smsSubmitParams{
			to:        to,
			dcs:       dcsUCS2,
			ud:        ud,
			udl:       udl,
			hasUDH:    true,
			requestSR: requestSR,
		})
		parts = append(parts, part)
	}
	return parts, nil
}

// splitGSM7 splits text into chunks whose GSM-7 septet count (with escape
// expansion) does not exceed maxSeptets. Splitting on rune boundaries keeps
// each escape sequence (0x1B + ext code) intact within a single part.
func splitGSM7(text string, maxSeptets int) []string {
	var chunks []string
	var cur strings.Builder
	curSeptets := 0

	for _, r := range text {
		// Cost of this rune in septets: 2 for extension chars, else 1.
		cost := 1
		if _, ok := gsm7Extension[r]; ok {
			cost = 2
		}
		if curSeptets+cost > maxSeptets {
			chunks = append(chunks, cur.String())
			cur.Reset()
			curSeptets = 0
		}
		cur.WriteRune(r)
		curSeptets += cost
	}
	if cur.Len() > 0 {
		chunks = append(chunks, cur.String())
	}
	return chunks
}

// splitUCS2 splits a slice of UTF-16 code units into chunks of at most maxUnits,
// never separating a high/low surrogate pair.
func splitUCS2(units []uint16, maxUnits int) [][]uint16 {
	var chunks [][]uint16
	i := 0
	for i < len(units) {
		end := i + maxUnits
		if end > len(units) {
			end = len(units)
		}
		// If the chunk would end on a high surrogate (0xD800–0xDBFF), pull it
		// back one so the pair stays together in the next chunk.
		if end < len(units) && isHighSurrogate(units[end-1]) {
			end--
		}
		chunks = append(chunks, units[i:end])
		i = end
	}
	return chunks
}

func isHighSurrogate(u uint16) bool {
	return u >= 0xD800 && u <= 0xDBFF
}
