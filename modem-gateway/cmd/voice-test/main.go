// Command voice-test is a developer tool for testing voice call capabilities
// with a SIM7600 modem. It bridges the modem's PCM audio to the local
// laptop speaker and microphone via PortAudio.
//
// Usage:
//
//	voice-test [flags] [phone-number]
//
// With a phone number argument, it dials the number and connects audio.
// Without arguments, it waits for an incoming call, answers after a few
// seconds of ringing, and connects audio.
//
// Ctrl+C to hang up and exit.
package main

import (
	"context"
	"encoding/binary"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/gordonklaus/portaudio"
	"github.com/packetmoose/svarla/modem-gateway/internal/audio"
	"github.com/packetmoose/svarla/modem-gateway/internal/modem"
)

func main() {
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, `Usage: voice-test [flags] [phone-number]

Place an outbound call or wait for an incoming call, bridging modem PCM
audio to the local speaker and microphone via PortAudio.

  voice-test +15551234567      Dial the number and connect audio
  voice-test                   Wait for incoming call, answer, connect audio

Flags:
`)
		flag.PrintDefaults()
	}

	atPort := flag.String("port", "/dev/ttyUSB2", "Modem AT command serial port")
	pcmPort := flag.String("pcm-port", "/dev/ttyUSB1", "Modem PCM audio serial port")
	ringDelay := flag.Duration("ring-delay", 3*time.Second, "Delay before answering incoming call")
	flag.Parse()

	phoneNumber := flag.Arg(0)

	if phoneNumber != "" {
		log.Printf("Mode: outbound call to %s", phoneNumber)
	} else {
		log.Printf("Mode: waiting for incoming call (will answer after %s)", *ringDelay)
	}

	// Set up signal handling.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigCh
		log.Println("Signal received, hanging up...")
		cancel()
	}()

	if err := run(ctx, *atPort, *pcmPort, phoneNumber, *ringDelay); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, atPortPath, pcmPortPath, phoneNumber string, ringDelay time.Duration) error {
	// --- Open AT command port and initialize modem ---
	log.Printf("Opening AT port %s...", atPortPath)
	sp, err := modem.OpenSerialPort(atPortPath)
	if err != nil {
		return fmt.Errorf("open AT port: %w", err)
	}

	mdm := modem.New(sp)
	mdm.Open()
	defer func() {
		log.Println("Closing modem...")
		// Best-effort hangup.
		_, _ = mdm.SendCommand("ATH", 5*time.Second)
		_ = mdm.Close()
	}()

	// Run init sequence.
	log.Println("Initializing modem...")
	initResult, err := modem.RunInitSequence(ctx, mdm)
	if err != nil {
		return fmt.Errorf("modem init: %w", err)
	}
	log.Printf("Modem ready: %s %s (firmware: %s)", initResult.Info.Manufacturer, initResult.Info.Model, initResult.Info.Firmware)

	// --- Negotiate sample rate ---
	sampleRate, err := audio.NegotiateSampleRate(mdm)
	if err != nil {
		return fmt.Errorf("negotiate sample rate: %w", err)
	}
	log.Printf("Modem PCM sample rate: %d Hz", sampleRate)

	// --- Either dial or wait for incoming call ---
	if phoneNumber != "" {
		if err := dialCall(ctx, mdm, phoneNumber); err != nil {
			return err
		}
	} else {
		if err := waitAndAnswer(ctx, mdm, ringDelay); err != nil {
			return err
		}
	}

	// --- Open PCM port and start audio pipeline ---
	log.Printf("Opening PCM port %s...", pcmPortPath)
	pcmSP, err := modem.OpenSerialPort(pcmPortPath)
	if err != nil {
		return fmt.Errorf("open PCM port: %w", err)
	}
	defer pcmSP.Close()

	pipeline := audio.New(pcmSP, mdm, sampleRate)
	if err := pipeline.Start(); err != nil {
		return fmt.Errorf("start audio pipeline: %w", err)
	}
	defer func() {
		log.Println("Stopping audio pipeline...")
		_ = pipeline.Stop()
	}()

	log.Println("Audio pipeline started, bridging to local sound device...")

	// --- Bridge PCM audio to PortAudio ---
	if err := bridgeAudio(ctx, mdm, pipeline, sampleRate); err != nil {
		return fmt.Errorf("audio bridge: %w", err)
	}

	log.Println("Call ended.")
	return nil
}

// dialCall initiates an outbound voice call.
func dialCall(ctx context.Context, mdm *modem.Modem, number string) error {
	log.Printf("Dialing %s...", number)
	cmd := fmt.Sprintf("ATD%s;", number)
	_, err := mdm.SendCommand(cmd, 30*time.Second)
	if err != nil {
		return fmt.Errorf("dial failed: %w", err)
	}
	log.Println("Call connected.")
	return nil
}

