package sms

import (
	"encoding/binary"
	"unicode/utf16"
)

// GSM-7 basic character set (3GPP TS 23.038).
// This includes the default alphabet characters that can be encoded
// in 7 bits. Characters outside this set require UCS-2 encoding.
var gsm7BasicSet = map[rune]bool{
	// Standard ASCII-range characters in GSM-7
	'@': true, '£': true, '$': true, '¥': true,
	'è': true, 'é': true, 'ù': true, 'ì': true,
	'ò': true, 'Ç': true, '\n': true, 'Ø': true,
	'ø': true, '\r': true, 'Å': true, 'å': true,
	'Δ': true, '_': true, 'Φ': true, 'Γ': true,
	'Λ': true, 'Ω': true, 'Π': true, 'Ψ': true,
	'Σ': true, 'Θ': true, 'Ξ': true,
	// Escape character (0x1B) not included as a printable char
	'Æ': true, 'æ': true, 'ß': true, 'É': true,
	' ': true, '!': true, '"': true, '#': true,
	'¤': true, '%': true, '&': true, '\'': true,
	'(': true, ')': true, '*': true, '+': true,
	',': true, '-': true, '.': true, '/': true,
	'0': true, '1': true, '2': true, '3': true,
	'4': true, '5': true, '6': true, '7': true,
	'8': true, '9': true, ':': true, ';': true,
	'<': true, '=': true, '>': true, '?': true,
	'¡': true, 'A': true, 'B': true, 'C': true,
	'D': true, 'E': true, 'F': true, 'G': true,
	'H': true, 'I': true, 'J': true, 'K': true,
	'L': true, 'M': true, 'N': true, 'O': true,
	'P': true, 'Q': true, 'R': true, 'S': true,
	'T': true, 'U': true, 'V': true, 'W': true,
	'X': true, 'Y': true, 'Z': true, 'Ä': true,
	'Ö': true, 'Ñ': true, 'Ü': true, '§': true,
	'¿': true, 'a': true, 'b': true, 'c': true,
	'd': true, 'e': true, 'f': true, 'g': true,
	'h': true, 'i': true, 'j': true, 'k': true,
	'l': true, 'm': true, 'n': true, 'o': true,
	'p': true, 'q': true, 'r': true, 's': true,
	't': true, 'u': true, 'v': true, 'w': true,
	'x': true, 'y': true, 'z': true, 'ä': true,
	'ö': true, 'ñ': true, 'ü': true, 'à': true,
	// GSM-7 extension table characters (accessed via escape 0x1B)
	// These are still valid GSM-7 characters.
	'^': true, '{': true, '}': true, '\\': true,
	'[': true, '~': true, ']': true, '|': true,
	'€': true,
}

// NeedsUCS2 returns true if the text contains any character that is not
// part of the GSM-7 basic character set (including the extension table).
// If true, UCS-2 encoding must be used for SMS transmission.
func NeedsUCS2(text string) bool {
	for _, r := range text {
		if !gsm7BasicSet[r] {
			return true
		}
	}
	return false
}

// EncodeUCS2 encodes a Go string as UCS-2 big-endian bytes.
// Characters in the Basic Multilingual Plane (BMP) are encoded as 2 bytes each.
// Characters outside the BMP are encoded as surrogate pairs (4 bytes).
func EncodeUCS2(text string) []byte {
	encoded := utf16.Encode([]rune(text))
	result := make([]byte, len(encoded)*2)
	for i, u := range encoded {
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
