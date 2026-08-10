// Package audiotap implements an optional audio tap that copies decoded PCM frames
// to a configured endpoint (WebSocket or Unix socket) for future processing
// (recording, transcription, translation). The tap runs in a separate goroutine
// with non-blocking frame delivery, ensuring zero latency on the main audio path.
//
// When disabled, the tap is a complete no-op with zero overhead.
//
// # Protocol Format (Tap Endpoint)
//
// The tap endpoint receives binary WebSocket messages (or Unix socket datagrams)
// containing framed PCM audio with a header. Each message has the following format:
//
//	┌──────────────────────────────────────────────────────────────────┐
//	│ Byte 0       │ Direction (1 = client-to-provider, 2 = provider-to-client) │
//	│ Bytes 1-4    │ Sequence number (uint32, big-endian)                       │
//	│ Bytes 5-8    │ Timestamp in milliseconds since session start (uint32, BE) │
//	│ Bytes 9-N    │ PCM audio data (16kHz, 16-bit signed little-endian, mono)  │
//	└──────────────────────────────────────────────────────────────────┘
//
// Audio format:
//   - Sample rate: 16000 Hz
//   - Bit depth: 16-bit signed integer (little-endian)
//   - Channels: mono (separate messages for each direction)
//   - Frame size: typically 20ms (640 bytes of PCM = 320 samples)
//
// Direction labels:
//   - 0x01: client-to-provider (audio from the client going to the telephony provider)
//   - 0x02: provider-to-client (audio from the telephony provider going to the client)
//
// The tap endpoint should be prepared to receive frames at approximately 50 fps
// (20ms frame interval) per direction. If the tap consumer cannot keep up, frames
// are silently dropped — the main audio path is never blocked.
package audiotap

import (
	"encoding/binary"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Direction indicates the audio flow direction for a tap frame.
type Direction byte

const (
	// DirectionClientToProvider is audio from the client heading to the provider.
	DirectionClientToProvider Direction = 0x01
	// DirectionProviderToClient is audio from the provider heading to the client.
	DirectionProviderToClient Direction = 0x02
)

const (
	// headerSize is the size of the frame header in bytes (1 + 4 + 4).
	headerSize = 9

	// channelBufferSize is the non-blocking channel capacity for each direction.
	// At 50fps (20ms frames), this holds ~2 seconds of frames.
	channelBufferSize = 100

	// wsWriteTimeout is the max time for writing a single message to the tap endpoint.
	wsWriteTimeout = 500 * time.Millisecond

	// wsDialTimeout is the max time to wait when connecting to the tap endpoint.
	wsDialTimeout = 5 * time.Second

	// reconnectDelay is the time to wait before attempting reconnection.
	reconnectDelay = 1 * time.Second
)

// frame is an internal representation of a tap frame queued for sending.
type frame struct {
	direction Direction
	seq       uint32
	timestamp uint32
	pcmData   []byte
}

// Tap is the interface for the audio tap. When disabled, a NullTap is returned
// that does nothing. When enabled, a LiveTap streams frames to the endpoint.
type Tap interface {
	// Write enqueues a PCM frame for delivery to the tap endpoint.
	// This method is non-blocking: if the internal buffer is full, the frame is dropped.
	// Safe to call from any goroutine.
	Write(direction Direction, pcmData []byte)

	// Close shuts down the tap, closing the connection and stopping the sender goroutine.
	Close()
}

// NullTap is a no-op tap used when audio tapping is disabled.
// All methods are no-ops with zero allocation.
type NullTap struct{}

// Write is a no-op.
func (NullTap) Write(_ Direction, _ []byte) {}

// Close is a no-op.
func (NullTap) Close() {}

// New creates a new Tap. If enabled is false, returns a NullTap (zero overhead).
// If enabled is true, creates a LiveTap that connects to the endpoint and streams frames.
// Endpoint must be a ws://, wss://, or unix:// URL.
func New(enabled bool, endpoint string, logger *slog.Logger) (Tap, error) {
	if !enabled {
		return NullTap{}, nil
	}

	if endpoint == "" {
		return nil, fmt.Errorf("audiotap: endpoint is required when enabled")
	}

	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("audiotap: invalid endpoint URL: %w", err)
	}

	switch u.Scheme {
	case "ws", "wss", "unix":
		// Valid schemes
	default:
		return nil, fmt.Errorf("audiotap: unsupported endpoint scheme %q (must be ws://, wss://, or unix://)", u.Scheme)
	}

	lt := &LiveTap{
		endpoint: endpoint,
		scheme:   u.Scheme,
		unixPath: u.Path, // Only used for unix:// scheme
		logger:   logger,
		frames:   make(chan frame, channelBufferSize),
		done:     make(chan struct{}),
		start:    time.Now(),
	}

	lt.wg.Add(1)
	go lt.senderLoop()

	return lt, nil
}

// LiveTap is an active audio tap that streams PCM frames to an endpoint.
type LiveTap struct {
	endpoint string
	scheme   string
	unixPath string
	logger   *slog.Logger

	frames chan frame
	done   chan struct{}
	wg     sync.WaitGroup
	start  time.Time

	// Sequence counters per direction (atomic for lock-free increment).
	seqClient   atomic.Uint32
	seqProvider atomic.Uint32

	// Connection state (accessed only from senderLoop goroutine).
	wsConn   *websocket.Conn
	unixConn net.Conn

	closeOnce sync.Once
}

