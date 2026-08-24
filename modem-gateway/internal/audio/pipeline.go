package audio

import (
	"errors"
	"io"
	"sync"
	"time"

	"github.com/packetmoose/svarla/modem-gateway/internal/modem"
)

// Frame sizes for 20ms of PCM audio at different sample rates.
const (
	// FrameSize16kHz is 320 samples × 2 bytes/sample = 640 bytes (20ms at 16kHz).
	FrameSize16kHz = 640
	// FrameSize8kHz is 160 samples × 2 bytes/sample = 320 bytes (20ms at 8kHz).
	FrameSize8kHz = 320

	// captureBufferSize is how many frames the capture channel can buffer
	// before blocking. Provides jitter absorption.
	captureBufferSize = 5
	// playbackBufferSize is how many frames the playback channel can buffer.
	playbackBufferSize = 5
)

// Errors returned by the audio pipeline.
var (
	ErrAlreadyRunning = errors.New("audio: pipeline already running")
	ErrNotRunning     = errors.New("audio: pipeline not running")
)

// AudioPipeline defines the interface for PCM audio capture and playback
// through the modem's dedicated PCM serial port.
type AudioPipeline interface {
	// Start opens the PCM serial port and enables PCM streaming via AT+CPCMREG=1.
	Start() error
	// Stop disables PCM streaming via AT+CPCMREG=0 and closes the port.
	Stop() error
	// NativeSampleRate returns the negotiated native sample rate (8000 or 16000).
	NativeSampleRate() int
	// CaptureFrames returns a read-only channel delivering PCM frames from the modem.
	// Frame size is 640 bytes at 16kHz or 320 bytes at 8kHz.
	CaptureFrames() <-chan []byte
	// PlaybackFrames returns a write channel for sending PCM frames to the modem.
	PlaybackFrames() chan<- []byte
}

// Options configures the audio pipeline.
type Options struct {
	// PCMPortPath is the device path for the modem's PCM audio serial port
	// (e.g., "/dev/ttyUSB1"). If empty, the PCM port must be provided directly.
	PCMPortPath string
}

// Compile-time interface check.
var _ AudioPipeline = (*Pipeline)(nil)

// Pipeline implements AudioPipeline, managing PCM audio capture and playback
// through the modem's dedicated PCM serial port.
type Pipeline struct {
	pcmPort    modem.SerialPort
	modemCtrl  *modem.Modem
	sampleRate int

	capture  chan []byte
	playback chan []byte

	mu      sync.Mutex
	running bool
	stopCh  chan struct{}
	wg      sync.WaitGroup
}

// New creates a new audio Pipeline.
//
// pcmPort is the serial port for PCM audio data (the modem's dedicated audio ttyUSB).
// m is the modem AT command interface, used to issue AT+CPCMREG and AT+CPCMFRM.
// sampleRate should be obtained from NegotiateSampleRate before creating the pipeline.
func New(pcmPort modem.SerialPort, m *modem.Modem, sampleRate int) *Pipeline {
	return &Pipeline{
		pcmPort:    pcmPort,
		modemCtrl:  m,
		sampleRate: sampleRate,
		capture:    make(chan []byte, captureBufferSize),
		playback:   make(chan []byte, playbackBufferSize),
	}
}

// NegotiateSampleRate attempts to set 16kHz sample rate on the modem via
// AT+CPCMFRM=1. If the command succeeds, returns 16000. If the modem
// returns an error (command unsupported), falls back to 8000.
func NegotiateSampleRate(m *modem.Modem) (int, error) {
	_, err := m.SendCommand("AT+CPCMFRM=1", 5*time.Second)
	if err == nil {
		return 16000, nil
	}
	// If the command failed (ERROR, +CME ERROR, etc.), the modem doesn't
	// support 16kHz. Fall back to 8kHz native rate.
	return 8000, nil
}

// NativeSampleRate returns the negotiated sample rate (8000 or 16000 Hz).
func (p *Pipeline) NativeSampleRate() int {
	return p.sampleRate
}

