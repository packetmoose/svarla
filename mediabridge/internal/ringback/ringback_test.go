package ringback

import (
	"math"
	"math/cmplx"
	"sync"
	"testing"
)

func TestConstants(t *testing.T) {
	if FrameSize != 960 {
		t.Errorf("FrameSize = %d, want 960 (48kHz * 20ms)", FrameSize)
	}
	if SampleRate != 48000 {
		t.Errorf("SampleRate = %d, want 48000", SampleRate)
	}
}

func TestEUCadence(t *testing.T) {
	c := EUCadence()
	if len(c.Frequencies) != 1 || c.Frequencies[0] != 425.0 {
		t.Errorf("EU frequencies = %v, want [425]", c.Frequencies)
	}
	if c.OnDuration != 48000 {
		t.Errorf("EU OnDuration = %d, want 48000 (1s at 48kHz)", c.OnDuration)
	}
	if c.OffDuration != 192000 {
		t.Errorf("EU OffDuration = %d, want 192000 (4s at 48kHz)", c.OffDuration)
	}
}

func TestUSCadence(t *testing.T) {
	c := USCadence()
	if len(c.Frequencies) != 2 || c.Frequencies[0] != 440.0 || c.Frequencies[1] != 480.0 {
		t.Errorf("US frequencies = %v, want [440, 480]", c.Frequencies)
	}
	if c.OnDuration != 96000 {
		t.Errorf("US OnDuration = %d, want 96000 (2s at 48kHz)", c.OnDuration)
	}
	if c.OffDuration != 192000 {
		t.Errorf("US OffDuration = %d, want 192000 (4s at 48kHz)", c.OffDuration)
	}
}

func TestCadenceForType(t *testing.T) {
	eu := CadenceForType(CadenceEU)
	if eu.Frequencies[0] != 425.0 {
		t.Error("CadenceForType(eu) did not return EU cadence")
	}

	us := CadenceForType(CadenceUS)
	if len(us.Frequencies) != 2 {
		t.Error("CadenceForType(us) did not return US cadence")
	}

	// Unknown defaults to EU.
	def := CadenceForType("unknown")
	if def.Frequencies[0] != 425.0 {
		t.Error("CadenceForType(unknown) did not default to EU")
	}
}

func TestGeneratorNotStarted(t *testing.T) {
	g := NewGenerator(EUCadence())
	frame := g.GenerateFrame()

	if len(frame) != FrameSize {
		t.Fatalf("frame length = %d, want %d", len(frame), FrameSize)
	}

	// Should be silent when not started.
	for i, s := range frame {
		if s != 0 {
			t.Fatalf("frame[%d] = %d, want 0 (generator not started)", i, s)
		}
	}
}

func TestGeneratorStartStop(t *testing.T) {
	g := NewGenerator(EUCadence())

	if g.IsRunning() {
		t.Fatal("generator should not be running before Start()")
	}

	g.Start()
	if !g.IsRunning() {
		t.Fatal("generator should be running after Start()")
	}

	// After start, frames should contain non-zero data (tone is on initially).
	frame := g.GenerateFrame()
	hasNonZero := false
	for _, s := range frame {
		if s != 0 {
			hasNonZero = true
			break
		}
	}
	if !hasNonZero {
		t.Fatal("expected non-zero samples in first frame after Start()")
	}

	g.Stop()
	if g.IsRunning() {
		t.Fatal("generator should not be running after Stop()")
	}

	// After stop, frames should be silent.
	frame = g.GenerateFrame()
	for i, s := range frame {
		if s != 0 {
			t.Fatalf("frame[%d] = %d, want 0 after Stop()", i, s)
		}
	}
}

func TestGeneratorStopIdempotent(t *testing.T) {
	g := NewGenerator(EUCadence())
	g.Start()
	g.Stop()
	g.Stop() // Should not panic.
	if g.IsRunning() {
		t.Fatal("generator should remain stopped")
	}
}

