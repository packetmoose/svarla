package audio

import (
	"encoding/binary"
)

// NeedsResampling returns true if the modem's native PCM sample rate
// differs from the 16kHz wire rate used on the Audio WebSocket.
func NeedsResampling(nativeRate int) bool {
	return nativeRate != 16000
}

// Upsample8to16 upsamples a slice of 8kHz PCM samples to 16kHz using
// linear interpolation. For each adjacent pair s[i], s[i+1], two output
// samples are produced: s[i] and the average (s[i]+s[i+1])/2.
// The last sample is duplicated since there is no next sample to interpolate with.
// For N input samples, the output contains exactly 2N samples.
func Upsample8to16(samples []int16) []int16 {
	n := len(samples)
	if n == 0 {
		return nil
	}

	out := make([]int16, 2*n)
	for i := 0; i < n-1; i++ {
		out[2*i] = samples[i]
		out[2*i+1] = int16((int32(samples[i]) + int32(samples[i+1])) / 2)
	}
	// Last sample: no next sample to interpolate, duplicate it.
	out[2*(n-1)] = samples[n-1]
	out[2*(n-1)+1] = samples[n-1]

	return out
}

// Downsample16to8 downsamples a slice of 16kHz PCM samples to 8kHz by
// averaging each pair of adjacent samples. For each pair s[2i], s[2i+1],
// one output sample is produced: (s[2i]+s[2i+1])/2.
// For M input samples, the output contains M/2 samples.
// If M is odd, the last sample is used as-is.
func Downsample16to8(samples []int16) []int16 {
	n := len(samples)
	if n == 0 {
		return nil
	}

	outLen := n / 2
	if n%2 != 0 {
		outLen++
	}
	out := make([]int16, outLen)

	for i := 0; i < n/2; i++ {
		out[i] = int16((int32(samples[2*i]) + int32(samples[2*i+1])) / 2)
	}
	// Handle odd trailing sample.
	if n%2 != 0 {
		out[outLen-1] = samples[n-1]
	}

	return out
}

// UpsampleFrame converts a 320-byte 8kHz PCM frame (160 samples, little-endian
// 16-bit signed) to a 640-byte 16kHz PCM frame (320 samples) using linear
// interpolation.
func UpsampleFrame(frame []byte) []byte {
	samples := bytesToSamples(frame)
	upsampled := Upsample8to16(samples)
	return samplesToBytes(upsampled)
}

// DownsampleFrame converts a 640-byte 16kHz PCM frame (320 samples, little-endian
// 16-bit signed) to a 320-byte 8kHz PCM frame (160 samples) using averaging.
func DownsampleFrame(frame []byte) []byte {
	samples := bytesToSamples(frame)
	downsampled := Downsample16to8(samples)
	return samplesToBytes(downsampled)
}

// bytesToSamples converts a little-endian byte slice to int16 PCM samples.
func bytesToSamples(data []byte) []int16 {
	n := len(data) / 2
	samples := make([]int16, n)
	for i := 0; i < n; i++ {
		samples[i] = int16(binary.LittleEndian.Uint16(data[2*i : 2*i+2]))
	}
	return samples
}

// samplesToBytes converts int16 PCM samples to a little-endian byte slice.
func samplesToBytes(samples []int16) []byte {
	data := make([]byte, len(samples)*2)
	for i, s := range samples {
		binary.LittleEndian.PutUint16(data[2*i:2*i+2], uint16(s))
	}
	return data
}
