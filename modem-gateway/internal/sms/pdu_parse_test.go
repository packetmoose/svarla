package sms

import (
	"fmt"
	"strings"
	"testing"
)

// addrHex builds a PDU address field (length + TOA + swapped digits) for tests.
func addrHex(num string) string {
	toa, digits, cnt := encodeAddress(num)
	return fmt.Sprintf("%02X%02X%s", cnt, toa, strings.ToUpper(digits))
}

// A fixed valid SCTS (7 octets) for building DELIVER test PDUs.
const testSCTS = "11207041124400"

func TestParseDeliverGSM7(t *testing.T) {
	// SMSC=00, FO=04 (DELIVER, no UDH), OA=+447785016005, PID=00, DCS=00,
	// SCTS, UDL=0A, UD="hellohello".
	pdu := "0004" + addrHex("+447785016005") + "0000" + testSCTS + "0AE8329BFD4697D9EC37"
	m, err := parseDeliverPDU(pdu)
	if err != nil {
		t.Fatal(err)
	}
	if m.Sender != "+447785016005" {
		t.Errorf("sender = %q", m.Sender)
	}
	if m.Body != "hellohello" {
		t.Errorf("body = %q", m.Body)
	}
	if m.Concat != nil {
		t.Errorf("unexpected concat info")
	}
	if m.Timestamp.IsZero() {
		t.Errorf("timestamp not parsed")
	}
}

func TestParseDeliverUCS2(t *testing.T) {
	// DCS=08 (UCS-2), UD="å" (00E5), UDL=02.
	pdu := "0004" + addrHex("+123") + "0008" + testSCTS + "0200E5"
	m, err := parseDeliverPDU(pdu)
	if err != nil {
		t.Fatal(err)
	}
	if m.Body != "å" {
		t.Errorf("body = %q, want å", m.Body)
	}
}

func TestParseDeliverConcat(t *testing.T) {
	// DELIVER with UDHI. UD = concat UDH (ref=03,total=03,seq=01) + "Hi" packed
	// with fillBits=1 (matching how a sender byte-aligns after a 6-octet UDH).
	sept, _ := gsm7Septets("Hi")
	packed := packSeptets(sept, 1)
	udh := concatUDH(0x03, 3, 1)
	ud := append(append([]byte{}, udh...), packed...)
	udl := 7 + len(sept) // 7 septet positions for UDH+fill, then message septets

	var b strings.Builder
	b.WriteString("0044") // FO=44: DELIVER + UDHI
	b.WriteString(addrHex("+123"))
	b.WriteString("0000") // PID, DCS(GSM-7)
	b.WriteString(testSCTS)
	b.WriteString(fmt.Sprintf("%02X", udl))
	for _, o := range ud {
		b.WriteString(fmt.Sprintf("%02X", o))
	}

	m, err := parseDeliverPDU(b.String())
	if err != nil {
		t.Fatal(err)
	}
	if m.Body != "Hi" {
		t.Errorf("body = %q, want Hi", m.Body)
	}
	if m.Concat == nil {
		t.Fatal("expected concat info")
	}
	if m.Concat.RefNum != 3 || m.Concat.TotalParts != 3 || m.Concat.SeqNum != 1 {
		t.Errorf("concat = %+v, want ref=3 total=3 seq=1", *m.Concat)
	}
}

func TestParseDeliverAlphanumericSender(t *testing.T) {
	// Alphanumeric OA: TOA 0xD0, addrLen in semi-octets. "SMS" as GSM-7 packed.
	// "SMS" septets: S=0x53, M=0x4D, S=0x53. Packed (3 septets) -> D3 32 15? Build
	// via packer to avoid hand-calc mistakes.
	sept, _ := gsm7Septets("SMS")
	packed := packSeptets(sept, 0)
	// addrLen for alphanumeric = number of packed semi-octets = len(packed)*2.
	addrLen := len(packed) * 2
	var b strings.Builder
	b.WriteString("0004")
	b.WriteString(fmt.Sprintf("%02X", addrLen))
	b.WriteString("D0") // alphanumeric TOA
	for _, o := range packed {
		b.WriteString(fmt.Sprintf("%02X", o))
	}
	b.WriteString("0000") // PID, DCS
	b.WriteString(testSCTS)
	b.WriteString("02" + "C9F6") // UDL + some GSM-7 body "Hi"-ish (content not asserted)

	m, err := parseDeliverPDU(b.String())
	if err != nil {
		t.Fatal(err)
	}
	if m.Sender != "SMS" {
		t.Errorf("alphanumeric sender = %q, want SMS", m.Sender)
	}
}

func TestParseStatusReport(t *testing.T) {
	tests := []struct {
		name   string
		st     string
		want   string
		wantMR int
	}{
		{"delivered", "00", "DELIVERED", 42},
		{"pending temp error", "20", "UNKNOWN", 42},
		{"permanent failure", "44", "FAILED", 42},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			// SMSC=00, FO=02 (STATUS-REPORT), MR=2A, RA, SCTS, DT, ST.
			pdu := "00" + "02" + "2A" + addrHex("+123") + testSCTS + testSCTS + tc.st
			rep, err := parseStatusReportPDU(pdu)
			if err != nil {
				t.Fatal(err)
			}
			if rep.MessageRef != tc.wantMR {
				t.Errorf("ref = %d, want %d", rep.MessageRef, tc.wantMR)
			}
			if rep.Status != tc.want {
				t.Errorf("status = %s, want %s", rep.Status, tc.want)
			}
		})
	}
}

func TestPDUMTI(t *testing.T) {
	deliver := "0004" + addrHex("+123") + "0000" + testSCTS + "0200E5"
	if mti := pduMTI(deliver); mti != 0 {
		t.Errorf("deliver MTI = %d, want 0", mti)
	}
	report := "00" + "02" + "2A" + addrHex("+123") + testSCTS + testSCTS + "00"
	if mti := pduMTI(report); mti != 2 {
		t.Errorf("status-report MTI = %d, want 2", mti)
	}
	if mti := pduMTI("not hex!!"); mti != -1 {
		t.Errorf("garbage MTI = %d, want -1", mti)
	}
}

func TestParseSCTS(t *testing.T) {
	// 11207041124400 => swapped BCD: year 11->2011... decode and sanity check.
	b, err := hexToBytes(testSCTS)
	if err != nil {
		t.Fatal(err)
	}
	ts := parseSCTS(b)
	if ts.IsZero() {
		t.Fatal("SCTS parsed as zero")
	}
	if ts.Year() != 2011 {
		t.Errorf("year = %d, want 2011", ts.Year())
	}
}
