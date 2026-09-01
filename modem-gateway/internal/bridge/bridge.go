// Package bridge implements the per-call Audio WebSocket client to the
// MediaBridge for bidirectional PCM audio streaming.
package bridge

import (
	"context"
	"crypto/tls"
	"errors"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// sendInterval is the timer-driven interval for sending PCM frames to MediaBridge.
	// Each frame represents 20ms of audio.
	sendInterval = 20 * time.Millisecond

	// writeWait is the time allowed to write a message to the peer.
	writeWait = 10 * time.Second

	// pongWait is the maximum time to wait for any activity (pong or data) from the server.
	// If no activity is received within this period, the connection is considered dead.
	pongWait = 60 * time.Second

	// dialTimeout is the maximum time allowed for the WebSocket handshake.
	dialTimeout = 15 * time.Second
)

// Errors returned by the audio bridge.
var (
	ErrAlreadyConnected = errors.New("bridge: already connected")
	ErrNotConnected     = errors.New("bridge: not connected")
	ErrAlreadyStreaming = errors.New("bridge: already streaming")
	ErrNotStreaming     = errors.New("bridge: not streaming")
)

// AudioBridge manages a per-call WebSocket connection to the MediaBridge
// for bidirectional PCM audio streaming. It reads captured PCM frames from
// the audio pipeline and sends them to the MediaBridge, while receiving
// PCM frames from the MediaBridge and writing them to the playback channel.
type AudioBridge struct {
	tlsConfig *tls.Config

	conn   *websocket.Conn
	connMu sync.Mutex

	connected bool
	streaming bool
	stateMu   sync.RWMutex

	stopCh chan struct{}
	wg     sync.WaitGroup
}

// New creates a new AudioBridge. The tlsConfig applies the same TLS settings
// as the signaling WebSocket (custom CA cert, skip-verify). Pass nil to use
// system defaults.
func New(tlsConfig *tls.Config) *AudioBridge {
	return &AudioBridge{
		tlsConfig: tlsConfig,
	}
}

// Connect establishes the Audio WebSocket connection to the MediaBridge at
// the given URL (e.g., wss://host/audio/{sessionId}). The context controls
// the dial timeout.
func (b *AudioBridge) Connect(ctx context.Context, url string) error {
	b.connMu.Lock()
	defer b.connMu.Unlock()

	if b.connected {
		return ErrAlreadyConnected
	}

	dialer := websocket.Dialer{
		TLSClientConfig:  b.tlsConfig,
		HandshakeTimeout: dialTimeout,
	}

	conn, _, err := dialer.DialContext(ctx, url, http.Header{})
	if err != nil {
		return err
	}

	b.conn = conn
	b.connected = true
	b.stopCh = make(chan struct{})

	// Set up ping handler: respond to server pings and extend read deadline.
	b.conn.SetPingHandler(func(appData string) error {
		_ = b.conn.SetReadDeadline(time.Now().Add(pongWait))
		b.connMu.Lock()
		err := b.conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(writeWait))
		b.connMu.Unlock()
		return err
	})

	// Set up pong handler to extend read deadline on pong received.
	b.conn.SetPongHandler(func(appData string) error {
		_ = b.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	return nil
}

// StartStreaming begins the bidirectional PCM frame pump. It reads frames from
// the capture channel and sends them to the MediaBridge at 20ms intervals, and
// reads binary frames from the MediaBridge and writes them to the playback channel.
//
// StartStreaming must be called after Connect. It blocks until Close is called
// or the connection is lost.
func (b *AudioBridge) StartStreaming(capture <-chan []byte, playback chan<- []byte) error {
	b.stateMu.Lock()
	if !b.connected {
		b.stateMu.Unlock()
		return ErrNotConnected
	}
	if b.streaming {
		b.stateMu.Unlock()
		return ErrAlreadyStreaming
	}
	b.streaming = true
	b.stateMu.Unlock()

	b.wg.Add(2)
	go b.sendLoop(capture)
	go b.receiveLoop(playback)

	return nil
}

// Close sends a normal WebSocket close frame and stops the streaming goroutines.
// It is safe to call Close multiple times.
func (b *AudioBridge) Close() error {
	b.connMu.Lock()
	if !b.connected {
		b.connMu.Unlock()
		return nil
	}
	b.connected = false
	close(b.stopCh)

	// Send a normal-closure frame, then close the underlying connection NOW,
	// before waiting for the goroutines. receiveLoop blocks in
	// conn.ReadMessage(), which is not interrupted by closing stopCh — it only
	// returns when the connection is closed or the read deadline expires.
	// Closing the connection here unblocks it immediately; otherwise Close()
	// would deadlock in wg.Wait() until the read deadline (~pongWait) elapsed.
	var closeErr error
	if b.conn != nil {
		_ = b.conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
			time.Now().Add(writeWait),
		)
		closeErr = b.conn.Close()
		b.conn = nil
	}
	b.connMu.Unlock()

	b.stateMu.Lock()
	b.streaming = false
	b.stateMu.Unlock()

	// Wait for the send/receive goroutines to finish (now unblocked).
	b.wg.Wait()

	return closeErr
}

