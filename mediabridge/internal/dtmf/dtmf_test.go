package dtmf

import (
	"log/slog"
	"os"
	"sync"
	"testing"
)

func TestParsePayload(t *testing.T) {
	tests := []struct {
		name     string
		data     []byte
		expected Event
		wantErr  bool
	}{
		{
			name: "digit 5, no end bit, volume 10, duration 160",
			data: []byte{0x05, 0x0A, 0x00, 0xA0},
			expected: Event{
				EventCode: 5,
				End:       false,
				Volume:    10,
				Duration:  160,
			},
		},
		{
			name: "digit 0, end bit set, volume 0, duration 800",
			data: []byte{0x00, 0x80, 0x03, 0x20},
			expected: Event{
				EventCode: 0,
				End:       true,
				Volume:    0,
				Duration:  800,
			},
		},
		{
			name: "star (code 10), end bit set, volume 20, duration 1600",
			data: []byte{0x0A, 0x94, 0x06, 0x40},
			expected: Event{
				EventCode: 10,
				End:       true,
				Volume:    20,
				Duration:  1600,
			},
		},
		{
			name: "hash (code 11), no end bit, volume 63, duration 65535",
			data: []byte{0x0B, 0x3F, 0xFF, 0xFF},
			expected: Event{
				EventCode: 11,
				End:       false,
				Volume:    63,
				Duration:  65535,
			},
		},
		{
			name: "A (code 12), end bit, volume 5, duration 320",
			data: []byte{0x0C, 0x85, 0x01, 0x40},
			expected: Event{
				EventCode: 12,
				End:       true,
				Volume:    5,
				Duration:  320,
			},
		},
		{
			name:    "too short payload",
			data:    []byte{0x05, 0x00},
			wantErr: true,
		},
		{
			name:    "empty payload",
			data:    []byte{},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			evt, err := ParsePayload(tt.data)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if evt.EventCode != tt.expected.EventCode {
				t.Errorf("EventCode: got %d, want %d", evt.EventCode, tt.expected.EventCode)
			}
			if evt.End != tt.expected.End {
				t.Errorf("End: got %v, want %v", evt.End, tt.expected.End)
			}
			if evt.Volume != tt.expected.Volume {
				t.Errorf("Volume: got %d, want %d", evt.Volume, tt.expected.Volume)
			}
			if evt.Duration != tt.expected.Duration {
				t.Errorf("Duration: got %d, want %d", evt.Duration, tt.expected.Duration)
			}
		})
	}
}

func TestEncodePayload(t *testing.T) {
	tests := []struct {
		name string
		evt  Event
		want []byte
	}{
		{
			name: "digit 5, no end, volume 10, duration 160",
			evt:  Event{EventCode: 5, End: false, Volume: 10, Duration: 160},
			want: []byte{0x05, 0x0A, 0x00, 0xA0},
		},
		{
			name: "digit 0, end bit, volume 0, duration 800",
			evt:  Event{EventCode: 0, End: true, Volume: 0, Duration: 800},
			want: []byte{0x00, 0x80, 0x03, 0x20},
		},
		{
			name: "star, end bit, volume 20, duration 1600",
			evt:  Event{EventCode: 10, End: true, Volume: 20, Duration: 1600},
			want: []byte{0x0A, 0x94, 0x06, 0x40},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := EncodePayload(tt.evt)
			if len(got) != len(tt.want) {
				t.Fatalf("length: got %d, want %d", len(got), len(tt.want))
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("byte[%d]: got 0x%02X, want 0x%02X", i, got[i], tt.want[i])
				}
			}
		})
	}
}

func TestEncodeParseRoundTrip(t *testing.T) {
	events := []Event{
		{EventCode: 0, End: false, Volume: 0, Duration: 0},
		{EventCode: 9, End: true, Volume: 63, Duration: 65535},
		{EventCode: 15, End: true, Volume: 30, Duration: 1000},
		{EventCode: 10, End: false, Volume: 10, Duration: 160},
	}

	for _, evt := range events {
		encoded := EncodePayload(evt)
		decoded, err := ParsePayload(encoded)
		if err != nil {
			t.Fatalf("round-trip failed for %+v: %v", evt, err)
		}
		if decoded.EventCode != evt.EventCode {
			t.Errorf("EventCode mismatch: got %d, want %d", decoded.EventCode, evt.EventCode)
		}
		if decoded.End != evt.End {
			t.Errorf("End mismatch: got %v, want %v", decoded.End, evt.End)
		}
		if decoded.Volume != evt.Volume {
			t.Errorf("Volume mismatch: got %d, want %d", decoded.Volume, evt.Volume)
		}
		if decoded.Duration != evt.Duration {
			t.Errorf("Duration mismatch: got %d, want %d", decoded.Duration, evt.Duration)
		}
	}
}

