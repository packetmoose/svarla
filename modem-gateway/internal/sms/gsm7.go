package sms

// GSM 03.38 (3GPP TS 23.038) 7-bit default alphabet codec.
//
// This file implements the GSM-7 "default alphabet" together with its
// extension table (characters accessed via the 0x1B escape). It provides:
//   - rune <-> septet mapping tables,
//   - CanEncodeGSM7: whether a string is representable in GSM-7,
//   - gsm7Septets: convert a UTF-8 string to a slice of 7-bit septet values
//     (escape sequences expand to two septets: 0x1B followed by the ext code),
//   - packSeptets / unpackSeptets: the bit-packing between septets and the
//     8-bit octets carried in an SMS PDU user-data field,
//   - decodeGSM7: convert unpacked septets back to a UTF-8 string.
//
// PDU mode gives us full control over these bytes, so unlike the old text-mode
// path there is no dependency on the modem's AT+CSCS charset interpretation.

// gsm7Escape is the septet value that introduces an extension-table character.
const gsm7Escape = 0x1B

// gsm7DefaultAlphabet maps each septet value (0x00–0x7F) in the GSM 03.38
// default alphabet to its Unicode rune. Index == septet value.
//
// Position 0x1B is the ESCAPE control; it has no standalone character and is
// represented here as the NBSP sentinel that decodeGSM7 treats specially.
var gsm7DefaultAlphabet = [128]rune{
	'@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', // 0x00–0x07
	'ò', 'Ç', '\n', 'Ø', 'ø', '\r', 'Å', 'å', // 0x08–0x0F
	'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', // 0x10–0x17
	'Σ', 'Θ', 'Ξ', 0x1B, 'Æ', 'æ', 'ß', 'É', // 0x18–0x1F (0x1B = ESC)
	' ', '!', '"', '#', '¤', '%', '&', '\'', // 0x20–0x27
	'(', ')', '*', '+', ',', '-', '.', '/', // 0x28–0x2F
	'0', '1', '2', '3', '4', '5', '6', '7', // 0x30–0x37
	'8', '9', ':', ';', '<', '=', '>', '?', // 0x38–0x3F
	'¡', 'A', 'B', 'C', 'D', 'E', 'F', 'G', // 0x40–0x47
	'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', // 0x48–0x4F
	'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', // 0x50–0x57
	'X', 'Y', 'Z', 'Ä', 'Ö', 'Ñ', 'Ü', '§', // 0x58–0x5F
	'¿', 'a', 'b', 'c', 'd', 'e', 'f', 'g', // 0x60–0x67
	'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', // 0x68–0x6F
	'p', 'q', 'r', 's', 't', 'u', 'v', 'w', // 0x70–0x77
	'x', 'y', 'z', 'ä', 'ö', 'ñ', 'ü', 'à', // 0x78–0x7F
}

// gsm7Extension maps each rune reachable through the extension table to its
// septet value (the value that follows the 0x1B escape). Any rune not here and
// not in the default alphabet cannot be represented in GSM-7.
var gsm7Extension = map[rune]byte{
	'\f': 0x0A, // form feed
	'^':  0x14,
	'{':  0x28,
	'}':  0x29,
	'\\': 0x2F,
	'[':  0x3C,
	'~':  0x3D,
	']':  0x3E,
	'|':  0x40,
	'€':  0x65,
}

// gsm7DefaultReverse maps a rune to its default-alphabet septet value. Built
// once from gsm7DefaultAlphabet. The ESC slot (0x1B) is intentionally excluded
// so it can never be produced as a standalone character.
var gsm7DefaultReverse = func() map[rune]byte {
	m := make(map[rune]byte, 128)
	for septet, r := range gsm7DefaultAlphabet {
		if septet == gsm7Escape {
			continue
		}
		// Guard against accidental duplicate runes shadowing each other; the
		// GSM-7 default alphabet has no duplicates, so first write wins.
		if _, exists := m[r]; !exists {
			m[r] = byte(septet)
		}
	}
	return m
}()

// gsm7ExtensionReverse maps an extension septet value back to its rune.
var gsm7ExtensionReverse = func() map[byte]rune {
	rev := make(map[byte]rune, len(gsm7Extension))
	for r, code := range gsm7Extension {
		rev[code] = r
	}
	return rev
}()

