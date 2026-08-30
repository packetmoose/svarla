package sms

import "testing"

func TestNeedsUCS2(t *testing.T) {
	tests := []struct {
		name string
		text string
		want bool
	}{
		{"plain ascii", "Hello world", false},
		{"ascii punctuation", "arr[0] = {a,b}; 50% @ $5", false},
		{"empty", "", false},
		// In PDU mode these are all GSM-7 encodable (default alphabet or the
		// extension table), so they stay on the efficient GSM-7 path.
		{"swedish lowercase", "jåå", false},
		{"swedish set", "åäö ÅÄÖ", false},
		{"latin1 accents in gsm7", "èéùìòÇØøÆæßÉ àäöñü§¿¡", false},
		{"euro sign", "Pay €5", false},
		{"greek letters", "ΔΦΓΛΩΠΨΣΘΞ", false},
		{"gsm7 extension symbols", "^{}\\[~]|", false},
		// Genuinely out-of-alphabet: must go UCS-2.
		{"cyrillic", "Привет", true},
		{"emoji", "hi 😀", true},
		{"chinese", "你好", true},
		{"smart quotes", "\u201chi\u201d", true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := NeedsUCS2(tc.text); got != tc.want {
				t.Errorf("NeedsUCS2(%q) = %v, want %v", tc.text, got, tc.want)
			}
		})
	}
}

// TestUCS2RoundTrip verifies that bodies encode and decode losslessly through
// the UCS-2 path, including astral-plane emoji (which require UTF-16 surrogate
// pairs).
func TestUCS2RoundTrip(t *testing.T) {
	samples := []string{
		"jåå",
		"åäö ÅÄÖ",
		"café à la carte",
		"Pay €5",
		"Привет",
		"hi 😀 there",
		"你好世界",
	}

	for _, s := range samples {
		encoded := EncodeUCS2(s)
		back := DecodeUCS2(encoded)
		if back != s {
			t.Errorf("UCS-2 round trip failed: %q -> %q", s, back)
		}
	}
}
