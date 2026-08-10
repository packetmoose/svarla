// Package events provides a WebSocket server endpoint on the ControlAPI that
// accepts a connection from the Server and pushes session/health events from
// the MediaBridge. The Server (svarla) connects as a WebSocket client.
package events

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// DefaultBufferSize is the maximum number of events buffered when no client is connected.
	DefaultBufferSize = 256

	// DefaultHealthInterval is the interval between periodic health events.
	DefaultHealthInterval = 30 * time.Second

	// writeTimeout is the max time allowed for writing a single message.
	writeTimeout = 5 * time.Second
)

// Event represents a JSON message sent to the Server.
type Event struct {
	Type string `json:"type"`

	// Session event fields (type == "session_event")
	SessionID string `json:"sessionId,omitempty"`
	EventName string `json:"event,omitempty"`
	Reason    string `json:"reason,omitempty"`
	Digit     string `json:"digit,omitempty"`

	// Health event fields (type == "health")
	ActiveSessions *int `json:"activeSessions,omitempty"`
	Uptime         *int `json:"uptime,omitempty"`
}

// HealthProvider is a function that returns current health metrics.
type HealthProvider func() (activeSessions int, uptime int)

// ServerConfig holds configuration for the WebSocket event server.
type ServerConfig struct {
	BufferSize     int           // Max events in buffer (0 = DefaultBufferSize)
	HealthInterval time.Duration // Interval for periodic health events (0 = DefaultHealthInterval)
}

// Server is a WebSocket event endpoint that accepts a single client connection
// (the svarla server) and pushes events to it. It is thread-safe.
type Server struct {
	cfg    ServerConfig
	logger *slog.Logger
	health HealthProvider

	mu   sync.Mutex
	conn *websocket.Conn

	buffer   chan Event
	done     chan struct{}
	wg       sync.WaitGroup
	shutdown sync.Once

	upgrader websocket.Upgrader
}

// NewServer creates a new event WebSocket server.
func NewServer(cfg ServerConfig, healthProvider HealthProvider, logger *slog.Logger) *Server {
	if cfg.BufferSize <= 0 {
		cfg.BufferSize = DefaultBufferSize
	}
	if cfg.HealthInterval <= 0 {
		cfg.HealthInterval = DefaultHealthInterval
	}

	return &Server{
		cfg:    cfg,
		logger: logger,
		health: healthProvider,
		buffer: make(chan Event, cfg.BufferSize),
		done:   make(chan struct{}),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				// Internal endpoint — allow all origins.
				return true
			},
		},
	}
}

// Start begins the health emitter in a background goroutine.
// Call Shutdown to stop gracefully.
func (s *Server) Start() {
	s.wg.Add(1)
	go s.healthLoop()
}

// Shutdown stops background goroutines and closes any active connection.
func (s *Server) Shutdown() {
	s.shutdown.Do(func() {
		close(s.done)
	})
	s.wg.Wait()

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != nil {
		_ = s.conn.WriteMessage(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, "shutdown"),
		)
		_ = s.conn.Close()
		s.conn = nil
	}
}

// ServeHTTP implements http.Handler and upgrades the connection to WebSocket.
// Only one client at a time is supported; a new connection replaces the old one.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Warn("event websocket upgrade failed", slog.String("error", err.Error()))
		return
	}

	s.mu.Lock()
	old := s.conn
	s.conn = conn
	s.mu.Unlock()

	if old != nil {
		s.logger.Info("event websocket: new client connected, closing previous connection")
		_ = old.WriteMessage(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, "replaced"),
		)
		_ = old.Close()
	}

	s.logger.Info("event websocket: server connected")

	// Start a writer goroutine to drain the buffer to this connection.
	s.wg.Add(1)
	go s.writeLoop(conn)

	// Read loop: detect client disconnect.
	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			break
		}
	}

	s.mu.Lock()
	if s.conn == conn {
		s.conn = nil
	}
	s.mu.Unlock()

	s.logger.Info("event websocket: server disconnected")
}

// Emit enqueues an event for sending to the connected client.
// Thread-safe: may be called from multiple goroutines concurrently.
// If the buffer is full, the oldest event is dropped.
func (s *Server) Emit(evt Event) {
	select {
	case s.buffer <- evt:
	default:
		// Buffer full — drop oldest, then enqueue new event.
		select {
		case <-s.buffer:
		default:
		}
		select {
		case s.buffer <- evt:
		default:
		}
	}
}

// EmitSessionEvent is a convenience method for session events.
func (s *Server) EmitSessionEvent(sessionID, event, reason string) {
	evt := Event{
		Type:      "session_event",
		SessionID: sessionID,
		EventName: event,
		Reason:    reason,
	}
	s.Emit(evt)
}

// EmitDTMF emits a DTMF event for a session.
func (s *Server) EmitDTMF(sessionID, digit string) {
	evt := Event{
		Type:      "session_event",
		SessionID: sessionID,
		EventName: "dtmf",
		Digit:     digit,
	}
	s.Emit(evt)
}

// writeLoop drains the buffer and writes events to the given connection.
// Returns when the connection is replaced, closed, or shutdown is signaled.
func (s *Server) writeLoop(conn *websocket.Conn) {
	defer s.wg.Done()

	for {
		select {
		case <-s.done:
			return
		case evt := <-s.buffer:
			// Check if this connection is still the active one.
			s.mu.Lock()
			current := s.conn
			s.mu.Unlock()
			if current != conn {
				// Connection was replaced; re-buffer the event and exit.
				select {
				case s.buffer <- evt:
				default:
				}
				return
			}

			if err := s.writeEvent(conn, evt); err != nil {
				s.logger.Warn("event websocket write failed",
					slog.String("error", err.Error()),
				)
				// Re-buffer the event if possible.
				select {
				case s.buffer <- evt:
				default:
				}
				return
			}
		}
	}
}

// writeEvent serializes and sends a single event on the connection.
func (s *Server) writeEvent(conn *websocket.Conn, evt Event) error {
	data, err := json.Marshal(evt)
	if err != nil {
		return err
	}

	_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	return conn.WriteMessage(websocket.TextMessage, data)
}

// healthLoop periodically emits health events.
func (s *Server) healthLoop() {
	defer s.wg.Done()

	ticker := time.NewTicker(s.cfg.HealthInterval)
	defer ticker.Stop()

	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			activeSessions, uptime := s.health()
			evt := Event{
				Type:           "health",
				ActiveSessions: &activeSessions,
				Uptime:         &uptime,
			}
			s.Emit(evt)
		}
	}
}

// IsConnected reports whether a client is currently connected.
func (s *Server) IsConnected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn != nil
}