// IsConnected returns true if the bridge has an active WebSocket connection.
func (b *AudioBridge) IsConnected() bool {
	b.stateMu.RLock()
	defer b.stateMu.RUnlock()
	return b.connected
}

// sendLoop reads PCM frames from the capture channel at 20ms intervals and
// sends them as binary WebSocket frames to the MediaBridge.
func (b *AudioBridge) sendLoop(capture <-chan []byte) {
	defer b.wg.Done()

	ticker := time.NewTicker(sendInterval)
	defer ticker.Stop()

	for {
		select {
		case <-b.stopCh:
			return
		case <-ticker.C:
			// Read a frame from capture if available.
			select {
			case frame, ok := <-capture:
				if !ok {
					return
				}
				b.connMu.Lock()
				if b.conn == nil {
					b.connMu.Unlock()
					return
				}
				_ = b.conn.SetWriteDeadline(time.Now().Add(writeWait))
				err := b.conn.WriteMessage(websocket.BinaryMessage, frame)
				b.connMu.Unlock()

				if err != nil {
					// Write failed; connection is dead.
					return
				}
			case <-b.stopCh:
				return
			default:
				// No frame available this tick; skip (underrun).
			}
		}
	}
}

// receiveLoop reads binary PCM frames from the MediaBridge WebSocket and
// writes them to the playback channel.
func (b *AudioBridge) receiveLoop(playback chan<- []byte) {
	defer b.wg.Done()

	// Snapshot the connection. Close() may set b.conn = nil concurrently to
	// unblock this loop; the captured reference remains valid (ReadMessage
	// returns an error once the connection is closed).
	b.connMu.Lock()
	conn := b.conn
	b.connMu.Unlock()
	if conn == nil {
		return
	}

	// Set initial read deadline for dead connection detection.
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))

	var rxFrames int64
	var droppedFrames int64

	for {
		select {
		case <-b.stopCh:
			return
		default:
		}

		msgType, data, err := conn.ReadMessage()
		if err != nil {
			// Connection closed or read deadline exceeded (dead connection).
			return
		}

		// Extend read deadline on any received message.
		_ = conn.SetReadDeadline(time.Now().Add(pongWait))

		// Only process binary frames (PCM audio data).
		if msgType != websocket.BinaryMessage {
			continue
		}

		// Downlink diagnostics: log the first frame received and periodically
		// so we can confirm app->modem audio is actually arriving from
		// MediaBridge and see its size/format.
		rxFrames++
		if rxFrames == 1 {
			dumpLen := 32
			if len(data) < dumpLen {
				dumpLen = len(data)
			}
			log.Printf("[bridge RX] first downlink frame received: %d bytes, first bytes (hex): %x", len(data), data[:dumpLen])
		} else if rxFrames%500 == 0 {
			log.Printf("[bridge RX] downlink frame %d received (%d bytes)", rxFrames, len(data))
		}

		// Send to playback, drop frame if channel is full (back-pressure).
		select {
		case playback <- data:
		case <-b.stopCh:
			return
		default:
			// Playback channel full; drop frame to avoid blocking.
			droppedFrames++
			if droppedFrames == 1 || droppedFrames%500 == 0 {
				log.Printf("[bridge RX] WARNING: playback channel full, dropped downlink frame (%d dropped total)", droppedFrames)
			}
		}
	}
}
