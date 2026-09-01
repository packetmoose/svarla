package sms

import (
	"encoding/binary"
	"unicode/utf16"
)

// NeedsUCS2 returns true if the text cannot be represented in the GSM-7
// default alphabet (including its extension table) and therefore must be sent
// as UCS-2.
//
// In PDU mode we build the user-data octets ourselves (see gsm7.go and pdu.go),
// so — unlike the old AT+CSCS text-mode path — there is no charset ambiguity:
// any GSM-7-encodable string (å ä ö è é €, brackets, etc.) is sent as GSM-7 at
// full capacity, and only genuinely out-of-alphabet characters (emoji, CJK,
// Cyrillic, smart quotes, …) force UCS-2. This mirrors how phones choose the
// encoding per message.
func NeedsUCS2(text string) bool {
	return !CanEncodeGSM7(text)
}

// EncodeUCS2 encodes a Go string as UCS-2 big-endian bytes.
// Characters in the Basic Multilingual Plane (BMP) are encoded as 2 bytes each.
// Characters outside the BMP are encoded as surrogate pairs (4 bytes).
func EncodeUCS2(text string) []byte {
	return ucs2Bytes(utf16Units(text))
}

// utf16Units returns the UTF-16 code units of a string. Characters outside the
// BMP become a high/low surrogate pair (two units). Used for UCS-2 part
// splitting where surrogate pairs must not be separated.
func utf16Units(text string) []uint16 {
	return utf16.Encode([]rune(text))
}

// ucs2Bytes serializes UTF-16 code units to big-endian bytes (UCS-2).
func ucs2Bytes(units []uint16) []byte {
	result := make([]byte, len(units)*2)
	for i, u := range units {
		binary.BigEndian.PutUint16(result[i*2:], u)
	}
	return result
}

// DecodeUCS2 decodes UCS-2 big-endian bytes into a Go string.
// Handles surrogate pairs for characters outside the BMP.
// If the input has an odd number of bytes, the trailing byte is ignored.
func DecodeUCS2(data []byte) string {
	if len(data) < 2 {
		return ""
	}

	// Truncate to even length.
	n := len(data) / 2
	units := make([]uint16, n)
	for i := 0; i < n; i++ {
		units[i] = binary.BigEndian.Uint16(data[i*2:])
	}

	runes := utf16.Decode(units)
	return string(runes)
}