// Write enqueues a PCM frame for delivery. Non-blocking: drops frame if buffer full.
func (lt *LiveTap) Write(direction Direction, pcmData []byte) {
	var seq uint32
	switch direction {
	case DirectionClientToProvider:
		seq = lt.seqClient.Add(1)
	case DirectionProviderToClient:
		seq = lt.seqProvider.Add(1)
	}

	ts := uint32(time.Since(lt.start).Milliseconds())

	// Make a copy of pcmData to avoid holding references to caller's buffer.
	data := make([]byte, len(pcmData))
	copy(data, pcmData)

	f := frame{
		direction: direction,
		seq:       seq,
		timestamp: ts,
		pcmData:   data,
	}

	// Non-blocking send: drop frame if channel is full.
	select {
	case lt.frames <- f:
	default:
		// Frame dropped — tap consumer too slow.
	}
}

// Close shuts down the tap.
func (lt *LiveTap) Close() {
	lt.closeOnce.Do(func() {
		close(lt.done)
	})
	lt.wg.Wait()
}

// senderLoop runs in a dedicated goroutine, reading frames from the channel
// and writing them to the tap endpoint. It handles connection and reconnection.
func (lt *LiveTap) senderLoop() {
	defer lt.wg.Done()
	defer lt.disconnect()

	for {
		// Ensure we're connected.
		if !lt.isConnected() {
			if err := lt.connect(); err != nil {
				lt.logger.Warn("audiotap: connection failed",
					slog.String("endpoint", lt.endpoint),
					slog.String("error", err.Error()),
				)
				// Wait before retrying, but check for shutdown.
				select {
				case <-lt.done:
					return
				case <-time.After(reconnectDelay):
					continue
				}
			}
			lt.logger.Info("audiotap: connected", slog.String("endpoint", lt.endpoint))
		}

		// Read frames and send them.
		select {
		case <-lt.done:
			return
		case f := <-lt.frames:
			if err := lt.sendFrame(f); err != nil {
				lt.logger.Warn("audiotap: send failed, reconnecting",
					slog.String("error", err.Error()),
				)
				lt.disconnect()
			}
		}
	}
}

// connect establishes a connection to the tap endpoint.
func (lt *LiveTap) connect() error {
	switch lt.scheme {
	case "ws", "wss":
		dialer := websocket.Dialer{
			HandshakeTimeout: wsDialTimeout,
		}
		conn, _, err := dialer.Dial(lt.endpoint, nil)
		if err != nil {
			return fmt.Errorf("websocket dial: %w", err)
		}
		lt.wsConn = conn
		return nil

	case "unix":
		path := lt.unixPath
		if path == "" {
			// For unix:///path/to/socket, the path comes from the URL path.
			// For unix://path/to/socket (no leading slash after authority), use Host+Path.
			parsed, _ := url.Parse(lt.endpoint)
			if parsed != nil {
				path = parsed.Host + parsed.Path
			}
		}
		conn, err := net.DialTimeout("unix", path, wsDialTimeout)
		if err != nil {
			return fmt.Errorf("unix dial: %w", err)
		}
		lt.unixConn = conn
		return nil

	default:
		return fmt.Errorf("unsupported scheme: %s", lt.scheme)
	}
}

// isConnected checks if we have an active connection.
func (lt *LiveTap) isConnected() bool {
	switch lt.scheme {
	case "ws", "wss":
		return lt.wsConn != nil
	case "unix":
		return lt.unixConn != nil
	}
	return false
}

// disconnect closes the current connection.
func (lt *LiveTap) disconnect() {
	if lt.wsConn != nil {
		_ = lt.wsConn.Close()
		lt.wsConn = nil
	}
	if lt.unixConn != nil {
		_ = lt.unixConn.Close()
		lt.unixConn = nil
	}
}

// sendFrame serializes and sends a frame to the connected endpoint.
func (lt *LiveTap) sendFrame(f frame) error {
	msg := encodeFrame(f)

	switch lt.scheme {
	case "ws", "wss":
		if lt.wsConn == nil {
			return fmt.Errorf("not connected")
		}
		_ = lt.wsConn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
		return lt.wsConn.WriteMessage(websocket.BinaryMessage, msg)

	case "unix":
		if lt.unixConn == nil {
			return fmt.Errorf("not connected")
		}
		_ = lt.unixConn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
		_, err := lt.unixConn.Write(msg)
		return err

	default:
		return fmt.Errorf("unsupported scheme: %s", lt.scheme)
	}
}

// encodeFrame serializes a frame into the wire format.
func encodeFrame(f frame) []byte {
	msg := make([]byte, headerSize+len(f.pcmData))
	msg[0] = byte(f.direction)
	binary.BigEndian.PutUint32(msg[1:5], f.seq)
	binary.BigEndian.PutUint32(msg[5:9], f.timestamp)
	copy(msg[headerSize:], f.pcmData)
	return msg
}

// ParseEndpoint validates and normalizes a tap endpoint URL.
// Returns an error if the URL is invalid or uses an unsupported scheme.
func ParseEndpoint(endpoint string) error {
	if endpoint == "" {
		return fmt.Errorf("endpoint is empty")
	}

	u, err := url.Parse(endpoint)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}

	scheme := strings.ToLower(u.Scheme)
	switch scheme {
	case "ws", "wss", "unix":
		return nil
	default:
		return fmt.Errorf("unsupported scheme %q (must be ws://, wss://, or unix://)", scheme)
	}
}
