package bridge

// Resampler handles clock rate conversion between 48kHz (Opus) and 8kHz (G.711).
// Uses simple integer ratio resampling (6:1) which is appropriate for speech audio.

const (
	// OpusSampleRate is the Opus native sample rate.
	OpusSampleRate = 48000

	// G711SampleRate is the G.711 sample rate.
	G711SampleRate = 8000

	// ResampleRatio is the ratio between Opus and G.711 rates (48000/8000 = 6).
	ResampleRatio = OpusSampleRate / G711SampleRate

	// OpusFrameDuration is the standard frame duration in ms.
	OpusFrameDuration = 20

	// OpusFrameSize is the number of samples in a 20ms Opus frame at 48kHz.
	OpusFrameSize = OpusSampleRate * OpusFrameDuration / 1000 // 960

	// G711FrameSize is the number of samples in a 20ms G.711 frame at 8kHz.
	G711FrameSize = G711SampleRate * OpusFrameDuration / 1000 // 160
)

// Downsample48to8 converts PCM audio from 48kHz to 8kHz.
// Takes every 6th sample. Input length must be a multiple of ResampleRatio.
// For speech audio, simple decimation without an anti-aliasing filter is
// acceptable because Opus already band-limits the signal.
func Downsample48to8(input []int16) []int16 {
	outputLen := len(input) / ResampleRatio
	output := make([]int16, outputLen)

	for i := 0; i < outputLen; i++ {
		// Take the sample at position i*6, applying a simple 3-tap averaging
		// filter to reduce aliasing artifacts.
		idx := i * ResampleRatio
		// Average the center sample with its neighbors for smoother output.
		if idx > 0 && idx < len(input)-1 {
			sum := int32(input[idx-1]) + int32(input[idx])*2 + int32(input[idx+1])
			output[i] = int16(sum / 4)
		} else {
			output[i] = input[idx]
		}
	}

	return output
}

// Upsample8to48 converts PCM audio from 8kHz to 48kHz.
// Uses linear interpolation between samples for smoother output.
func Upsample8to48(input []int16) []int16 {
	outputLen := len(input) * ResampleRatio
	output := make([]int16, outputLen)

	for i := 0; i < len(input); i++ {
		baseIdx := i * ResampleRatio
		current := int32(input[i])

		// Determine next sample value for interpolation.
		var next int32
		if i < len(input)-1 {
			next = int32(input[i+1])
		} else {
			next = current
		}

		// Linear interpolation between current and next.
		for j := 0; j < ResampleRatio; j++ {
			// Interpolate: current + (next - current) * j / ResampleRatio
			output[baseIdx+j] = int16(current + (next-current)*int32(j)/int32(ResampleRatio))
		}
	}

	return output
}
