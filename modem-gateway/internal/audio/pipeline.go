package audio

import (
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
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

	// teardownMaxAttempts is how many times Stop() tries AT+CPCMREG=0 before
	// giving up and recording a teardown failure.
	teardownMaxAttempts = 3
	// teardownRetryDelay is the pause between AT+CPCMREG=0 attempts and before
	// the verifying AT+CPCMREG? read, giving the modem time to settle.
	teardownRetryDelay = 500 * time.Millisecond
	// defaultSoftResetThreshold is the number of consecutive failed/unverified
	// teardowns after which recovery escalates to a soft reset (if enabled).
	defaultSoftResetThreshold = 3
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

// RecoveryOptions configures how the pipeline recovers the modem's PCM audio
// subsystem when teardown (AT+CPCMREG=0) repeatedly fails.
//
// Background: on the SIM7600, if PCM streaming is not cleanly disabled after a
// call, the modem's audio state can accumulate over many calls until the
// network uplink silently stops working (the far end hears nothing while local
// capture still works). Historically only a physical power-cycle cleared it.
// These options let the gateway detect the failure and optionally self-heal.
type RecoveryOptions struct {
	// SoftResetEnabled turns on the last-resort soft reset (AT+CFUN=1,1) when
	// consecutive teardown failures reach SoftResetThreshold. Default false:
	// the failure is detected and logged, but no automatic reset is performed.
	//
	// A soft reset briefly deregisters the modem from the network (~30-60s), so
	// it is opt-in and only ever issued while the modem is idle (no active call).
	SoftResetEnabled bool

	// SoftResetThreshold is the number of consecutive failed/unverified PCM
	// teardowns that triggers a soft reset. Zero uses defaultSoftResetThreshold.
	SoftResetThreshold int
}

// softResetThreshold returns the effective threshold, applying the default
// when unset.
func (r RecoveryOptions) softResetThreshold() int {
	if r.SoftResetThreshold <= 0 {
		return defaultSoftResetThreshold
	}
	return r.SoftResetThreshold
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

	// recovery configures escalating recovery when PCM teardown keeps failing.
	recovery RecoveryOptions
	// teardownFailures counts consecutive Stop() calls that could not confirm
	// PCM streaming was disabled. Reset to 0 after a verified-clean teardown or
	// a successful soft reset. Used to decide when to escalate recovery.
	teardownFailures atomic.Int64

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

// SetRecoveryOptions configures escalating recovery of the modem's PCM audio
// subsystem when teardown repeatedly fails. Call once after construction,
// before Start(). If never called, recovery detection/logging is still active
// but the soft-reset escalation is disabled (SoftResetEnabled defaults false).
func (p *Pipeline) SetRecoveryOptions(opts RecoveryOptions) {
	if opts.SoftResetThreshold <= 0 {
		opts.SoftResetThreshold = defaultSoftResetThreshold
	}
	p.mu.Lock()
	p.recovery = opts
	p.mu.Unlock()
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

	// Clean slate: explicitly disable any lingering PCM streaming from a
	// previous call before (re)enabling it. If an earlier call's teardown did
	// not fully disable PCM streaming, starting a new call on top of that stale
	// state is a path to the wedged-audio failure. Best-effort — an idle modem
	// may return ERROR here, which is harmless. A brief settle lets the modem
	// audio subsystem quiesce before we re-enable.
	if _, err := p.modemCtrl.SendCommand("AT+CPCMREG=0", 5*time.Second); err != nil {
		log.Printf("[PCM start] clean-slate AT+CPCMREG=0 returned: %v (ignored)", err)
	}
	time.Sleep(teardownRetryDelay)

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

	// Robustly disable PCM streaming on the modem and verify it took effect.
	// A failed/unverified teardown here is the leading indicator of the modem's
	// audio subsystem drifting toward the wedged state that breaks the network
	// uplink (far end can't hear us) after many calls.
	p.teardownPCM()

	return nil
}

// teardownPCM disables PCM streaming (AT+CPCMREG=0), retrying on failure, then
// verifies via AT+CPCMREG? that streaming is actually off. It maintains a
// consecutive-failure counter and, when that counter crosses the configured
// threshold, escalates recovery (soft reset if enabled). All outcomes are
// logged so failures accumulating over days are visible in the logs.
func (p *Pipeline) teardownPCM() {
	var lastErr error
	disabled := false
	for attempt := 1; attempt <= teardownMaxAttempts; attempt++ {
		_, err := p.modemCtrl.SendCommand("AT+CPCMREG=0", 5*time.Second)
		if err == nil {
			disabled = true
			break
		}
		lastErr = err
		log.Printf("[PCM teardown] AT+CPCMREG=0 attempt %d/%d failed: %v",
			attempt, teardownMaxAttempts, err)
		if attempt < teardownMaxAttempts {
			time.Sleep(teardownRetryDelay)
		}
	}

	// Verify the modem actually reports PCM streaming disabled. Even if the
	// command returned OK, confirm the state — this catches the modem accepting
	// the command but not applying it.
	time.Sleep(teardownRetryDelay)
	verified, verr := p.pcmStreamingDisabled()

	switch {
	case verified:
		// Clean teardown confirmed. Reset the failure streak.
		if prev := p.teardownFailures.Swap(0); prev > 0 {
			log.Printf("[PCM teardown] PCM streaming confirmed disabled — recovery streak reset (was %d)", prev)
		}
		return
	case verr != nil:
		log.Printf("[PCM teardown] WARNING: could not verify PCM state (AT+CPCMREG? failed: %v); "+
			"last disable error: %v", verr, lastErr)
	default:
		log.Printf("[PCM teardown] WARNING: PCM streaming still enabled after %d disable attempt(s); "+
			"last disable error: %v", teardownMaxAttempts, lastErr)
	}
	_ = disabled

	// Teardown could not be confirmed clean. Record the failure and consider
	// escalating recovery.
	failures := p.teardownFailures.Add(1)
	log.Printf("[PCM teardown] WARNING: consecutive unverified PCM teardowns: %d "+
		"(soft reset threshold: %d, enabled: %t)",
		failures, p.recovery.softResetThreshold(), p.recovery.SoftResetEnabled)

	p.maybeRecover(failures)
}

// pcmStreamingDisabled queries AT+CPCMREG? and reports whether PCM streaming is
// off (state 0). Returns (false, err) if the query itself failed.
func (p *Pipeline) pcmStreamingDisabled() (bool, error) {
	resp, err := p.modemCtrl.SendCommand("AT+CPCMREG?", 5*time.Second)
	if err != nil {
		return false, err
	}
	// Response contains a line like "+CPCMREG: 0" (0 = disabled, 1 = enabled).
	// Treat an explicit ": 0" as disabled; anything else (including a "1") as
	// still enabled.
	return strings.Contains(resp, "+CPCMREG: 0") || strings.Contains(resp, "+CPCMREG:0"), nil
}

// maybeRecover escalates recovery of the modem's audio subsystem when
// consecutive teardown failures reach the configured threshold.
//
// The soft reset (AT+CFUN=1,1) is a last resort: it clears accumulated modem
// state that a plain AT+CPCMREG=0 can no longer fix, without a physical
// power-cycle. It is only issued when SoftResetEnabled is true. It is safe to
// call here because Stop() runs at end-of-call, so the modem is idle (the call
// has already been hung up by the caller before/around Stop()).
func (p *Pipeline) maybeRecover(failures int64) {
	threshold := int64(p.recovery.softResetThreshold())
	if failures < threshold {
		return
	}

	if !p.recovery.SoftResetEnabled {
		log.Printf("[PCM recovery] threshold reached (%d consecutive teardown failures) but "+
			"soft reset is disabled; modem audio may require a power-cycle. "+
			"Enable modem.audioRecovery.softResetEnabled to allow automatic recovery.", failures)
		return
	}

	log.Printf("[PCM recovery] %d consecutive teardown failures reached threshold %d — "+
		"issuing soft reset (AT+CFUN=1,1) to clear modem audio state", failures, threshold)

	// AT+CFUN=1,1 resets the modem; it will not return a normal OK before the
	// reset takes the port down, so a short timeout and ignored error are
	// expected here. The reconnect manager re-initializes the modem afterward.
	_, err := p.modemCtrl.SendCommand("AT+CFUN=1,1", 5*time.Second)
	if err != nil {
		log.Printf("[PCM recovery] soft reset command returned: %v (this is expected as the modem resets)", err)
	}
	// Reset the streak: the modem is being reinitialized, so past failures no
	// longer reflect current state. If the wedge persists, failures will climb
	// again and re-trigger.
	p.teardownFailures.Store(0)
	log.Printf("[PCM recovery] soft reset issued; modem will re-register and re-initialize")
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
