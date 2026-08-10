// Package ringback provides telephone ringback tone generation for the MediaBridge.
// It generates PCM 16-bit audio at 48kHz (Opus native rate) in 20ms frames (960 samples).
// Two cadence patterns are supported:
//   - EU: 425Hz tone, 1 second on / 4 seconds off
//   - US: 440Hz + 480Hz combined tone, 2 seconds on / 4 seconds off
package ringback

import (
	"math"
	"sync"
)

const (
	// SampleRate is the output sample rate in Hz (Opus native rate).
	SampleRate = 48000

	// FrameDuration is the frame duration in milliseconds.
	FrameDuration = 20

	// FrameSize is the number of samples per frame (48000 * 20 / 1000 = 960).
	FrameSize = SampleRate * FrameDuration / 1000

	// Amplitude for tone generation (slightly below int16 max to avoid clipping).
	amplitude = 28000
)

// CadenceType identifies the ringback cadence pattern.
type CadenceType string

const (
	// CadenceEU is the European ringback: 425Hz, 1s on / 4s off.
	CadenceEU CadenceType = "eu"

	// CadenceUS is the US ringback: 440Hz + 480Hz, 2s on / 4s off.
	CadenceUS CadenceType = "us"
)

// Cadence defines the timing of a ringback tone pattern.
type Cadence struct {
	// Frequencies to generate (summed together).
	Frequencies []float64

	// OnDuration is how long the tone plays, in samples.
	OnDuration int

	// OffDuration is how long silence lasts, in samples.
	OffDuration int
}

// EUCadence returns the standard EU ringback cadence (425Hz, 1s on / 4s off).
func EUCadence() Cadence {
	return Cadence{
		Frequencies: []float64{425.0},
		OnDuration:  1 * SampleRate, // 1 second
		OffDuration: 4 * SampleRate, // 4 seconds
	}
}

// USCadence returns the standard US ringback cadence (440+480Hz, 2s on / 4s off).
func USCadence() Cadence {
	return Cadence{
		Frequencies: []float64{440.0, 480.0},
		OnDuration:  2 * SampleRate, // 2 seconds
		OffDuration: 4 * SampleRate, // 4 seconds
	}
}

// CadenceForType returns the Cadence for a given CadenceType string.
// Defaults to EU if the type is unrecognized.
func CadenceForType(ct CadenceType) Cadence {
	switch ct {
	case CadenceUS:
		return USCadence()
	default:
		return EUCadence()
	}
}

// Generator produces ringback tone audio frames.
// It is safe for concurrent use; each session should have its own Generator.
type Generator struct {
	mu       sync.Mutex
	cadence  Cadence
	position int  // current sample position within the on+off cycle
	running  bool // whether the generator is active
	stopCh   chan struct{}
}

// NewGenerator creates a new ringback tone generator with the given cadence.
func NewGenerator(cadence Cadence) *Generator {
	return &Generator{
		cadence: cadence,
		stopCh:  make(chan struct{}),
	}
}

// Start activates the generator. After Start, calls to GenerateFrame produce tone data.
func (g *Generator) Start() {
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.running {
		return
	}
	g.running = true
	g.position = 0
}

// Stop deactivates the generator. After Stop, GenerateFrame returns silence.
// Stop is idempotent and safe to call multiple times.
func (g *Generator) Stop() {
	g.mu.Lock()
	defer g.mu.Unlock()

	if !g.running {
		return
	}
	g.running = false

	// Signal stop channel (non-blocking, may already be closed).
	select {
	case <-g.stopCh:
		// Already closed.
	default:
		close(g.stopCh)
	}
}

// IsRunning reports whether the generator is currently active.
func (g *Generator) IsRunning() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.running
}

// StopCh returns a channel that is closed when Stop is called.
// This can be used by goroutines to detect when to stop sending frames.
func (g *Generator) StopCh() <-chan struct{} {
	return g.stopCh
}

// GenerateFrame produces one 20ms frame (960 samples) of PCM 16-bit audio.
// If the generator is not running, it returns a silent frame (all zeros).
// The returned slice has exactly FrameSize elements.
func (g *Generator) GenerateFrame() []int16 {
	g.mu.Lock()
	defer g.mu.Unlock()

	frame := make([]int16, FrameSize)

	if !g.running {
		return frame
	}

	cycleLen := g.cadence.OnDuration + g.cadence.OffDuration

	for i := 0; i < FrameSize; i++ {
		posInCycle := g.position % cycleLen

		if posInCycle < g.cadence.OnDuration {
			// Generate tone: sum of all frequencies.
			var sample float64
			for _, freq := range g.cadence.Frequencies {
				phase := 2.0 * math.Pi * freq * float64(g.position) / float64(SampleRate)
				sample += math.Sin(phase)
			}
			// Normalize by number of frequencies to keep amplitude consistent.
			sample = sample / float64(len(g.cadence.Frequencies))
			frame[i] = int16(sample * amplitude)
		}
		// else: silence (frame is already zero-initialized)

		g.position++
	}

	return frame
}
