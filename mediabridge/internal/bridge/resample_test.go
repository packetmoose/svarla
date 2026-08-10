package bridge

import (
	"math"
	"testing"
)

func TestDownsample48to8Length(t *testing.T) {
	// A 20ms Opus frame at 48kHz = 960 samples → should produce 160 samples at 8kHz.
	input := make([]int16, OpusFrameSize)
	output := Downsample48to8(input)

	if len(output) != G711FrameSize {
		t.Errorf("downsample length: got %d, want %d", len(output), G711FrameSize)
	}
}

func TestUpsample8to48Length(t *testing.T) {
	// A 20ms G.711 frame at 8kHz = 160 samples → should produce 960 samples at 48kHz.
	input := make([]int16, G711FrameSize)
	output := Upsample8to48(input)

	if len(output) != OpusFrameSize {
		t.Errorf("upsample length: got %d, want %d", len(output), OpusFrameSize)
	}
}

func TestResampleRoundtripPreservesFrequency(t *testing.T) {
	// Generate a low-frequency sine wave that is within the 4kHz Nyquist limit of 8kHz.
	// After downsample → upsample, the frequency should be preserved.
	const freq = 400.0 // Hz — well within 4kHz Nyquist
	const numFrames = 5

	input48k := make([]int16, OpusFrameSize*numFrames)
	for i := range input48k {
		phase := 2.0 * math.Pi * freq * float64(i) / float64(OpusSampleRate)
		input48k[i] = int16(math.Sin(phase) * 20000)
	}

	// Downsample 48kHz → 8kHz.
	pcm8k := Downsample48to8(input48k)

	// Verify 8kHz output length.
	expected8kLen := len(input48k) / ResampleRatio
	if len(pcm8k) != expected8kLen {
		t.Fatalf("8kHz length: got %d, want %d", len(pcm8k), expected8kLen)
	}

	// Upsample 8kHz → 48kHz.
	output48k := Upsample8to48(pcm8k)

	if len(output48k) != len(input48k) {
		t.Fatalf("roundtrip length mismatch: got %d, want %d", len(output48k), len(input48k))
	}

	// Verify frequency preservation by checking zero crossings.
	// A 400Hz sine at 48kHz should have ~2 crossings per period.
	inputCrossings := countZeroCrossings(input48k[OpusFrameSize:]) // skip first frame (filter warmup)
	outputCrossings := countZeroCrossings(output48k[OpusFrameSize:])

	// Allow 10% tolerance in zero crossings.
	tolerance := float64(inputCrossings) * 0.1
	diff := math.Abs(float64(inputCrossings) - float64(outputCrossings))
	if diff > tolerance {
		t.Errorf("frequency distortion: input crossings=%d, output crossings=%d (tolerance=%.0f)",
			inputCrossings, outputCrossings, tolerance)
	}
}

func TestDownsamplePreservesSignalEnergy(t *testing.T) {
	// The downsampled signal should have similar energy (power) to the original.
	const freq = 300.0 // Hz
	input := make([]int16, OpusFrameSize)
	for i := range input {
		phase := 2.0 * math.Pi * freq * float64(i) / float64(OpusSampleRate)
		input[i] = int16(math.Sin(phase) * 15000)
	}

	output := Downsample48to8(input)

	// Calculate RMS of both signals.
	inputRMS := rms(input)
	outputRMS := rms(output)

	// RMS should be preserved within 20% (accounting for filter effects).
	ratio := outputRMS / inputRMS
	if ratio < 0.7 || ratio > 1.3 {
		t.Errorf("energy not preserved: inputRMS=%.1f, outputRMS=%.1f, ratio=%.2f",
			inputRMS, outputRMS, ratio)
	}
}

func TestUpsampleInterpolation(t *testing.T) {
	// Verify that upsampling uses interpolation (output should not have step artifacts).
	input := []int16{0, 1000, 2000, 3000, 4000, 5000, 6000, 7000}
	output := Upsample8to48(input)

	// Between each pair of input samples, the output should be monotonically
	// increasing (since input is monotonically increasing).
	for i := 0; i < len(input)-1; i++ {
		start := i * ResampleRatio
		end := (i + 1) * ResampleRatio
		for j := start; j < end-1; j++ {
			if output[j+1] < output[j] {
				t.Errorf("non-monotonic at output[%d]=%d > output[%d]=%d (input segment %d→%d)",
					j, output[j], j+1, output[j+1], i, i+1)
				break
			}
		}
	}
}

func TestResampleEmptyInput(t *testing.T) {
	down := Downsample48to8([]int16{})
	if len(down) != 0 {
		t.Errorf("downsample empty: got len %d", len(down))
	}

	up := Upsample8to48([]int16{})
	if len(up) != 0 {
		t.Errorf("upsample empty: got len %d", len(up))
	}
}

// countZeroCrossings counts the number of times the signal crosses zero.
func countZeroCrossings(samples []int16) int {
	crossings := 0
	for i := 1; i < len(samples); i++ {
		if (samples[i-1] >= 0 && samples[i] < 0) || (samples[i-1] < 0 && samples[i] >= 0) {
			crossings++
		}
	}
	return crossings
}

// rms calculates the root mean square of a signal.
func rms(samples []int16) float64 {
	if len(samples) == 0 {
		return 0
	}
	var sum float64
	for _, s := range samples {
		sum += float64(s) * float64(s)
	}
	return math.Sqrt(sum / float64(len(samples)))
}
