package signaling

import (
	"context"
	"crypto/tls"
	"errors"
	"log"
	"math"
	"sync"
	"time"
)

const (
	// DefaultInitialBackoff is the starting delay between reconnection attempts.
	DefaultInitialBackoff = 1 * time.Second

	// DefaultMaxBackoff is the maximum delay between reconnection attempts (60s cap).
	DefaultMaxBackoff = 60 * time.Second

	// connectionCheckInterval is how often we poll the underlying client for disconnect.
	connectionCheckInterval = 500 * time.Millisecond
)

// Authenticator is the interface for performing authentication on a newly
// connected signaling WebSocket. Implementations handle the initial pairing
// flow (auth_pair) and the challenge-response reconnection flow.
type Authenticator interface {
	// Authenticate performs the authentication handshake on a connected client.
	// It blocks until authentication succeeds, fails, or the context is cancelled.
	Authenticate(ctx context.Context, client *Client) error
}

// ReconnectingClient wraps a signaling Client with automatic reconnection
// using exponential backoff. It re-authenticates on each new connection
// and provides the same Send/OnMessage interface as the base Client.
//
// Thread-safe for concurrent use.
type ReconnectingClient struct {
	url           string
	tlsConfig     *tls.Config
	authenticator Authenticator

	initialBackoff time.Duration
	maxBackoff     time.Duration

	client   *Client
	clientMu sync.RWMutex

	handlers   []func(msg Message)
	handlersMu sync.RWMutex

	disconnectHandlers []func()
	reconnectHandlers  []func()
	callbackMu         sync.RWMutex

	connected bool
	stateMu   sync.RWMutex

	cancel context.CancelFunc
	done   chan struct{}
	closed bool
	mu     sync.Mutex // protects closed
}

// NewReconnectingClient creates a new ReconnectingClient that will connect to the
// given URL, use the provided TLS configuration, and authenticate using the
// provided Authenticator on each connection/reconnection.
func NewReconnectingClient(url string, tlsConfig *tls.Config, authenticator Authenticator) *ReconnectingClient {
	return &ReconnectingClient{
		url:            url,
		tlsConfig:      tlsConfig,
		authenticator:  authenticator,
		initialBackoff: DefaultInitialBackoff,
		maxBackoff:     DefaultMaxBackoff,
		done:           make(chan struct{}),
	}
}

// Start establishes the initial connection (with authentication) and then
// Start begins the connection process in the background and returns immediately.
// It retries with exponential backoff until successful or the context is cancelled.
// Once connected, it monitors for disconnection and reconnects automatically.
//
// Callers should register message handlers and callbacks before calling Start
// to ensure no messages are missed on initial connection.
func (rc *ReconnectingClient) Start(ctx context.Context) error {
	rc.mu.Lock()
	if rc.closed {
		rc.mu.Unlock()
		return errors.New("reconnecting client is closed")
	}
	rc.mu.Unlock()

	// Create a cancellable context for the connection/reconnection loop.
	loopCtx, cancel := context.WithCancel(ctx)
	rc.cancel = cancel

	log.Printf("[signaling] starting connection to %s (background)", rc.url)

	// Run the initial connection and monitor loop in the background.
	go rc.connectAndMonitor(loopCtx)

	return nil
}

// connectAndMonitor performs the initial connection with retry, then monitors
// for disconnection. Runs as a background goroutine started by Start().
func (rc *ReconnectingClient) connectAndMonitor(ctx context.Context) {
	defer close(rc.done)

	log.Println("[signaling] connect-and-monitor goroutine started")

	// Initial connection with retry and backoff.
	failures := 0
	for {
		if ctx.Err() != nil {
			return
		}

		if err := rc.connect(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			failures++
			backoff := CalculateBackoff(failures, rc.initialBackoff, rc.maxBackoff)
			log.Printf("[signaling] connection failed (%v), retrying in %v", err, backoff)

			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
				continue
			}
		}
		// Connected — fire reconnect handlers on initial connect too
		// so that number/status reports are sent.
		rc.fireReconnectHandlers()
		break
	}

	// Monitor loop: watch for disconnection and reconnect.
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Wait for disconnection.
		rc.waitForDisconnect(ctx)

		if ctx.Err() != nil {
			return
		}

		// Mark as disconnected and notify.
		rc.setConnected(false)
		log.Println("[signaling] disconnected from Svarla server")
		rc.fireDisconnectHandlers()

		// Close the old client.
		rc.clientMu.Lock()
		if rc.client != nil {
			_ = rc.client.Close()
			rc.client = nil
		}
		rc.clientMu.Unlock()

		// Reconnect with exponential backoff.
		rc.reconnectLoop(ctx)
	}
}

// Send queues a message for sending over the WebSocket. Returns an error
// if the client is not currently connected (non-blocking).
func (rc *ReconnectingClient) Send(msg Message) error {
	rc.clientMu.RLock()
	c := rc.client
	rc.clientMu.RUnlock()

	if c == nil || !rc.IsConnected() {
		return errors.New("not connected")
	}

	return c.Send(msg)
}

// OnMessage registers a handler that will be called for every incoming message.
// Handlers are preserved across reconnections — they are re-registered on each
// new underlying client.
func (rc *ReconnectingClient) OnMessage(handler func(msg Message)) {
	rc.handlersMu.Lock()
	rc.handlers = append(rc.handlers, handler)
	rc.handlersMu.Unlock()

	// Also register on the current client if connected.
	rc.clientMu.RLock()
	c := rc.client
	rc.clientMu.RUnlock()

	if c != nil {
		c.OnMessage(handler)
	}
}

