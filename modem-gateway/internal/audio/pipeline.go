package audio

import (
	"errors"
	"fmt"
	"io"
	"log"
	"sync"
	"sync/atomic"
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
	portOpener func() (modem.SerialPort, error)
	modemCtrl  *modem.Modem
	sampleRate int

	capture  chan []byte
	playback chan []byte

	mu      sync.Mutex
	running bool
	stopCh  chan struct{}
	wg      sync.WaitGroup

	// Debug counters for diagnosing audio flow.
	captureBytes  atomic.Int64
	captureFrames atomic.Int64
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

// NewReopenable creates a Pipeline that reopens its PCM port on each Start().
//
// Stop() closes the PCM port to unblock the blocking Read() in the capture
// goroutine, so the port must be reopened before the next call. The provided
// opener is invoked at the start of each Start() to obtain a fresh port.
// This is required for supporting multiple sequential calls.
func NewReopenable(opener func() (modem.SerialPort, error), m *modem.Modem, sampleRate int) *Pipeline {
	return &Pipeline{
		portOpener: opener,
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

	// (Re)open the PCM port. Stop() closes it to unblock the capture goroutine's
	// blocking Read(), so for a second/subsequent call the port must be reopened.
	if p.pcmPort == nil {
		if p.portOpener == nil {
			return fmt.Errorf("audio pipeline: PCM port is closed and no opener configured")
		}
		port, err := p.portOpener()
		if err != nil {
			return fmt.Errorf("audio pipeline: reopen PCM port: %w", err)
		}
		p.pcmPort = port
	}

	// Set PCM format right before enabling streaming, in case a previous
	// AT+CPCMREG=0 or modem reset changed it.
	if p.sampleRate == 16000 {
		_, _ = p.modemCtrl.SendCommand("AT+CPCMFRM=1", 5*time.Second)
	} else {
		_, _ = p.modemCtrl.SendCommand("AT+CPCMFRM=0", 5*time.Second)
	}

	// Enable PCM audio streaming on the modem's serial port.
	// Retry once after a brief delay — the modem audio subsystem may
	// not be ready immediately after the call is established.
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		_, err = p.modemCtrl.SendCommand("AT+CPCMREG=1", 10*time.Second)
		if err == nil {
			break
		}
		if attempt == 0 {
			time.Sleep(1 * time.Second)
		}
	}
	if err != nil {
		return fmt.Errorf("AT+CPCMREG=1: %w", err)
	}

	p.stopCh = make(chan struct{})
	p.running = true

	// Capture the port reference for the goroutines. Stop() closes the port to
	// unblock the blocking Read()/Write(), then nils the field after the
	// goroutines have exited — passing the reference here avoids a data race on
	// p.pcmPort between the loops and Stop().
	port := p.pcmPort

	p.wg.Add(2)
	go p.captureLoop(port)
	go p.playbackLoop(port)

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

	// Close the PCM port to unblock any Read()/Write() calls in the
	// capture/playback goroutines. Without this, Stop() hangs forever
	// because Read() blocks with no timeout on the streaming port.
	// The port is set to nil so Start() reopens it for the next call.
	if p.pcmPort != nil {
		_ = p.pcmPort.Close()
		p.pcmPort = nil
	}

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
func (p *Pipeline) captureLoop(port modem.SerialPort) {
	defer p.wg.Done()

	frameSize := p.frameSize()
	buf := make([]byte, frameSize)
	offset := 0

	log.Printf("[PCM capture] starting, frame size=%d bytes", frameSize)

	for {
		select {
		case <-p.stopCh:
			return
		default:
		}

		n, err := port.Read(buf[offset:])
		if err != nil {
			// Check if we were asked to stop.
			select {
			case <-p.stopCh:
				return
			default:
			}
			// On read errors (e.g., port closed, EOF), exit the loop.
			if errors.Is(err, io.EOF) {
				log.Printf("[PCM capture] EOF, exiting")
				return
			}
			// Brief pause before retrying on transient errors.
			time.Sleep(1 * time.Millisecond)
			continue
		}

		// A read timeout returns n=0 with no error. Loop back to re-check the
		// stop signal (keeps teardown responsive) without emitting a frame.
		if n == 0 {
			continue
		}

		p.captureBytes.Add(int64(n))
		offset += n

		// Log first data received and periodically.
		totalBytes := p.captureBytes.Load()
		if totalBytes == int64(n) {
			log.Printf("[PCM capture] first data received: %d bytes", n)
			// Dump first 32 bytes for format diagnosis.
			dumpLen := 32
			if n < dumpLen {
				dumpLen = n
			}
			log.Printf("[PCM capture] first bytes (hex): %x", buf[:dumpLen])
		}

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

			frames := p.captureFrames.Add(1)
			if frames == 1 || frames%500 == 0 {
				log.Printf("[PCM capture] frame %d emitted (total bytes: %d)", frames, p.captureBytes.Load())
			}

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
func (p *Pipeline) playbackLoop(port modem.SerialPort) {
	defer p.wg.Done()

	var playedFrames int64

	for {
		select {
		case frame, ok := <-p.playback:
			if !ok {
				return
			}
			// Downlink diagnostics: log the first frame written to the modem
			// and periodically, to confirm app->modem audio reaches the modem.
			playedFrames++
			if playedFrames == 1 {
				dumpLen := 32
				if len(frame) < dumpLen {
					dumpLen = len(frame)
				}
				log.Printf("[PCM playback] first frame to modem: %d bytes, first bytes (hex): %x", len(frame), frame[:dumpLen])
			} else if playedFrames%500 == 0 {
				log.Printf("[PCM playback] frame %d written to modem (%d bytes)", playedFrames, len(frame))
			}
			// Write the complete frame to the serial port.
			// Use a loop to handle partial writes.
			written := 0
			for written < len(frame) {
				n, err := port.Write(frame[written:])
				if err != nil {
					select {
					case <-p.stopCh:
						return
					default:
					}
					// On write errors, skip this frame.
					log.Printf("[PCM playback] write error after %d bytes: %v", written, err)
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
