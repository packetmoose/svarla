package bridge

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/pion/rtp"
)

// Direction indicates the flow direction of audio.
type Direction string

const (
	// ClientToProvider is audio flowing from WebRTC client to SIP/WS provider.
	ClientToProvider Direction = "client-to-provider"
	// ProviderToClient is audio flowing from SIP/WS provider to WebRTC client.
	ProviderToClient Direction = "provider-to-client"
)

// RTPWriter is an interface for sending RTP packets (to SIP or WebRTC).
type RTPWriter interface {
	WriteRTP(pkt *rtp.Packet) error
}

// RTPWriterFunc adapts a function to the RTPWriter interface.
type RTPWriterFunc func(pkt *rtp.Packet) error

func (f RTPWriterFunc) WriteRTP(pkt *rtp.Packet) error {
	return f(pkt)
}

// PCMHandler is called with decoded PCM frames for additional processing (e.g., audio tap).
type PCMHandler func(direction Direction, pcm []int16)

// Config holds configuration for an audio bridge instance.
type Config struct {
	// SessionID identifies this bridge's session.
	SessionID string

	// SIPCodec is the negotiated SIP-side codec ("PCMU" for G.711 µ-law).
	SIPCodec string

	// SIPClockRate is the SIP codec clock rate (8000 for G.711).
	SIPClockRate int

	// SIPPayloadType is the RTP payload type for the SIP codec.
	SIPPayloadType uint8

	// JitterDepth is the number of frames to buffer in the jitter buffer.
	// Default: DefaultJitterDepth (2 frames = 40ms).
	JitterDepth int

	// PCMHandler is an optional callback for tapping decoded PCM audio.
	PCMHandler PCMHandler

	// Logger for bridge operations.
	Logger *slog.Logger
}

// Bridge manages bidirectional audio flow between a WebRTC leg and a SIP leg.
// With PCMU (G.711 µ-law) on both the SIP and WebRTC sides, audio passes
// through with zero transcoding. The bridge handles jitter buffering and
// RTP re-packetization only.
//
// Audio paths:
//   - Client→Provider: WebRTC PCMU RTP → passthrough → SIP RTP
//   - Provider→Client: SIP PCMU RTP → jitter buffer → passthrough → WebRTC RTP
type Bridge struct {
	config Config
	logger *slog.Logger

	// jitterBuf smooths SIP RTP packet timing.
	jitterBuf *JitterBuffer

	// Writers for each direction.
	mu            sync.RWMutex
	sipWriter     RTPWriter // sends RTP to SIP leg
	webrtcWriter  RTPWriter // sends RTP to WebRTC leg
	pcmWriter     PCMWriter // sends raw PCM to audio WS provider leg (alternative to sipWriter)

	// Sequence number counters for outgoing RTP.
	sipSeqNum    uint16
	sipTimestamp uint32
	webrtcSeqNum    uint16
	webrtcTimestamp uint32

	// Lifecycle.
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	running bool
}

// New creates a new audio bridge for the given session.
func New(cfg Config) (*Bridge, error) {
	if cfg.JitterDepth == 0 {
		cfg.JitterDepth = DefaultJitterDepth
	}
	if cfg.SIPClockRate == 0 {
		cfg.SIPClockRate = G711SampleRate
	}
	if cfg.SIPPayloadType == 0 {
		cfg.SIPPayloadType = 0 // PCMU static payload type
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}

	ctx, cancel := context.WithCancel(context.Background())

	return &Bridge{
		config:    cfg,
		logger:    cfg.Logger,
		jitterBuf: NewJitterBuffer(cfg.JitterDepth),
		ctx:       ctx,
		cancel:    cancel,
	}, nil
}

// SetSIPWriter sets the RTP writer for sending packets to the SIP leg.
func (b *Bridge) SetSIPWriter(w RTPWriter) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.sipWriter = w
}

// SetWebRTCWriter sets the RTP writer for sending packets to the WebRTC leg.
func (b *Bridge) SetWebRTCWriter(w RTPWriter) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.webrtcWriter = w
}

