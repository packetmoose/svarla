package signaling

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// sendQueueSize is the capacity of the outbound message channel.
	sendQueueSize = 64

	// writeWait is the time allowed to write a message to the peer.
	writeWait = 10 * time.Second

	// pongWait is the maximum time to wait for a pong after sending a ping.
	// The server sends pings every 30s and expects pong within 60s per requirement 3.5.
	// We set this to 90s to be generous (we respond to server pings, not initiate them).
	pongWait = 90 * time.Second
)

// Client is a persistent WebSocket client for the Svarla signaling protocol.
// It maintains a connection, handles ping/pong, dispatches incoming messages
// by type, and provides a non-blocking send queue for outbound messages.
type Client struct {
	url       string
	tlsConfig *tls.Config

	conn   *websocket.Conn
	connMu sync.Mutex

	sendCh chan Message

	handlers   []func(msg Message)
	handlersMu sync.RWMutex

	connected bool
	stateMu   sync.RWMutex

	done   chan struct{}
	wg     sync.WaitGroup
	closed bool
}

// NewClient creates a new signaling WebSocket client targeting the given URL.
// The tlsConfig may be nil to use default system TLS settings.
func NewClient(url string, tlsConfig *tls.Config) *Client {
	return &Client{
		url:       url,
		tlsConfig: tlsConfig,
		sendCh:    make(chan Message, sendQueueSize),
		done:      make(chan struct{}),
	}
}

// Connect establishes the WebSocket connection to the Svarla server.
// It starts background read and write goroutines. The context controls
// the dial timeout; once connected, the connection persists until Close is called.
func (c *Client) Connect(ctx context.Context) error {
	c.connMu.Lock()
	defer c.connMu.Unlock()

	if c.closed {
		return errors.New("client is closed")
	}

	dialer := websocket.Dialer{
		TLSClientConfig:  c.tlsConfig,
		HandshakeTimeout: 30 * time.Second,
	}

	conn, _, err := dialer.DialContext(ctx, c.url, http.Header{})
	if err != nil {
		return fmt.Errorf("websocket dial failed: %w", err)
	}

	c.conn = conn

	// Set up pong handler to extend read deadline on any pong received.
	c.conn.SetPongHandler(func(appData string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	// Also handle ping from server (gorilla/websocket handles pong responses
	// automatically by default, but we set a custom handler to extend deadline).
	c.conn.SetPingHandler(func(appData string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
		// Write pong response.
		c.connMu.Lock()
		err := c.conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(writeWait))
		c.connMu.Unlock()
		return err
	})

	c.setConnected(true)

	// Start background goroutines.
	c.wg.Add(2)
	go c.readLoop()
	go c.writeLoop()

	return nil
}

// Send queues a message for sending over the WebSocket. It is non-blocking;
// if the send queue is full, it returns an error.
func (c *Client) Send(msg Message) error {
	if !c.IsConnected() {
		return errors.New("not connected")
	}

	select {
	case c.sendCh <- msg:
		return nil
	default:
		return errors.New("send queue full")
	}
}

// OnMessage registers a handler that will be called for every incoming message.
// Multiple handlers can be registered; they are called in registration order.
func (c *Client) OnMessage(handler func(msg Message)) {
	c.handlersMu.Lock()
	defer c.handlersMu.Unlock()
	c.handlers = append(c.handlers, handler)
}

// Close gracefully closes the WebSocket connection and stops background goroutines.
func (c *Client) Close() error {
	c.connMu.Lock()
	if c.closed {
		c.connMu.Unlock()
		return nil
	}
	c.closed = true
	close(c.done)
	c.connMu.Unlock()

	c.setConnected(false)

	// Send a close frame to the server.
	c.connMu.Lock()
	if c.conn != nil {
		_ = c.conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
			time.Now().Add(writeWait),
		)
		err := c.conn.Close()
		c.connMu.Unlock()
		c.wg.Wait()
		return err
	}
	c.connMu.Unlock()
	c.wg.Wait()
	return nil
}

// IsConnected returns whether the client currently has an active WebSocket connection.
func (c *Client) IsConnected() bool {
	c.stateMu.RLock()
	defer c.stateMu.RUnlock()
	return c.connected
}

func (c *Client) setConnected(state bool) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	c.connected = state
}

// readLoop reads messages from the WebSocket and dispatches them to handlers.
func (c *Client) readLoop() {
	defer c.wg.Done()
	defer c.handleDisconnect()

	// Set initial read deadline.
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))

	for {
		select {
		case <-c.done:
			return
		default:
		}

		_, data, err := c.conn.ReadMessage()
		if err != nil {
			// Connection closed or error; exit loop.
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				// Abnormal close - could log here.
			}
			return
		}

		// Reset read deadline on any message received.
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))

		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			// Per requirement 3.6: ignore invalid JSON messages, continue.
			continue
		}

		if msg.Type == "" {
			// Ignore messages without a type field (requirement 3.6).
			continue
		}

		c.dispatchMessage(msg)
	}
}

// writeLoop reads from the send channel and writes messages to the WebSocket.
func (c *Client) writeLoop() {
	defer c.wg.Done()

	for {
		select {
		case <-c.done:
			return
		case msg := <-c.sendCh:
			data, err := json.Marshal(msg)
			if err != nil {
				// Skip messages that can't be serialized.
				continue
			}

			c.connMu.Lock()
			if c.conn == nil {
				c.connMu.Unlock()
				return
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			err = c.conn.WriteMessage(websocket.TextMessage, data)
			c.connMu.Unlock()

			if err != nil {
				// Write failed; connection likely dead.
				return
			}
		}
	}
}

// dispatchMessage calls all registered handlers with the given message.
func (c *Client) dispatchMessage(msg Message) {
	c.handlersMu.RLock()
	handlers := make([]func(msg Message), len(c.handlers))
	copy(handlers, c.handlers)
	c.handlersMu.RUnlock()

	for _, h := range handlers {
		h(msg)
	}
}

// handleDisconnect updates connection state when the read loop exits.
func (c *Client) handleDisconnect() {
	c.setConnected(false)
}
