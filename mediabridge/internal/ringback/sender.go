package ringback

import (
	"log/slog"
	"sync"
	"time"

	"github.com/pion/rtp"
)

// RTPWriter is an interface for sending RTP packets to the SIP provider.
type RTPWriter interface {
	WriteRTP(pkt *rtp.Packet) error
}

// PCMWriter is an interface for sending raw PCM bytes to a WebSocket provider.
type PCMWriter interface {
	WritePCM(sessionID string, data []byte) error
}

// PCMWriterFunc adapts a function to the PCMWriter interface.
type PCMWriterFunc func(sessionID string, data []byte) error

func (f PCMWriterFunc) WritePCM(sessionID string, data []byte) error {
	return f(sessionID, data)
}

// SenderConfig configures a ringback tone sender.
type SenderConfig struct {
	// Cadence is the ringback cadence type ("eu" or "us").
	Cadence CadenceType

	// SessionID identifies the session (needed for PCM writer path).
	SessionID string

	// Writer sends RTP packets to the provider (SIP path).
	// Mutually exclusive with PCMWriter.
	Writer RTPWriter

	// PCMWriter sends raw PCM 16kHz bytes to the provider (WebSocket path).
	// Mutually exclusive with Writer.
	PCMWriter PCMWriter

	// PayloadType is the RTP payload type for G.711 µ-law (typically 0).
	PayloadType uint8

	// SSRC for the outgoing RTP stream.
	SSRC uint32

	// Logger for ringback sender operations.
	Logger *slog.Logger
}

// Sender generates ringback tone and sends it to the provider while the client
// has not yet connected. Supports both RTP (SIP) and PCM (WebSocket) output modes.
type Sender struct {
	mu        sync.Mutex
	config    SenderConfig
	generator *Generator
	logger    *slog.Logger
	stopCh    chan struct{}
	stopped   bool
	wg        sync.WaitGroup
}

// NewSender creates a new ringback tone sender.
func NewSender(cfg SenderConfig) *Sender {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.SSRC == 0 {
		cfg.SSRC = 0x12345678
	}

	cadence := CadenceForType(cfg.Cadence)
	gen := NewGenerator(cadence)

	return &Sender{
		config:    cfg,
		generator: gen,
		logger:    cfg.Logger,
		stopCh:    make(chan struct{}),
	}
}

// Start begins sending ringback tone in a background goroutine.
func (s *Sender) Start() {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()

	s.generator.Start()
	s.wg.Add(1)

	if s.config.PCMWriter != nil {
		go s.sendLoopPCM()
	} else {
		go s.sendLoopRTP()
	}

	s.logger.Info("ringback sender started",
		slog.String("cadence", string(s.config.Cadence)),
		slog.String("sessionId", s.config.SessionID),
	)
}

// Stop terminates the ringback sender. Safe to call multiple times.
func (s *Sender) Stop() {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return
	}
	s.stopped = true
	s.mu.Unlock()

	close(s.stopCh)
	s.generator.Stop()
	s.wg.Wait()

	s.logger.Info("ringback sender stopped",
		slog.String("sessionId", s.config.SessionID),
	)
}

// sendLoopRTP generates and sends ringback tone as G.711 µ-law RTP packets every 20ms.
func (s *Sender) sendLoopRTP() {
	defer s.wg.Done()

	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()

	var seqNum uint16
	var timestamp uint32

	for {
		select {
		case <-s.stopCh:
			return
		case <-ticker.C:
			// Generate one 20ms frame at 48kHz (960 samples).
			pcm48k := s.generator.GenerateFrame()

			// Downsample 48kHz → 8kHz (960 → 160 samples).
			pcm8k := downsample48to8(pcm48k)

			// Encode to G.711 µ-law.
			payload := encodeUlaw(pcm8k)

			// Build and send RTP packet.
			seqNum++
			timestamp += 160 // 160 samples per 20ms at 8kHz

			pkt := &rtp.Packet{
				Header: rtp.Header{
					Version:        2,
					PayloadType:    s.config.PayloadType,
					SequenceNumber: seqNum,
					Timestamp:      timestamp,
					SSRC:           s.config.SSRC,
				},
				Payload: payload,
			}

			if err := s.config.Writer.WriteRTP(pkt); err != nil {
				s.logger.Debug("ringback RTP write error",
					slog.String("error", err.Error()),
				)
			}
		}
	}
}

// sendLoopPCM generates and sends ringback tone as PCM 16kHz bytes every 20ms.
// This is used for WebSocket-based providers (46elks, generic audio WS).
func (s *Sender) sendLoopPCM() {
	defer s.wg.Done()

	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-s.stopCh:
			return
		case <-ticker.C:
			// Generate one 20ms frame at 48kHz (960 samples).
			pcm48k := s.generator.GenerateFrame()

			// Downsample 48kHz → 16kHz (960 → 320 samples).
			pcm16k := downsample48to16(pcm48k)

			// Convert to little-endian bytes.
			pcmBytes := pcm16ToBytes(pcm16k)

			if err := s.config.PCMWriter.WritePCM(s.config.SessionID, pcmBytes); err != nil {
				s.logger.Debug("ringback PCM write error",
					slog.String("error", err.Error()),
				)
			}
		}
	}
}

// downsample48to8 converts 48kHz PCM to 8kHz by taking every 6th sample
// with a simple 3-tap averaging filter.
func downsample48to8(input []int16) []int16 {
	const ratio = 6
	outputLen := len(input) / ratio
	output := make([]int16, outputLen)

	for i := 0; i < outputLen; i++ {
		idx := i * ratio
		if idx > 0 && idx < len(input)-1 {
			sum := int32(input[idx-1]) + int32(input[idx])*2 + int32(input[idx+1])
			output[i] = int16(sum / 4)
		} else {
			output[i] = input[idx]
		}
	}

	return output
}

// downsample48to16 converts 48kHz PCM to 16kHz by taking every 3rd sample
// with a simple 3-tap averaging filter.
func downsample48to16(input []int16) []int16 {
	const ratio = 3
	outputLen := len(input) / ratio
	output := make([]int16, outputLen)

	for i := 0; i < outputLen; i++ {
		idx := i * ratio
		if idx > 0 && idx < len(input)-1 {
			sum := int32(input[idx-1]) + int32(input[idx])*2 + int32(input[idx+1])
			output[i] = int16(sum / 4)
		} else {
			output[i] = input[idx]
		}
	}

	return output
}

// pcm16ToBytes converts PCM int16 samples to little-endian byte slice.
func pcm16ToBytes(pcm []int16) []byte {
	buf := make([]byte, len(pcm)*2)
	for i, sample := range pcm {
		buf[i*2] = byte(sample)
		buf[i*2+1] = byte(sample >> 8)
	}
	return buf
}

// encodeUlaw encodes PCM int16 samples to G.711 µ-law bytes.
func encodeUlaw(pcm []int16) []byte {
	const (
		bias = 0x84
		clip = 32635
	)

	expLut := [256]int{
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

	encoded := make([]byte, len(pcm))
	for i, sample := range pcm {
		// Determine sign.
		sign := 0
		if sample < 0 {
			sign = 0x80
			sample = -sample
		}

		// Clip to max.
		if int(sample) > clip {
			sample = clip
		}

		// Add bias.
		sample += bias

		// Find segment (exponent).
		exp := expLut[int(sample)>>7]

		// Combine sign, exponent, mantissa and complement.
		mantissa := (int(sample) >> (exp + 3)) & 0x0F
		encoded[i] = byte(^(sign | (exp << 4) | mantissa))
	}

	return encoded
}