// Start begins the bridge processing goroutines.
func (b *Bridge) Start() {
	b.mu.Lock()
	if b.running {
		b.mu.Unlock()
		return
	}
	b.running = true
	b.mu.Unlock()

	// Start the jitter buffer playout goroutine.
	b.wg.Add(1)
	go b.jitterPlayoutLoop()

	b.logger.Info("audio bridge started",
		slog.String("sessionId", b.config.SessionID),
		slog.String("sipCodec", b.config.SIPCodec),
		slog.Int("jitterDepth", b.config.JitterDepth),
	)
}

// Stop terminates the bridge and releases resources.
func (b *Bridge) Stop() {
	b.mu.Lock()
	if !b.running {
		b.mu.Unlock()
		return
	}
	b.running = false
	b.mu.Unlock()

	b.cancel()
	b.wg.Wait()

	b.logger.Info("audio bridge stopped",
		slog.String("sessionId", b.config.SessionID),
	)
}

// HandleClientRTP processes an RTP packet from the WebRTC client leg.
// With PCMU negotiated, the browser sends G.711 µ-law at 8kHz.
// We pass it directly to the SIP provider (same codec, zero transcoding).
func (b *Bridge) HandleClientRTP(pkt *rtp.Packet) {
	b.mu.RLock()
	writer := b.sipWriter
	b.mu.RUnlock()

	if writer == nil {
		return
	}

	if len(pkt.Payload) == 0 {
		return
	}

	// Notify PCM handler (audio tap) if configured.
	if b.config.PCMHandler != nil {
		pcm8k := DecodeUlaw(pkt.Payload)
		b.config.PCMHandler(ClientToProvider, pcm8k)
	}

	// G.711 µ-law passthrough — same codec on both sides, no transcoding needed.
	b.mu.Lock()
	b.sipSeqNum++
	seqNum := b.sipSeqNum
	b.sipTimestamp += uint32(len(pkt.Payload))
	timestamp := b.sipTimestamp
	b.mu.Unlock()

	rtpPkt := &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    b.config.SIPPayloadType,
			SequenceNumber: seqNum,
			Timestamp:      timestamp,
			SSRC:           0x12345678,
		},
		Payload: pkt.Payload,
	}

	if err := writer.WriteRTP(rtpPkt); err != nil {
		b.logger.Debug("failed to write RTP to SIP",
			slog.String("sessionId", b.config.SessionID),
			slog.String("error", err.Error()),
		)
	}
}

// HandleClientPCM processes decoded PCM audio from the WebRTC client.
// The PCM is expected at 48kHz, 16-bit, mono (960 samples per 20ms frame).
// This is the main path for client→provider audio when Opus decoding
// is handled externally (by Pion interceptors or a separate decoder).
func (b *Bridge) HandleClientPCM(pcm48k []int16) {
	b.mu.RLock()
	writer := b.sipWriter
	b.mu.RUnlock()

	if writer == nil {
		return
	}

	// Notify PCM handler (audio tap) if configured.
	if b.config.PCMHandler != nil {
		b.config.PCMHandler(ClientToProvider, pcm48k)
	}

	// Downsample 48kHz → 8kHz.
	pcm8k := Downsample48to8(pcm48k)

	// Encode to G.711 µ-law.
	g711Payload := EncodeUlaw(pcm8k)

	// Build RTP packet for SIP leg.
	b.mu.Lock()
	b.sipSeqNum++
	seqNum := b.sipSeqNum
	b.sipTimestamp += uint32(G711FrameSize)
	timestamp := b.sipTimestamp
	b.mu.Unlock()

	rtpPkt := &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    b.config.SIPPayloadType,
			SequenceNumber: seqNum,
			Timestamp:      timestamp,
			SSRC:           0x12345678, // Fixed SSRC for the bridge
		},
		Payload: g711Payload,
	}

	if err := writer.WriteRTP(rtpPkt); err != nil {
		b.logger.Debug("failed to write RTP to SIP",
			slog.String("sessionId", b.config.SessionID),
			slog.String("error", err.Error()),
		)
	}
}

