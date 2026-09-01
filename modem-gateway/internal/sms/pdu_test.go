package sms

import (
	"strings"
	"testing"
)

func TestEncodeMessageGSM7Vector(t *testing.T) {
	// Reference SMS-SUBMIT: SMSC=00, to +447785016005, GSM-7 "hellohello".
	parts, err := encodeMessage("+447785016005", "hellohello", 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(parts) != 1 {
		t.Fatalf("parts = %d, want 1", len(parts))
	}
	const wantPDU = "0011000C914477581006500000AA0AE8329BFD4697D9EC37"
	if parts[0].PDU != wantPDU {
		t.Errorf("PDU  = %s\nwant = %s", parts[0].PDU, wantPDU)
	}
	// TPDULen = PDU octets excluding the 1-octet SMSC field.
	if parts[0].TPDULen != 23 {
		t.Errorf("TPDULen = %d, want 23", parts[0].TPDULen)
	}
}

func TestEncodeMessageRequestSRSetsFlags(t *testing.T) {
	// With requestSR, the TP first octet must set TP-SRR (0x20). Base FO is
	// 0x11 (SUBMIT + relative VP); with SRR it becomes 0x31.
	parts, _ := encodeMessage("+123", "hi", 0, true)
	tpdu := parts[0].PDU[2:] // strip SMSC "00"
	if !strings.HasPrefix(tpdu, "31") {
		t.Errorf("TP-FO = %s, want prefix 31 (SUBMIT+VP+SRR)", tpdu[:2])
	}
}

func TestEncodeMessageUCS2(t *testing.T) {
	// Emoji forces UCS-2 (DCS 0x08); 😀 = surrogate pair D83D DE00.
	parts, err := encodeMessage("+123", "😀", 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(parts) != 1 {
		t.Fatalf("parts = %d, want 1", len(parts))
	}
	pdu := parts[0].PDU
	if !strings.Contains(pdu, "D83DDE00") {
		t.Errorf("UCS-2 PDU missing surrogate pair: %s", pdu)
	}
	// DCS octet 08 should appear after PID (00). The UD length for one emoji is
	// 4 octets (04).
	if !strings.Contains(pdu, "0008AA04D83DDE00") {
		t.Errorf("UCS-2 PDU tail unexpected: %s", pdu)
	}
}

func TestEncodeMessageConcatGSM7(t *testing.T) {
	// 200 ASCII chars > 160 single-part limit -> 2 GSM-7 parts (153 + 47).
	body := strings.Repeat("a", 200)
	parts, err := encodeMessage("+123", body, 0x2A, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(parts) != 2 {
		t.Fatalf("parts = %d, want 2", len(parts))
	}
	// Both parts must carry a concat UDH: TP-UDHI (0x40) set, and the UDH bytes
	// 0500032A02<seq> appear. FO base 0x11 + SRR 0x20 + UDHI 0x40 = 0x71.
	for i, p := range parts {
		tpdu := p.PDU[2:]
		if !strings.HasPrefix(tpdu, "71") {
			t.Errorf("part %d TP-FO = %s, want 71", i+1, tpdu[:2])
		}
	}
	if !strings.Contains(parts[0].PDU, "0500032A0201") {
		t.Errorf("part 1 missing concat UDH seq 1: %s", parts[0].PDU)
	}
	if !strings.Contains(parts[1].PDU, "0500032A0202") {
		t.Errorf("part 2 missing concat UDH seq 2: %s", parts[1].PDU)
	}
}

func TestEncodeMessageConcatUCS2(t *testing.T) {
	// 80 UCS-2 units (Cyrillic) > 70 single-part limit -> 2 parts (67 + 13).
	body := strings.Repeat("Ы", 80)
	parts, err := encodeMessage("+123", body, 0x05, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(parts) != 2 {
		t.Fatalf("parts = %d, want 2", len(parts))
	}
}

func TestEncodeMessageSinglePartBoundaries(t *testing.T) {
	// Exactly 160 GSM-7 chars = single part; 161 = two parts.
	if parts, _ := encodeMessage("+1", strings.Repeat("a", 160), 1, false); len(parts) != 1 {
		t.Errorf("160 chars -> %d parts, want 1", len(parts))
	}
	if parts, _ := encodeMessage("+1", strings.Repeat("a", 161), 1, false); len(parts) != 2 {
		t.Errorf("161 chars -> %d parts, want 2", len(parts))
	}
	// Exactly 70 UCS-2 units = single part; 71 = two parts.
	if parts, _ := encodeMessage("+1", strings.Repeat("Ы", 70), 1, false); len(parts) != 1 {
		t.Errorf("70 UCS-2 units -> %d parts, want 1", len(parts))
	}
	if parts, _ := encodeMessage("+1", strings.Repeat("Ы", 71), 1, false); len(parts) != 2 {
		t.Errorf("71 UCS-2 units -> %d parts, want 2", len(parts))
	}
}

func TestEncodeAddress(t *testing.T) {
	tests := []struct {
		name       string
		number     string
		wantTOA    byte
		wantDigits string
		wantCount  int
	}{
		{"international even", "+447785016005", 0x91, "447758100650", 12},
		{"national even", "12345678", 0x81, "21436587", 8},
		{"international odd", "+1234567", 0x91, "214365F7", 7},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			toa, digits, count := encodeAddress(tc.number)
			if toa != tc.wantTOA {
				t.Errorf("toa = %02X, want %02X", toa, tc.wantTOA)
			}
			if strings.ToUpper(digits) != tc.wantDigits {
				t.Errorf("digits = %s, want %s", digits, tc.wantDigits)
			}
			if count != tc.wantCount {
				t.Errorf("count = %d, want %d", count, tc.wantCount)
			}
		})
	}
}

func TestConcatUDH(t *testing.T) {
	udh := concatUDH(0x2A, 3, 2)
	want := []byte{0x05, 0x00, 0x03, 0x2A, 0x03, 0x02}
	if len(udh) != len(want) {
		t.Fatalf("udh len = %d, want %d", len(udh), len(want))
	}
	for i := range want {
		if udh[i] != want[i] {
			t.Errorf("udh[%d] = %02X, want %02X", i, udh[i], want[i])
		}
	}
}