// OnDisconnect registers a callback that fires when the connection is lost.
func (rc *ReconnectingClient) OnDisconnect(handler func()) {
	rc.callbackMu.Lock()
	defer rc.callbackMu.Unlock()
	rc.disconnectHandlers = append(rc.disconnectHandlers, handler)
}

// OnReconnect registers a callback that fires when reconnection succeeds.
func (rc *ReconnectingClient) OnReconnect(handler func()) {
	rc.callbackMu.Lock()
	defer rc.callbackMu.Unlock()
	rc.reconnectHandlers = append(rc.reconnectHandlers, handler)
}

// IsConnected returns whether the client currently has an active,
// authenticated WebSocket connection.
func (rc *ReconnectingClient) IsConnected() bool {
	rc.stateMu.RLock()
	defer rc.stateMu.RUnlock()
	return rc.connected
}

// Close stops the reconnection loop and closes the underlying client.
func (rc *ReconnectingClient) Close() error {
	rc.mu.Lock()
	if rc.closed {
		rc.mu.Unlock()
		return nil
	}
	rc.closed = true
	rc.mu.Unlock()

	if rc.cancel != nil {
		rc.cancel()
	}

	// Wait for the monitor loop to exit.
	<-rc.done

	rc.clientMu.Lock()
	c := rc.client
	rc.client = nil
	rc.clientMu.Unlock()

	rc.setConnected(false)

	if c != nil {
		return c.Close()
	}
	return nil
}

// CalculateBackoff returns min(initial * 2^failures, maxBackoff).
// For failures <= 0, it returns the initial duration.
func CalculateBackoff(failures int, initial, maxBackoff time.Duration) time.Duration {
	if failures <= 0 {
		return initial
	}

	// Calculate 2^failures using floating point to avoid integer overflow.
	multiplier := math.Pow(2, float64(failures))
	backoff := time.Duration(float64(initial) * multiplier)

	if backoff > maxBackoff || backoff <= 0 {
		// backoff <= 0 handles overflow edge cases.
		return maxBackoff
	}

	return backoff
}

// connect creates a new Client, connects, and authenticates.
func (rc *ReconnectingClient) connect(ctx context.Context) error {
	log.Printf("[signaling] connecting to %s", rc.url)

	client := NewClient(rc.url, rc.tlsConfig)

	if err := client.Connect(ctx); err != nil {
		return err
	}

	// Register all message handlers on the new client.
	rc.handlersMu.RLock()
	for _, h := range rc.handlers {
		client.OnMessage(h)
	}
	rc.handlersMu.RUnlock()

	// Authenticate the new connection. The authenticator registers its own
	// handler before we start reading, so no server messages are lost.
	if rc.authenticator != nil {
		if err := rc.authenticator.Authenticate(ctx, client); err != nil {
			_ = client.Close()
			return err
		}
	} else {
		// No authenticator — start reading immediately.
		client.StartReading()
	}

	// Store the new client.
	rc.clientMu.Lock()
	rc.client = client
	rc.clientMu.Unlock()

	rc.setConnected(true)
	log.Println("[signaling] connected to Svarla server")

	return nil
}

// waitForDisconnect blocks until the underlying client reports disconnected
// or the context is cancelled.
func (rc *ReconnectingClient) waitForDisconnect(ctx context.Context) {
	ticker := time.NewTicker(connectionCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			rc.clientMu.RLock()
			c := rc.client
			rc.clientMu.RUnlock()

			if c == nil || !c.IsConnected() {
				return
			}
		}
	}
}

// reconnectLoop attempts to reconnect with exponential backoff until
// successful or context cancelled.
func (rc *ReconnectingClient) reconnectLoop(ctx context.Context) {
	failures := 0

	for {
		if ctx.Err() != nil {
			return
		}

		backoff := CalculateBackoff(failures, rc.initialBackoff, rc.maxBackoff)

		// Wait for the backoff duration.
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}

		// Attempt to connect and authenticate.
		if err := rc.connect(ctx); err != nil {
			failures++
			log.Printf("[signaling] reconnection failed (%v), retrying in %v", err, CalculateBackoff(failures, rc.initialBackoff, rc.maxBackoff))
			continue
		}

		// Success — reset backoff and notify.
		log.Println("[signaling] reconnected to Svarla server")
		rc.fireReconnectHandlers()
		return
	}
}

func (rc *ReconnectingClient) setConnected(state bool) {
	rc.stateMu.Lock()
	defer rc.stateMu.Unlock()
	rc.connected = state
}

func (rc *ReconnectingClient) fireDisconnectHandlers() {
	rc.callbackMu.RLock()
	handlers := make([]func(), len(rc.disconnectHandlers))
	copy(handlers, rc.disconnectHandlers)
	rc.callbackMu.RUnlock()

	for _, h := range handlers {
		h()
	}
}

func (rc *ReconnectingClient) fireReconnectHandlers() {
	rc.callbackMu.RLock()
	handlers := make([]func(), len(rc.reconnectHandlers))
	copy(handlers, rc.reconnectHandlers)
	rc.callbackMu.RUnlock()

	for _, h := range handlers {
		h()
	}
}