// HandleProviderRTP processes an RTP packet from the SIP provider leg.
// The packet contains G.711 µ-law encoded audio at 8kHz.
// Packets are placed into the jitter buffer and played out at regular intervals.
func (b *Bridge) HandleProviderRTP(pkt *rtp.Packet) {
	jitterPkt := &JitterPacket{
		SequenceNumber: pkt.Header.SequenceNumber,
		Timestamp:      pkt.Header.Timestamp,
		Payload:        pkt.Payload,
		ReceivedAt:     time.Now(),
	}

	b.jitterBuf.Push(jitterPkt)
}

// jitterPlayoutLoop runs in a goroutine, pulling packets from the jitter buffer
// at regular 20ms intervals and forwarding them to the WebRTC leg.
func (b *Bridge) jitterPlayoutLoop() {
	defer b.wg.Done()

	// Play out one frame every 20ms (G.711 at 8kHz = 160 samples/frame = 20ms).
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-b.ctx.Done():
			return
		case <-ticker.C:
			b.playoutFrame()
		}
	}
}

// playoutFrame pulls one frame from the jitter buffer and sends it to WebRTC.
func (b *Bridge) playoutFrame() {
	pkt := b.jitterBuf.Pop()
	if pkt == nil {
		return
	}

	b.mu.RLock()
	writer := b.webrtcWriter
	b.mu.RUnlock()

	if writer == nil {
		return
	}

	if len(pkt.Payload) == 0 {
		return
	}

	// Notify PCM handler (audio tap) if configured.
	if b.config.PCMHandler != nil {
		pcm8k := DecodeUlaw(pkt.Payload)
		b.config.PCMHandler(ProviderToClient, pcm8k)
	}

	// With PCMU on the WebRTC side, pass G.711 µ-law directly to the client.
	// No transcoding needed — the browser decodes G.711 natively.
	b.mu.Lock()
	b.webrtcSeqNum++
	seqNum := b.webrtcSeqNum
	b.webrtcTimestamp += uint32(len(pkt.Payload)) // 160 samples per 20ms at 8kHz
	timestamp := b.webrtcTimestamp
	b.mu.Unlock()

	rtpPkt := &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    0, // PCMU
			SequenceNumber: seqNum,
			Timestamp:      timestamp,
			SSRC:           0x87654321,
		},
		Payload: pkt.Payload,
	}

	if err := writer.WriteRTP(rtpPkt); err != nil {
		b.logger.Debug("failed to write RTP to WebRTC",
			slog.String("sessionId", b.config.SessionID),
			slog.String("error", err.Error()),
		)
	}
}

// JitterStats returns the current jitter buffer statistics.
func (b *Bridge) JitterStats() JitterStats {
	return b.jitterBuf.Stats()
}

// IsRunning reports whether the bridge is currently active.
func (b *Bridge) IsRunning() bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.running
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

// BytesToPCM16 converts little-endian byte slice to PCM int16 samples.
func BytesToPCM16(data []byte) []int16 {
	pcm := make([]int16, len(data)/2)
	for i := range pcm {
		pcm[i] = int16(data[i*2]) | int16(data[i*2+1])<<8
	}
	return pcm
}

// FormatBridgeInfo returns a summary string of bridge configuration.
func FormatBridgeInfo(cfg Config) string {
	return fmt.Sprintf("bridge[session=%s codec=%s rate=%d jitter=%d]",
		cfg.SessionID, cfg.SIPCodec, cfg.SIPClockRate, cfg.JitterDepth)
}

// PCMWriter is an interface for sending raw PCM data (to audio WebSocket provider).
type PCMWriter interface {
	WritePCM(data []byte) error
}

// PCMWriterFunc adapts a function to the PCMWriter interface.
type PCMWriterFunc func(data []byte) error

func (f PCMWriterFunc) WritePCM(data []byte) error {
	return f(data)
}

// SetPCMWriter sets the writer for sending PCM audio to the WebSocket provider leg.
// When set, client audio is sent as PCM instead of RTP to this writer.
func (b *Bridge) SetPCMWriter(w PCMWriter) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pcmWriter = w
}