// waitAndAnswer listens for an incoming RING, waits ringDelay, then answers.
func waitAndAnswer(ctx context.Context, mdm *modem.Modem, ringDelay time.Duration) error {
	ringCh := make(chan string, 1)

	mdm.OnURC(func(urc modem.URC) {
		switch urc.Prefix {
		case "RING", "+CRING":
			select {
			case ringCh <- "":
			default:
			}
		case "+CLIP":
			// Try to extract caller number.
			num := extractCLIPNumber(urc.Data)
			select {
			case ringCh <- num:
			default:
			}
		}
	})

	log.Println("Waiting for incoming call...")

	// Wait for the first RING.
	var caller string
	select {
	case caller = <-ringCh:
	case <-ctx.Done():
		return fmt.Errorf("cancelled while waiting for call")
	}

	if caller != "" {
		log.Printf("Incoming call from: %s", caller)
	} else {
		log.Println("Incoming call detected (caller unknown)")
	}

	// Wait the configured delay (let it ring a bit).
	log.Printf("Ringing... answering in %s", ringDelay)
	select {
	case <-time.After(ringDelay):
	case <-ctx.Done():
		return fmt.Errorf("cancelled during ring delay")
	}

	// Answer the call.
	log.Println("Answering...")
	_, err := mdm.SendCommand("ATA", 10*time.Second)
	if err != nil {
		return fmt.Errorf("answer failed: %w", err)
	}
	log.Println("Call answered.")
	return nil
}

// extractCLIPNumber parses the number from +CLIP data like: "+15551234567",145,...
func extractCLIPNumber(data string) string {
	if len(data) < 3 {
		return ""
	}
	// Find first quoted string.
	start := -1
	for i, c := range data {
		if c == '"' {
			if start == -1 {
				start = i + 1
			} else {
				return data[start:i]
			}
		}
	}
	return ""
}

// bridgeAudio connects the modem's PCM pipeline to the local sound card
// via PortAudio. It runs until the context is cancelled or the remote
// party hangs up (NO CARRIER).
func bridgeAudio(ctx context.Context, mdm *modem.Modem, pipeline *audio.Pipeline, sampleRate int) error {
	// Detect call termination via NO CARRIER.
	callEnded := make(chan struct{})
	var callEndOnce sync.Once
	mdm.OnURC(func(urc modem.URC) {
		if urc.Prefix == "NO CARRIER" || urc.Prefix == "BUSY" {
			callEndOnce.Do(func() { close(callEnded) })
		}
	})

	// Initialize PortAudio.
	if err := portaudio.Initialize(); err != nil {
		return fmt.Errorf("portaudio init: %w", err)
	}
	defer portaudio.Terminate()

	// PortAudio operates at the modem's native sample rate.
	// Frame size: 20ms of audio.
	samplesPerFrame := sampleRate / 50 // 50 frames/sec = 20ms each
	frameBytes := samplesPerFrame * 2  // 16-bit samples

	// Open a full-duplex PortAudio stream.
	inputBuf := make([]int16, samplesPerFrame)
	outputBuf := make([]int16, samplesPerFrame)

	stream, err := portaudio.OpenDefaultStream(
		1, // input channels (mono mic)
		1, // output channels (mono speaker)
		float64(sampleRate),
		samplesPerFrame,
		inputBuf,
		outputBuf,
	)
	if err != nil {
		return fmt.Errorf("portaudio open stream: %w", err)
	}
	defer stream.Close()

	if err := stream.Start(); err != nil {
		return fmt.Errorf("portaudio start stream: %w", err)
	}
	defer stream.Stop()

	log.Println("Audio bridge active. Press Ctrl+C to hang up.")

	// Create a combined context that also cancels on call end.
	bridgeCtx, bridgeCancel := context.WithCancel(ctx)
	defer bridgeCancel()
	go func() {
		select {
		case <-callEnded:
			log.Println("Remote party hung up (NO CARRIER).")
			bridgeCancel()
		case <-bridgeCtx.Done():
		}
	}()

	var wg sync.WaitGroup

	// Goroutine: modem capture -> speaker (playback to local).
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-bridgeCtx.Done():
				return
			case frame, ok := <-pipeline.CaptureFrames():
				if !ok {
					return
				}
				// Convert bytes to int16 samples for PortAudio output.
				samples := bytesToInt16(frame)
				if len(samples) != samplesPerFrame {
					// Frame size mismatch, skip.
					continue
				}
				copy(outputBuf, samples)
				if err := stream.Write(); err != nil {
					log.Printf("Speaker write error: %v", err)
					return
				}
			}
		}
	}()

	// Goroutine: mic (capture from local) -> modem playback.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-bridgeCtx.Done():
				return
			default:
			}

			if err := stream.Read(); err != nil {
				log.Printf("Mic read error: %v", err)
				return
			}

			// Convert int16 samples to bytes for the modem.
			frame := int16ToBytes(inputBuf)
			if len(frame) != frameBytes {
				continue
			}

			select {
			case pipeline.PlaybackFrames() <- frame:
			case <-bridgeCtx.Done():
				return
			}
		}
	}()

	wg.Wait()
	return nil
}

// bytesToInt16 converts a little-endian byte slice to int16 samples.
func bytesToInt16(data []byte) []int16 {
	n := len(data) / 2
	samples := make([]int16, n)
	for i := range samples {
		samples[i] = int16(binary.LittleEndian.Uint16(data[2*i : 2*i+2]))
	}
	return samples
}

// int16ToBytes converts int16 samples to a little-endian byte slice.
func int16ToBytes(samples []int16) []byte {
	data := make([]byte, len(samples)*2)
	for i, s := range samples {
		binary.LittleEndian.PutUint16(data[2*i:2*i+2], uint16(s))
	}
	return data
}