func TestEventCodeToDigit(t *testing.T) {
	tests := []struct {
		code  uint8
		digit rune
		valid bool
	}{
		{0, '0', true},
		{1, '1', true},
		{2, '2', true},
		{3, '3', true},
		{4, '4', true},
		{5, '5', true},
		{6, '6', true},
		{7, '7', true},
		{8, '8', true},
		{9, '9', true},
		{10, '*', true},
		{11, '#', true},
		{12, 'A', true},
		{13, 'B', true},
		{14, 'C', true},
		{15, 'D', true},
		{16, 0, false},
		{255, 0, false},
	}

	for _, tt := range tests {
		digit, ok := EventCodeToDigit(tt.code)
		if ok != tt.valid {
			t.Errorf("EventCodeToDigit(%d): valid got %v, want %v", tt.code, ok, tt.valid)
		}
		if digit != tt.digit {
			t.Errorf("EventCodeToDigit(%d): digit got %q, want %q", tt.code, digit, tt.digit)
		}
	}
}

func TestDigitToEventCode(t *testing.T) {
	tests := []struct {
		digit rune
		code  uint8
		valid bool
	}{
		{'0', 0, true},
		{'5', 5, true},
		{'9', 9, true},
		{'*', 10, true},
		{'#', 11, true},
		{'A', 12, true},
		{'B', 13, true},
		{'C', 14, true},
		{'D', 15, true},
		{'a', 12, true}, // lowercase
		{'b', 13, true},
		{'c', 14, true},
		{'d', 15, true},
		{'E', 0, false},
		{'x', 0, false},
		{' ', 0, false},
	}

	for _, tt := range tests {
		code, ok := DigitToEventCode(tt.digit)
		if ok != tt.valid {
			t.Errorf("DigitToEventCode(%q): valid got %v, want %v", tt.digit, ok, tt.valid)
		}
		if ok && code != tt.code {
			t.Errorf("DigitToEventCode(%q): code got %d, want %d", tt.digit, code, tt.code)
		}
	}
}

func TestDetector_EndBitDeduplication(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))

	var mu sync.Mutex
	var detected []string

	onDigit := func(digit string) {
		mu.Lock()
		detected = append(detected, digit)
		mu.Unlock()
	}

	d := NewDetector(onDigit, logger)

	// Simulate a typical DTMF key press for digit '5':
	// Multiple non-end packets followed by end packets (redundancy).

	// Non-end packets (digit in progress).
	d.ProcessPacket(EncodePayload(Event{EventCode: 5, End: false, Volume: 10, Duration: 160}))
	d.ProcessPacket(EncodePayload(Event{EventCode: 5, End: false, Volume: 10, Duration: 320}))
	d.ProcessPacket(EncodePayload(Event{EventCode: 5, End: false, Volume: 10, Duration: 480}))

	// No digit should be reported yet.
	mu.Lock()
	if len(detected) != 0 {
		t.Fatalf("expected no digits before end bit, got %v", detected)
	}
	mu.Unlock()

	// First end packet → should report digit.
	d.ProcessPacket(EncodePayload(Event{EventCode: 5, End: true, Volume: 10, Duration: 640}))

	mu.Lock()
	if len(detected) != 1 {
		t.Fatalf("expected 1 digit after first end, got %d: %v", len(detected), detected)
	}
	if detected[0] != "5" {
		t.Errorf("expected digit '5', got %q", detected[0])
	}
	mu.Unlock()

	// Redundant end packets → should NOT report again.
	d.ProcessPacket(EncodePayload(Event{EventCode: 5, End: true, Volume: 10, Duration: 640}))
	d.ProcessPacket(EncodePayload(Event{EventCode: 5, End: true, Volume: 10, Duration: 640}))

	mu.Lock()
	if len(detected) != 1 {
		t.Fatalf("expected still 1 digit after redundant ends, got %d: %v", len(detected), detected)
	}
	mu.Unlock()
}

