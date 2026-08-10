package bridge

import (
	"math"
	"testing"
)

func TestLinearToUlawRoundtrip(t *testing.T) {
	// Test that encode → decode roundtrip preserves signal within G.711 quantization error.
	// G.711 µ-law has ~14-bit dynamic range, so expect some quantization noise.
	testCases := []struct {
		name  string
		input int16
	}{
		{"zero", 0},
		{"positive small", 100},
		{"positive medium", 5000},
		{"positive large", 30000},
		{"negative small", -100},
		{"negative medium", -5000},
		{"negative large", -30000},
		{"max positive", 32635},   // clip level
		{"max negative", -32635},  // clip level
		{"near zero positive", 1},
		{"near zero negative", -1},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			encoded := LinearToUlaw(tc.input)
			decoded := UlawToLinear(encoded)

			// Calculate relative error. µ-law should preserve signal within ~2% for
			// medium/large values, wider margin for small values near zero.
			if tc.input == 0 {
				// Zero encodes to a specific small value in µ-law.
				if abs16(decoded) > 128 {
					t.Errorf("zero roundtrip: got %d, expected near 0", decoded)
				}
				return
			}

			// For non-zero values, check that the sign is preserved and magnitude is close.
			if (tc.input > 0 && decoded <= 0) || (tc.input < 0 && decoded >= 0) {
				// Allow zero-crossing only for very small values.
				if abs16(tc.input) > 10 {
					t.Errorf("sign mismatch: input=%d, decoded=%d", tc.input, decoded)
				}
				return
			}

			// Relative error check for non-trivial values.
			if abs16(tc.input) > 100 {
				relError := math.Abs(float64(decoded-tc.input)) / math.Abs(float64(tc.input))
				if relError > 0.05 { // 5% tolerance for µ-law quantization
					t.Errorf("roundtrip error too large: input=%d, decoded=%d, relError=%.2f%%",
						tc.input, decoded, relError*100)
				}
			}
		})
	}
}

func TestEncodeDecodeUlawBuffer(t *testing.T) {
	// Test bulk encode/decode with a sine wave.
	const numSamples = 160 // one 20ms frame at 8kHz
	input := make([]int16, numSamples)

	// Generate a 1kHz sine wave at 8kHz sample rate.
	for i := range input {
		phase := 2.0 * math.Pi * 1000.0 * float64(i) / 8000.0
		input[i] = int16(math.Sin(phase) * 20000)
	}

	// Encode then decode.
	encoded := EncodeUlaw(input)
	decoded := DecodeUlaw(encoded)

	if len(encoded) != numSamples {
		t.Fatalf("encoded length: got %d, want %d", len(encoded), numSamples)
	}
	if len(decoded) != numSamples {
		t.Fatalf("decoded length: got %d, want %d", len(decoded), numSamples)
	}

	// Verify signal integrity — compute SNR.
	var signalPower, noisePower float64
	for i := range input {
		sig := float64(input[i])
		noise := float64(decoded[i]) - sig
		signalPower += sig * sig
		noisePower += noise * noise
	}

	if signalPower == 0 {
		t.Fatal("signal power is zero")
	}

	snrDB := 10 * math.Log10(signalPower/noisePower)
	// G.711 µ-law typically achieves 35-40 dB SNR for speech-level signals.
	if snrDB < 30 {
		t.Errorf("SNR too low: %.1f dB (expected > 30 dB)", snrDB)
	}
}

func TestUlawDecodeConsistency(t *testing.T) {
	// Verify that encoding then decoding produces consistent results
	// across the full range of µ-law byte values (0-255).
	for i := 0; i < 256; i++ {
		decoded := UlawToLinear(byte(i))
		reEncoded := LinearToUlaw(decoded)
		reDecoded := UlawToLinear(reEncoded)

		// After one roundtrip through decode→encode→decode,
		// the value should be stable (fixed point).
		if reDecoded != decoded {
			t.Errorf("instability at byte %d: decoded=%d, re-decoded=%d",
				i, decoded, reDecoded)
		}
	}
}

func TestUlawSymmetry(t *testing.T) {
	// Positive and negative values of same magnitude should encode to values
	// that differ only in the sign bit (bit 7).
	for sample := int16(100); sample < 30000; sample += 1000 {
		posEnc := LinearToUlaw(sample)
		negEnc := LinearToUlaw(-sample)

		// In µ-law, the sign bit is bit 7 (0x80). After complementing,
		// positive and negative encodings should differ only in bit 7.
		if (posEnc ^ negEnc) != 0x80 {
			t.Errorf("asymmetry at ±%d: pos=0x%02x, neg=0x%02x, xor=0x%02x",
				sample, posEnc, negEnc, posEnc^negEnc)
		}
	}
}

func abs16(v int16) int16 {
	if v < 0 {
		return -v
	}
	return v
}
