package sms

import (
	"fmt"
	"testing"
)

func TestCanEncodeGSM7(t *testing.T) {
	tests := []struct {
		name string
		text string
		want bool
	}{
		{"ascii", "Hello, world! 123", true},
		{"swedish", "jåå åäö ÅÄÖ", true},
		{"latin1 gsm7 accents", "èéùìòÇØøÆæßÉ àñü", true},
		{"greek", "ΔΦΓΛΩΠΨΣΘΞ", true},
		{"extension table", "^{}\\[~]|€", true},
		{"newline and cr", "a\r\nb", true},
		{"emoji", "😀", false},
		{"cyrillic", "Привет", false},
		{"chinese", "你好", false},
		{"smart quote", "\u201c", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := CanEncodeGSM7(tc.text); got != tc.want {
				t.Errorf("CanEncodeGSM7(%q) = %v, want %v", tc.text, got, tc.want)
			}
		})
	}
}

func TestGSM7SeptetsEscapeExpansion(t *testing.T) {
	// '€' is an extension char: it expands to ESC(0x1B) + 0x65.
	sept, ok := gsm7Septets("€")
	if !ok {
		t.Fatal("€ should be GSM-7 encodable")
	}
	if len(sept) != 2 || sept[0] != gsm7Escape || sept[1] != 0x65 {
		t.Errorf("septets for € = % X, want 1B 65", sept)
	}

	// A plain char is a single septet.
	sept, _ = gsm7Septets("A")
	if len(sept) != 1 || sept[0] != 0x41 {
		t.Errorf("septets for A = % X, want 41", sept)
	}

	// Non-encodable returns ok=false.
	if _, ok := gsm7Septets("😀"); ok {
		t.Error("gsm7Septets should fail on emoji")
	}
}

func TestPackSeptetsCanonicalVector(t *testing.T) {
	// 3GPP TS 23.038 canonical example: "hellohello" packs to the octets below.
	sept, _ := gsm7Septets("hellohello")
	packed := packSeptets(sept, 0)
	got := ""
	for _, b := range packed {
		got += fmt.Sprintf("%02X", b)
	}
	const want = "E8329BFD4697D9EC37"
	if got != want {
		t.Errorf("packSeptets(hellohello) = %s, want %s", got, want)
	}
}

func TestGSM7RoundTrip(t *testing.T) {
	tests := []struct {
		name     string
		text     string
		fillBits int
	}{
		{"ascii no fill", "Hello world", 0},
		{"swedish no fill", "jåå på gården", 0},
		{"extension chars no fill", "cost 5€ [ok] {x}", 0},
		{"ascii fill1 (concat align)", "Hello world", 1},
		{"swedish fill1", "Jag heter Åsa", 1},
		{"greek fill1", "ΔΦΓ test", 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			sept, ok := gsm7Septets(tc.text)
			if !ok {
				t.Fatalf("%q not GSM-7 encodable", tc.text)
			}
			packed := packSeptets(sept, tc.fillBits)
			unpacked := unpackSeptets(packed, len(sept), tc.fillBits)
			got := decodeGSM7(unpacked)
			if got != tc.text {
				t.Errorf("round trip: %q -> %q", tc.text, got)
			}
		})
	}
}

func TestDecodeGSM7DanglingEscape(t *testing.T) {
	// A trailing lone escape should decode to a space, not panic or drop chars.
	got := decodeGSM7([]byte{0x41, gsm7Escape})
	if got != "A " {
		t.Errorf("dangling escape decode = %q, want %q", got, "A ")
	}
	// An unknown extension code also resolves to a space.
	got = decodeGSM7([]byte{gsm7Escape, 0x7F})
	if got != " " {
		t.Errorf("unknown escape decode = %q, want %q", got, " ")
	}
}