func TestDetector_MultipleDifferentDigits(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))

	var detected []string
	onDigit := func(digit string) {
		detected = append(detected, digit)
	}

	d := NewDetector(onDigit, logger)

	// Press '1'.
	d.ProcessPacket(EncodePayload(Event{EventCode: 1, End: false, Volume: 10, Duration: 160}))
	d.ProcessPacket(EncodePayload(Event{EventCode: 1, End: true, Volume: 10, Duration: 320}))

	// Press '*'.
	d.ProcessPacket(EncodePayload(Event{EventCode: 10, End: false, Volume: 10, Duration: 160}))
	d.ProcessPacket(EncodePayload(Event{EventCode: 10, End: true, Volume: 10, Duration: 320}))

	// Press '#'.
	d.ProcessPacket(EncodePayload(Event{EventCode: 11, End: false, Volume: 10, Duration: 160}))
	d.ProcessPacket(EncodePayload(Event{EventCode: 11, End: true, Volume: 10, Duration: 320}))

	if len(detected) != 3 {
		t.Fatalf("expected 3 digits, got %d: %v", len(detected), detected)
	}
	if detected[0] != "1" || detected[1] != "*" || detected[2] != "#" {
		t.Errorf("unexpected digits: %v", detected)
	}
}

func TestDetector_EndBitOnlyPacket(t *testing.T) {
	// Test the case where we receive an end-bit packet without prior non-end packets.
	// This can happen if intermediate packets were lost.
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))

	var detected []string
	onDigit := func(digit string) {
		detected = append(detected, digit)
	}

	d := NewDetector(onDigit, logger)

	// Only end-bit packet (no prior non-end packets).
	d.ProcessPacket(EncodePayload(Event{EventCode: 3, End: true, Volume: 10, Duration: 480}))

	if len(detected) != 1 {
		t.Fatalf("expected 1 digit from lone end-bit, got %d: %v", len(detected), detected)
	}
	if detected[0] != "3" {
		t.Errorf("expected '3', got %q", detected[0])
	}

	// Redundant end packets should not re-report.
	d.ProcessPacket(EncodePayload(Event{EventCode: 3, End: true, Volume: 10, Duration: 480}))
	if len(detected) != 1 {
		t.Fatalf("expected still 1 digit after redundant, got %d", len(detected))
	}
}

func TestDetector_SameDigitPressedTwice(t *testing.T) {
	// Test that pressing the same digit twice results in two detections.
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))

	var detected []string
	onDigit := func(digit string) {
		detected = append(detected, digit)
	}

	d := NewDetector(onDigit, logger)

	// First press of '7'.
	d.ProcessPacket(EncodePayload(Event{EventCode: 7, End: false, Volume: 10, Duration: 160}))
	d.ProcessPacket(EncodePayload(Event{EventCode: 7, End: true, Volume: 10, Duration: 320}))

	// Second press of '7' (new event sequence).
	d.ProcessPacket(EncodePayload(Event{EventCode: 7, End: false, Volume: 10, Duration: 160}))
	d.ProcessPacket(EncodePayload(Event{EventCode: 7, End: true, Volume: 10, Duration: 320}))

	if len(detected) != 2 {
		t.Fatalf("expected 2 digits, got %d: %v", len(detected), detected)
	}
	if detected[0] != "7" || detected[1] != "7" {
		t.Errorf("unexpected digits: %v", detected)
	}
}

func TestDetector_Reset(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))

	var detected []string
	onDigit := func(digit string) {
		detected = append(detected, digit)
	}

	d := NewDetector(onDigit, logger)

	// Start a digit but don't end it.
	d.ProcessPacket(EncodePayload(Event{EventCode: 9, End: false, Volume: 10, Duration: 160}))

	// Reset clears active state.
	d.Reset()

	// End packet after reset — should still detect (treated as new lone end).
	d.ProcessPacket(EncodePayload(Event{EventCode: 9, End: true, Volume: 10, Duration: 320}))

	if len(detected) != 1 {
		t.Fatalf("expected 1 digit after reset, got %d: %v", len(detected), detected)
	}
}
