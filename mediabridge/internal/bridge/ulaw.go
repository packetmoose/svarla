// Package bridge implements the audio bridge pipeline between WebRTC and SIP/WS legs.
// It handles Opus ↔ G.711 µ-law transcoding, clock rate conversion, and jitter buffering.
package bridge

// G.711 µ-law encoding/decoding per ITU-T G.711.
// Reference implementation matching the standard from g711.c (Sun Microsystems / CPython / Sox).
// Uses the expLut table for fast segment lookup during encoding and a precomputed
// decode table for fast decoding.

const (
	ulawBias = 0x84  // 132 — additive bias per G.711 standard
	ulawClip = 32635 // Maximum input magnitude before clipping
)

// expLut maps (biased_sample >> 7) to segment/exponent number (0-7).
// This provides O(1) segment lookup during encoding.
var expLut = [256]int{
	0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3,
	4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
	5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
	5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
	6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
	6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
	6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
	6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
	7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
	7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
	7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
	7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
	7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
	7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
	7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
	7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
}

// ulawToLinearTable maps 8-bit µ-law to 16-bit linear PCM (precomputed for speed).
var ulawToLinearTable [256]int16

func init() {
	for i := 0; i < 256; i++ {
		ulawToLinearTable[i] = ulawDecode(byte(i))
	}
}

// ulawDecode converts a single µ-law byte to a 16-bit PCM sample.
// Formula: sample = sign * (((2*mantissa + 33) << (exponent+2)) - bias)
func ulawDecode(u byte) int16 {
	// Complement to recover the original encoded value.
	u = ^u

	sign := int16(1)
	if u&0x80 != 0 {
		sign = -1
		u &= 0x7F
	}

	exponent := int((u >> 4) & 0x07)
	mantissa := int(u & 0x0F)

	// Reconstruct the magnitude by inverting the encode process.
	// Encode took: mantissa = (biased_sample >> (exp+3)) & 0x0F
	// Decode reconstructs the midpoint of the quantization step.
	sample := int16(((2*mantissa + 33) << uint(exponent+2)) - ulawBias)

	return sign * sample
}

// LinearToUlaw encodes a 16-bit linear PCM sample to an 8-bit µ-law value.
func LinearToUlaw(sample int16) byte {
	// Extract sign and work with magnitude.
	sign := 0
	if sample < 0 {
		sign = 0x80
		sample = -sample
	}

	// Clip to maximum representable magnitude.
	if sample > ulawClip {
		sample = ulawClip
	}

	// Add bias for encoding.
	sample += ulawBias

	// Find segment using the lookup table.
	exponent := expLut[(sample>>7)&0xFF]

	// Extract 4-bit mantissa from the biased sample.
	mantissa := (int(sample) >> (exponent + 3)) & 0x0F

	// Compose the µ-law byte: sign(1) | exponent(3) | mantissa(4), then complement.
	ulawByte := byte(sign | (exponent << 4) | mantissa)
	return ^ulawByte
}

// UlawToLinear decodes an 8-bit µ-law value to a 16-bit linear PCM sample.
// Uses precomputed lookup table for maximum throughput.
func UlawToLinear(u byte) int16 {
	return ulawToLinearTable[u]
}

// EncodeUlaw encodes a buffer of 16-bit PCM samples to µ-law bytes.
func EncodeUlaw(pcm []int16) []byte {
	encoded := make([]byte, len(pcm))
	for i, sample := range pcm {
		encoded[i] = LinearToUlaw(sample)
	}
	return encoded
}

// DecodeUlaw decodes a buffer of µ-law bytes to 16-bit PCM samples.
func DecodeUlaw(ulaw []byte) []int16 {
	pcm := make([]int16, len(ulaw))
	for i, b := range ulaw {
		pcm[i] = UlawToLinear(b)
	}
	return pcm
}