// CaptureFrames returns the read-only channel of captured PCM frames from the modem.
func (p *Pipeline) CaptureFrames() <-chan []byte {
	return p.capture
}

// PlaybackFrames returns the write channel for PCM frames to be played to the modem.
func (p *Pipeline) PlaybackFrames() chan<- []byte {
	return p.playback
}

// Start enables PCM streaming on the modem (AT+CPCMREG=1) and launches
// the capture and playback goroutines.
func (p *Pipeline) Start() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.running {
		return ErrAlreadyRunning
	}

	// Enable PCM audio streaming on the modem's serial port.
	_, err := p.modemCtrl.SendCommand("AT+CPCMREG=1", 5*time.Second)
	if err != nil {
		return err
	}

	p.stopCh = make(chan struct{})
	p.running = true

	p.wg.Add(2)
	go p.captureLoop()
	go p.playbackLoop()

	return nil
}

// Stop disables PCM streaming on the modem (AT+CPCMREG=0), stops the
// capture and playback goroutines, and drains the channels.
func (p *Pipeline) Stop() error {
	p.mu.Lock()
	if !p.running {
		p.mu.Unlock()
		return ErrNotRunning
	}
	p.running = false
	close(p.stopCh)
	p.mu.Unlock()

	// Wait for goroutines to exit.
	p.wg.Wait()

	// Drain remaining frames from channels.
	drainChannel(p.capture)
	drainChannel(p.playback)

	// Disable PCM streaming on the modem. Best-effort; ignore errors
	// since the modem may already be disconnected.
	_, _ = p.modemCtrl.SendCommand("AT+CPCMREG=0", 5*time.Second)

	return nil
}

// captureLoop continuously reads PCM frames from the serial port and sends
// them to the capture channel. It assembles raw bytes into complete frames
// based on the negotiated sample rate.
func (p *Pipeline) captureLoop() {
	defer p.wg.Done()

	frameSize := p.frameSize()
	buf := make([]byte, frameSize)
	offset := 0

	for {
		select {
		case <-p.stopCh:
			return
		default:
		}

		n, err := p.pcmPort.Read(buf[offset:])
		if err != nil {
			// Check if we were asked to stop.
			select {
			case <-p.stopCh:
				return
			default:
			}
			// On read errors (e.g., port closed, EOF), exit the loop.
			if errors.Is(err, io.EOF) {
				return
			}
			// Brief pause before retrying on transient errors.
			time.Sleep(1 * time.Millisecond)
			continue
		}

		offset += n

		// Emit complete frames.
		for offset >= frameSize {
			frame := make([]byte, frameSize)
			copy(frame, buf[:frameSize])

			// Shift remaining bytes to the front.
			remaining := offset - frameSize
			if remaining > 0 {
				copy(buf, buf[frameSize:offset])
			}
			offset = remaining

			// Send frame, dropping it if channel is full (back-pressure).
			select {
			case p.capture <- frame:
			case <-p.stopCh:
				return
			}
		}
	}
}

// playbackLoop reads PCM frames from the playback channel and writes them
// to the serial port.
func (p *Pipeline) playbackLoop() {
	defer p.wg.Done()

	for {
		select {
		case frame, ok := <-p.playback:
			if !ok {
				return
			}
			// Write the complete frame to the serial port.
			// Use a loop to handle partial writes.
			written := 0
			for written < len(frame) {
				n, err := p.pcmPort.Write(frame[written:])
				if err != nil {
					select {
					case <-p.stopCh:
						return
					default:
					}
					// On write errors, skip this frame.
					break
				}
				written += n
			}
		case <-p.stopCh:
			return
		}
	}
}

// frameSize returns the PCM frame size in bytes for the negotiated sample rate.
func (p *Pipeline) frameSize() int {
	if p.sampleRate == 16000 {
		return FrameSize16kHz
	}
	return FrameSize8kHz
}

// drainChannel reads and discards all buffered frames from a channel.
func drainChannel(ch chan []byte) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}
