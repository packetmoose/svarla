package audio

import (
	"testing"
)

func TestNeedsResampling(t *testing.T) {
	if NeedsResampling(16000) {
		t.Error("expected false for 16000")
	}
	if !NeedsResampling(8000) {
		t.Error("expected true for 8000")
	}
}

func TestUpsample8to16_OutputLength(t *testing.T) {
	in := make([]int16, 160) // standard 8kHz frame
	out := Upsample8to16(in)
	if len(out) != 320 {
		t.Errorf("expected 320 samples, got %d", len(out))
	}
}

func TestUpsample8to16_Interpolation(t *testing.T) {
	in := []int16{100, 200, 300, 400}
	out := Upsample8to16(in)
	// Expected: [100, 150, 200, 250, 300, 350, 400, 400]
	expected := []int16{100, 150, 200, 250, 300, 350, 400, 400}
	if len(out) != len(expected) {
		t.Fatalf("expected length %d, got %d", len(expected), len(out))
	}
	for i, v := range expected {
		if out[i] != v {
			t.Errorf("out[%d] = %d, want %d", i, out[i], v)
		}
	}
}

func TestDownsample16to8_OutputLength(t *testing.T) {
	in := make([]int16, 320) // standard 16kHz frame
	out := Downsample16to8(in)
	if len(out) != 160 {
		t.Errorf("expected 160 samples, got %d", len(out))
	}
}

func TestDownsample16to8_Averaging(t *testing.T) {
	in := []int16{100, 200, 300, 400, 500, 600, 700, 800}
	out := Downsample16to8(in)
	// Expected: [(100+200)/2, (300+400)/2, (500+600)/2, (700+800)/2] = [150, 350, 550, 750]
	expected := []int16{150, 350, 550, 750}
	if len(out) != len(expected) {
		t.Fatalf("expected length %d, got %d", len(expected), len(out))
	}
	for i, v := range expected {
		if out[i] != v {
			t.Errorf("out[%d] = %d, want %d", i, out[i], v)
		}
	}
}

func TestUpsample8to16_Empty(t *testing.T) {
	out := Upsample8to16(nil)
	if out != nil {
		t.Errorf("expected nil for empty input, got %v", out)
	}
}

func TestDownsample16to8_Empty(t *testing.T) {
	out := Downsample16to8(nil)
	if out != nil {
		t.Errorf("expected nil for empty input, got %v", out)
	}
}

func TestUpsampleFrame_Size(t *testing.T) {
	frame := make([]byte, FrameSize8kHz) // 320 bytes
	out := UpsampleFrame(frame)
	if len(out) != FrameSize16kHz {
		t.Errorf("expected %d bytes, got %d", FrameSize16kHz, len(out))
	}
}

func TestDownsampleFrame_Size(t *testing.T) {
	frame := make([]byte, FrameSize16kHz) // 640 bytes
	out := DownsampleFrame(frame)
	if len(out) != FrameSize8kHz {
		t.Errorf("expected %d bytes, got %d", FrameSize8kHz, len(out))
	}
}

func TestUpsampleFrame_ByteConversion(t *testing.T) {
	// Verify byte-level functions correctly convert and produce expected sizes.
	samples := make([]int16, 160)
	for i := range samples {
		samples[i] = int16(i * 100)
	}
	frame := samplesToBytes(samples)

	upsampled := UpsampleFrame(frame)
	if len(upsampled) != FrameSize16kHz {
		t.Errorf("UpsampleFrame: expected %d bytes, got %d", FrameSize16kHz, len(upsampled))
	}

	// Verify upsampled samples match the sample-level function output.
	expectedSamples := Upsample8to16(samples)
	actualSamples := bytesToSamples(upsampled)
	for i, v := range expectedSamples {
		if actualSamples[i] != v {
			t.Errorf("upsampled[%d] = %d, want %d", i, actualSamples[i], v)
			break
		}
	}
}

func TestDownsampleFrame_ByteConversion(t *testing.T) {
	// Verify byte-level functions correctly convert and produce expected sizes.
	samples := make([]int16, 320)
	for i := range samples {
		samples[i] = int16(i * 50)
	}
	frame := samplesToBytes(samples)

	downsampled := DownsampleFrame(frame)
	if len(downsampled) != FrameSize8kHz {
		t.Errorf("DownsampleFrame: expected %d bytes, got %d", FrameSize8kHz, len(downsampled))
	}

	// Verify downsampled samples match the sample-level function output.
	expectedSamples := Downsample16to8(samples)
	actualSamples := bytesToSamples(downsampled)
	for i, v := range expectedSamples {
		if actualSamples[i] != v {
			t.Errorf("downsampled[%d] = %d, want %d", i, actualSamples[i], v)
			break
		}
	}
}