// HandleProviderPCM16k processes a raw PCM 16-bit 16kHz buffer from the audio WebSocket provider.
// Downsamples to 8kHz and forwards to the WebRTC client via the jitter buffer path.
func (b *Bridge) HandleProviderPCM16k(pcm16k []byte) {
	// Convert bytes to int16 samples
	samples16k := BytesToPCM16(pcm16k)

	// Downsample 16kHz → 8kHz (take every 2nd sample with simple averaging)
	samples8k := downsample16to8(samples16k)

	// Notify PCM handler (audio tap) if configured.
	if b.config.PCMHandler != nil {
		b.config.PCMHandler(ProviderToClient, samples8k)
	}

	// Encode to G.711 µ-law
	g711Payload := EncodeUlaw(samples8k)

	// Create an RTP-like packet for the jitter buffer
	b.mu.Lock()
	b.webrtcSeqNum++
	seqNum := b.webrtcSeqNum
	b.webrtcTimestamp += uint32(len(samples8k))
	timestamp := b.webrtcTimestamp
	b.mu.Unlock()

	// Instead of going through the jitter buffer (which adds latency for already-timed data),
	// write directly to WebRTC.
	b.mu.RLock()
	writer := b.webrtcWriter
	b.mu.RUnlock()

	if writer == nil {
		return
	}

	rtpPkt := &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    0, // PCMU
			SequenceNumber: seqNum,
			Timestamp:      timestamp,
			SSRC:           0x87654321,
		},
		Payload: g711Payload,
	}

	if err := writer.WriteRTP(rtpPkt); err != nil {
		b.logger.Debug("failed to write PCM-sourced RTP to WebRTC",
			slog.String("sessionId", b.config.SessionID),
			slog.String("error", err.Error()),
		)
	}
}

// HandleClientRTPForPCM processes an RTP packet from the WebRTC client and sends
// it to the PCM writer (audio WebSocket) instead of the SIP writer.
// Decodes G.711 µ-law to PCM 8kHz, upsamples to 16kHz, and writes as raw bytes.
// Accumulates multiple frames before sending to reduce per-packet overhead.
func (b *Bridge) HandleClientRTPForPCM(pkt *rtp.Packet) {
	b.mu.RLock()
	pcmW := b.pcmWriter
	b.mu.RUnlock()

	if pcmW == nil {
		return
	}

	if len(pkt.Payload) == 0 {
		return
	}

	// Notify PCM handler (audio tap) if configured.
	if b.config.PCMHandler != nil {
		pcm8k := DecodeUlaw(pkt.Payload)
		b.config.PCMHandler(ClientToProvider, pcm8k)
	}

	// Decode G.711 µ-law to PCM 8kHz
	pcm8k := DecodeUlaw(pkt.Payload)

	// Upsample 8kHz → 16kHz
	pcm16k := upsample8to16(pcm8k)

	// Convert to bytes and send immediately.
	// Each RTP packet is 20ms; sending individually keeps latency low.
	pcmBytes := pcm16ToBytes(pcm16k)

	if err := pcmW.WritePCM(pcmBytes); err != nil {
		b.logger.Debug("failed to write PCM to provider WS",
			slog.String("sessionId", b.config.SessionID),
			slog.String("error", err.Error()),
		)
	}
}

// downsample16to8 converts PCM audio from 16kHz to 8kHz.
// Takes every 2nd sample with averaging for simple anti-aliasing.
func downsample16to8(input []int16) []int16 {
	outputLen := len(input) / 2
	output := make([]int16, outputLen)
	for i := 0; i < outputLen; i++ {
		idx := i * 2
		if idx+1 < len(input) {
			output[i] = int16((int32(input[idx]) + int32(input[idx+1])) / 2)
		} else {
			output[i] = input[idx]
		}
	}
	return output
}

// upsample8to16 converts PCM audio from 8kHz to 16kHz using linear interpolation.
func upsample8to16(input []int16) []int16 {
	outputLen := len(input) * 2
	output := make([]int16, outputLen)
	for i := 0; i < len(input); i++ {
		output[i*2] = input[i]
		if i+1 < len(input) {
			// Linear interpolation between samples
			output[i*2+1] = int16((int32(input[i]) + int32(input[i+1])) / 2)
		} else {
			output[i*2+1] = input[i]
		}
	}
	return output
}