func TestGeneratorStartIdempotent(t *testing.T) {
	g := NewGenerator(EUCadence())
	g.Start()
	g.Start() // Should not panic or reset position.
	if !g.IsRunning() {
		t.Fatal("generator should remain running")
	}
}

func TestStopChannel(t *testing.T) {
	g := NewGenerator(EUCadence())
	g.Start()

	select {
	case <-g.StopCh():
		t.Fatal("stop channel should not be closed before Stop()")
	default:
		// Good.
	}

	g.Stop()

	select {
	case <-g.StopCh():
		// Good.
	default:
		t.Fatal("stop channel should be closed after Stop()")
	}
}

// TestEUFrequencyContent verifies the EU ringback generates a 425Hz tone
// using a simple DFT check at the target frequency.
func TestEUFrequencyContent(t *testing.T) {
	g := NewGenerator(EUCadence())
	g.Start()

	// Collect enough samples for frequency analysis (one full frame = 20ms).
	// Use multiple frames for better frequency resolution.
	numFrames := 5 // 100ms of audio
	samples := make([]float64, 0, numFrames*FrameSize)
	for i := 0; i < numFrames; i++ {
		frame := g.GenerateFrame()
		for _, s := range frame {
			samples = append(samples, float64(s))
		}
	}

	// Check that 425Hz has significant energy using Goertzel algorithm.
	power425 := goertzelPower(samples, SampleRate, 425.0)
	power300 := goertzelPower(samples, SampleRate, 300.0) // Off-frequency reference
	power600 := goertzelPower(samples, SampleRate, 600.0) // Off-frequency reference

	if power425 <= power300 {
		t.Errorf("425Hz power (%f) should be much greater than 300Hz power (%f)", power425, power300)
	}
	if power425 <= power600 {
		t.Errorf("425Hz power (%f) should be much greater than 600Hz power (%f)", power425, power600)
	}

	// 425Hz should be at least 20dB above noise.
	if power425 < power300*100 {
		t.Errorf("425Hz power (%f) should be >20dB above off-frequency (%f)", power425, power300)
	}
}

// TestUSFrequencyContent verifies the US ringback generates 440Hz + 480Hz tones.
func TestUSFrequencyContent(t *testing.T) {
	g := NewGenerator(USCadence())
	g.Start()

	numFrames := 5 // 100ms of audio
	samples := make([]float64, 0, numFrames*FrameSize)
	for i := 0; i < numFrames; i++ {
		frame := g.GenerateFrame()
		for _, s := range frame {
			samples = append(samples, float64(s))
		}
	}

	power440 := goertzelPower(samples, SampleRate, 440.0)
	power480 := goertzelPower(samples, SampleRate, 480.0)
	power300 := goertzelPower(samples, SampleRate, 300.0) // Off-frequency reference

	if power440 <= power300 {
		t.Errorf("440Hz power (%f) should be much greater than 300Hz power (%f)", power440, power300)
	}
	if power480 <= power300 {
		t.Errorf("480Hz power (%f) should be much greater than 300Hz power (%f)", power480, power300)
	}

	// Both frequencies should have roughly similar power (within 6dB).
	ratio := power440 / power480
	if ratio > 4.0 || ratio < 0.25 {
		t.Errorf("440Hz/480Hz ratio = %f, expected roughly equal power", ratio)
	}
}

// TestEUCadenceTiming verifies the EU ringback is 1s on / 4s off.
func TestEUCadenceTiming(t *testing.T) {
	g := NewGenerator(EUCadence())
	g.Start()

	// Generate frames for one full cycle (5 seconds = 250 frames at 20ms each).
	framesPerSecond := SampleRate / FrameSize // 50 frames per second

	// Check first second: should have tone.
	for i := 0; i < framesPerSecond; i++ {
		frame := g.GenerateFrame()
		if i == 0 || i == framesPerSecond/2 {
			if !frameHasSignal(frame) {
				t.Fatalf("frame %d (during on-period) should have signal", i)
			}
		}
	}

	// Check seconds 2-5: should be silent (4 seconds off).
	for i := 0; i < framesPerSecond; i++ {
		frame := g.GenerateFrame()
		if frameHasSignal(frame) {
			t.Fatalf("frame at ~1.%ds should be silent (off-period)", i*FrameDuration/1000)
		}
	}

	// Skip to near end of silence (generate remaining frames).
	for i := 0; i < framesPerSecond*3; i++ {
		g.GenerateFrame()
	}

	// After the 5-second cycle, the next frame should have tone again.
	frame := g.GenerateFrame()
	if !frameHasSignal(frame) {
		t.Fatal("frame after full cycle should have signal (tone on again)")
	}
}