// CanEncodeGSM7 reports whether every rune in text is representable in the
// GSM-7 default alphabet or its extension table.
func CanEncodeGSM7(text string) bool {
	for _, r := range text {
		if _, ok := gsm7DefaultReverse[r]; ok {
			continue
		}
		if _, ok := gsm7Extension[r]; ok {
			continue
		}
		return false
	}
	return true
}

// gsm7Septets converts a GSM-7-encodable string into its sequence of septet
// values. Extension-table characters expand to two septets: the 0x1B escape
// followed by the extension code. Returns false if the string contains any
// character not representable in GSM-7.
//
// The returned length is the "septet count" used for the TP-UDL field and for
// deciding how many characters fit in a single SMS part.
func gsm7Septets(text string) ([]byte, bool) {
	out := make([]byte, 0, len(text))
	for _, r := range text {
		if code, ok := gsm7DefaultReverse[r]; ok {
			out = append(out, code)
			continue
		}
		if code, ok := gsm7Extension[r]; ok {
			out = append(out, gsm7Escape, code)
			continue
		}
		return nil, false
	}
	return out, true
}

// packSeptets packs a slice of 7-bit septets into 8-bit octets per the GSM
// 03.38 packing scheme, with an optional bit offset used to byte-align the
// user data after a User Data Header (UDH).
//
// fillBits is the number of leading padding bits (0–6) inserted before the
// first septet so that the packed user data starts on an octet boundary. When
// there is no UDH, fillBits is 0.
func packSeptets(septets []byte, fillBits int) []byte {
	if len(septets) == 0 {
		if fillBits > 0 {
			return []byte{0x00}
		}
		return nil
	}

	// Total bits = padding + 7 per septet, rounded up to whole octets.
	totalBits := fillBits + len(septets)*7
	numOctets := (totalBits + 7) / 8
	out := make([]byte, numOctets)

	bitPos := fillBits
	for _, s := range septets {
		s &= 0x7F
		octetIdx := bitPos / 8
		bitInOctet := bitPos % 8
		// Low bits of the septet go into the current octet.
		out[octetIdx] |= byte(s << uint(bitInOctet))
		// Overflow bits spill into the next octet.
		if bitInOctet > 1 && octetIdx+1 < numOctets {
			out[octetIdx+1] |= byte(s >> uint(8-bitInOctet))
		} else if bitInOctet == 1 && octetIdx+1 < numOctets {
			// Exactly one bit spills over.
			out[octetIdx+1] |= byte(s >> 7)
		}
		bitPos += 7
	}
	return out
}

// unpackSeptets reverses packSeptets: it extracts septetCount 7-bit values from
// the packed octets, skipping fillBits leading padding bits.
func unpackSeptets(data []byte, septetCount, fillBits int) []byte {
	out := make([]byte, 0, septetCount)
	bitPos := fillBits
	for i := 0; i < septetCount; i++ {
		octetIdx := bitPos / 8
		bitInOctet := bitPos % 8
		if octetIdx >= len(data) {
			break
		}
		val := int(data[octetIdx]) >> uint(bitInOctet)
		if bitInOctet > 1 && octetIdx+1 < len(data) {
			val |= int(data[octetIdx+1]) << uint(8-bitInOctet)
		} else if bitInOctet == 1 && octetIdx+1 < len(data) {
			val |= int(data[octetIdx+1]) << 7
		}
		out = append(out, byte(val&0x7F))
		bitPos += 7
	}
	return out
}

// decodeGSM7 converts a slice of septet values (as produced by unpackSeptets)
// into a UTF-8 string, honoring the 0x1B escape for extension-table characters.
// Unknown or dangling escape sequences are rendered as a space, matching common
// modem behavior and avoiding data loss elsewhere in the message.
func decodeGSM7(septets []byte) string {
	runes := make([]rune, 0, len(septets))
	for i := 0; i < len(septets); i++ {
		s := septets[i]
		if s == gsm7Escape {
			// Next septet selects an extension character.
			i++
			if i >= len(septets) {
				runes = append(runes, ' ')
				break
			}
			if r, ok := gsm7ExtensionReverse[septets[i]]; ok {
				runes = append(runes, r)
			} else {
				// Unknown extension: per spec, an unsupported escape resolves
				// to a space.
				runes = append(runes, ' ')
			}
			continue
		}
		if int(s) < len(gsm7DefaultAlphabet) {
			runes = append(runes, gsm7DefaultAlphabet[s])
		}
	}
	return string(runes)
}