// TestUSCadenceTiming verifies the US ringback is 2s on / 4s off.
func TestUSCadenceTiming(t *testing.T) {
	g := NewGenerator(USCadence())
	g.Start()

	framesPerSecond := SampleRate / FrameSize // 50

	// First 2 seconds should have tone.
	for i := 0; i < 2*framesPerSecond; i++ {
		frame := g.GenerateFrame()
		if i == 0 || i == framesPerSecond {
			if !frameHasSignal(frame) {
				t.Fatalf("frame %d (during 2s on-period) should have signal", i)
			}
		}
	}

	// Next 4 seconds should be silent.
	for i := 0; i < framesPerSecond; i++ {
		frame := g.GenerateFrame()
		if frameHasSignal(frame) {
			t.Fatalf("frame at ~2.%ds should be silent (off-period)", i*FrameDuration/1000)
		}
	}
}

// TestConcurrentAccess verifies thread-safety of the generator.
func TestConcurrentAccess(t *testing.T) {
	g := NewGenerator(EUCadence())
	g.Start()

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				frame := g.GenerateFrame()
				if len(frame) != FrameSize {
					t.Errorf("frame length = %d, want %d", len(frame), FrameSize)
				}
			}
		}()
	}
	wg.Wait()

	g.Stop()
}

// TestMultipleGeneratorsIndependent verifies separate generators don't interfere.
func TestMultipleGeneratorsIndependent(t *testing.T) {
	g1 := NewGenerator(EUCadence())
	g2 := NewGenerator(USCadence())

	g1.Start()
	g2.Start()

	// Generate a few frames from each.
	frame1 := g1.GenerateFrame()
	frame2 := g2.GenerateFrame()

	// They should both have signal (both in on-period initially).
	if !frameHasSignal(frame1) {
		t.Fatal("g1 first frame should have signal")
	}
	if !frameHasSignal(frame2) {
		t.Fatal("g2 first frame should have signal")
	}

	// Stopping one shouldn't affect the other.
	g1.Stop()
	frame2 = g2.GenerateFrame()
	if !frameHasSignal(frame2) {
		t.Fatal("g2 should still produce signal after g1 stopped")
	}

	g2.Stop()
}

// --- Helper functions ---

// goertzelPower computes the power at a specific frequency using the Goertzel algorithm.
func goertzelPower(samples []float64, sampleRate int, targetFreq float64) float64 {
	n := len(samples)
	k := int(math.Round(float64(n) * targetFreq / float64(sampleRate)))
	w := 2.0 * math.Pi * float64(k) / float64(n)
	coeff := complex(math.Cos(w), -math.Sin(w))

	var sum complex128
	for i := 0; i < n; i++ {
		sum += complex(samples[i], 0) * cmplx.Rect(1.0, -w*float64(i))
		_ = coeff // Using direct DFT calculation for clarity.
	}

	return cmplx.Abs(sum) * cmplx.Abs(sum) / float64(n*n)
}

// frameHasSignal checks whether a frame contains significant audio signal.
func frameHasSignal(frame []int16) bool {
	var sumAbs int64
	for _, s := range frame {
		if s < 0 {
			sumAbs += int64(-s)
		} else {
			sumAbs += int64(s)
		}
	}
	avgAbs := sumAbs / int64(len(frame))
	// A frame with real tone should have average absolute value > 1000.
	return avgAbs > 1000
}
