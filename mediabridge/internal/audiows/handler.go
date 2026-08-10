// Package audiows implements a WebSocket audio stream endpoint for the MediaBridge.
// It allows telephony providers (e.g., Raspberry Pi + modem) to stream raw PCM or
// Opus audio over a standard WebSocket connection, providing an alternative to SIP.
package audiows

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"mediabridge/internal/events"
	"mediabridge/internal/session"

	"github.com/gorilla/websocket"
)

const (
	// readHeaderTimeout for the HTTP server.
	readHeaderTimeout = 10 * time.Second

	// pongWait is the max time we wait for a pong response.
	pongWait = 60 * time.Second

	// pingInterval is how often we send pings. Must be less than pongWait.
	pingInterval = 30 * time.Second

	// writeWait is the max time allowed for writing a message.
	writeWait = 10 * time.Second

	// maxMessageSize is the max size of a single WebSocket message (64KB PCM frames).
	maxMessageSize = 64 * 1024
)

// Config holds configuration for the audio WebSocket server.
type Config struct {
	Port  int    // TCP port to listen on (default 9091)
	Token string // Bearer token for auth; empty means no auth required
}

// Handler manages the audio WebSocket endpoint.
type Handler struct {
	config      Config
	store       *session.Store
	eventClient *events.Server
	logger      *slog.Logger

	upgrader websocket.Upgrader
	server   *http.Server

	// Track active connections for graceful shutdown.
	mu    sync.Mutex
	conns map[string]*websocket.Conn // sessionID → conn

	// Audio callback: invoked with sessionID and raw PCM data when audio arrives from provider.
	onAudioFunc func(sessionID string, pcmData []byte)

	// Connect callback: invoked when an audio WS provider connects.
	onConnectFunc func(sessionID string)
}

// NewHandler creates a new audio WebSocket handler.
func NewHandler(cfg Config, store *session.Store, eventClient *events.Server, logger *slog.Logger) *Handler {
	h := &Handler{
		config:      cfg,
		store:       store,
		eventClient: eventClient,
		logger:      logger,
		conns:       make(map[string]*websocket.Conn),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
			ReadBufferSize:  maxMessageSize,
			WriteBufferSize: maxMessageSize,
		},
	}
	return h
}

// ListenAndServe starts the HTTP server for audio WebSocket connections.
// It blocks until the server is stopped or an error occurs.
func (h *Handler) ListenAndServe() error {
	return h.ListenAndServeWithMux(nil)
}

// ListenAndServeWithMux starts the HTTP server with an optional custom mux.
// If mux is nil, a default mux with /audio/ is created.
// Pass a pre-configured mux to add additional routes (e.g. provider-specific endpoints).
func (h *Handler) ListenAndServeWithMux(mux *http.ServeMux) error {
	if mux == nil {
		mux = http.NewServeMux()
	}
	mux.HandleFunc("/audio/", h.handleAudioWS)

	addr := fmt.Sprintf(":%d", h.config.Port)
	h.server = &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: readHeaderTimeout,
		BaseContext: func(_ net.Listener) context.Context {
			return context.Background()
		},
	}

	h.logger.Info("audio websocket server listening",
		slog.String("addr", addr),
	)

	if err := h.server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("audio ws server: %w", err)
	}
	return nil
}

// Shutdown gracefully shuts down the audio WebSocket server,
// closing all active connections.
func (h *Handler) Shutdown(ctx context.Context) error {
	// Close all active WebSocket connections.
	h.mu.Lock()
	for sessionID, conn := range h.conns {
		h.logger.Info("closing audio ws connection on shutdown",
			slog.String("sessionId", sessionID),
		)
		_ = conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseGoingAway, "server shutting down"),
			time.Now().Add(writeWait),
		)
		_ = conn.Close()
	}
	h.conns = make(map[string]*websocket.Conn)
	h.mu.Unlock()

	if h.server != nil {
		return h.server.Shutdown(ctx)
	}
	return nil
}

// handleAudioWS handles WebSocket upgrade requests at /audio/{sessionId}.
func (h *Handler) handleAudioWS(w http.ResponseWriter, r *http.Request) {
	// Extract session ID from path: /audio/{sessionId}
	sessionID := extractSessionID(r.URL.Path)
	if sessionID == "" {
		http.Error(w, "missing session ID in path", http.StatusBadRequest)
		return
	}

	// Authenticate the request.
	if !h.authenticate(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	// Look up session.
	sess := h.store.Get(sessionID)
	if sess == nil {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	// Upgrade to WebSocket.
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.logger.Error("audio ws upgrade failed",
			slog.String("sessionId", sessionID),
			slog.String("error", err.Error()),
		)
		return
	}

	h.logger.Info("audio ws provider connected",
		slog.String("sessionId", sessionID),
	)

	// Track the connection.
	h.mu.Lock()
	h.conns[sessionID] = conn
	h.mu.Unlock()

	// Emit provider_connected event.
	h.eventClient.EmitSessionEvent(sessionID, "provider_connected", "")

	// Notify connect callback.
	h.mu.Lock()
	onConnect := h.onConnectFunc
	h.mu.Unlock()
	if onConnect != nil {
		onConnect(sessionID)
	}

	// Configure connection.
	conn.SetReadLimit(maxMessageSize)
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	// Start the read/write loops.
	h.serveConnection(sessionID, conn)
}

// serveConnection handles the bidirectional audio stream for a connected provider.
func (h *Handler) serveConnection(sessionID string, conn *websocket.Conn) {
	defer func() {
		h.mu.Lock()
		delete(h.conns, sessionID)
		h.mu.Unlock()
		_ = conn.Close()

		h.logger.Info("audio ws provider disconnected",
			slog.String("sessionId", sessionID),
		)

		// Emit provider_disconnected event.
		h.eventClient.EmitSessionEvent(sessionID, "provider_disconnected", "ws_closed")
	}()

	// Start ping ticker to keep connection alive.
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	// Read loop: receive audio frames from provider.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			msgType, data, err := conn.ReadMessage()
			if err != nil {
				if websocket.IsUnexpectedCloseError(err,
					websocket.CloseNormalClosure,
					websocket.CloseGoingAway,
				) {
					h.logger.Warn("audio ws read error",
						slog.String("sessionId", sessionID),
						slog.String("error", err.Error()),
					)
				}
				return
			}
			// Binary messages are PCM 16-bit 16kHz audio frames.
			// Text messages are not expected but tolerated (ignored).
			if msgType == websocket.BinaryMessage && len(data) > 0 {
				h.mu.Lock()
				onAudio := h.onAudioFunc
				h.mu.Unlock()
				if onAudio != nil {
					onAudio(sessionID, data)
				}
			}
		}
	}()

	// Ping loop to detect dead connections.
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// authenticate checks the Bearer token from the WebSocket upgrade request.
// If no token is configured, all connections are allowed.
func (h *Handler) authenticate(r *http.Request) bool {
	if h.config.Token == "" {
		return true // No auth required
	}

	// Check Authorization header first.
	authHeader := r.Header.Get("Authorization")
	if authHeader != "" {
		const prefix = "Bearer "
		if strings.HasPrefix(authHeader, prefix) {
			token := strings.TrimPrefix(authHeader, prefix)
			return token == h.config.Token
		}
		return false
	}

	// Fallback: check ?token= query parameter.
	queryToken := r.URL.Query().Get("token")
	return queryToken == h.config.Token
}

// extractSessionID extracts the session ID from a path like /audio/{sessionId}.
func extractSessionID(path string) string {
	// Remove trailing slash if present.
	path = strings.TrimSuffix(path, "/")

	// Expected format: /audio/{sessionId}
	const prefix = "/audio/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}

	sessionID := strings.TrimPrefix(path, prefix)
	// Session ID should not contain slashes.
	if strings.Contains(sessionID, "/") {
		return ""
	}

	return sessionID
}

// SendAudioFrame sends a binary audio frame to the connected provider for the given session.
// Returns an error if no provider is connected for the session.
func (h *Handler) SendAudioFrame(sessionID string, data []byte) error {
	h.mu.Lock()
	conn, ok := h.conns[sessionID]
	h.mu.Unlock()

	if !ok || conn == nil {
		return fmt.Errorf("no audio ws connection for session %s", sessionID)
	}

	_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
	return conn.WriteMessage(websocket.BinaryMessage, data)
}

// IsConnected returns whether a provider is connected via audio WS for the given session.
func (h *Handler) IsConnected(sessionID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.conns[sessionID]
	return ok
}

// SetOnAudio registers a callback invoked when audio data arrives from a provider.
// The callback receives the sessionID and raw PCM 16-bit 16kHz audio bytes.
func (h *Handler) SetOnAudio(fn func(sessionID string, pcmData []byte)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.onAudioFunc = fn
}

// SetOnConnect registers a callback invoked when a provider connects via audio WS.
func (h *Handler) SetOnConnect(fn func(sessionID string)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.onConnectFunc = fn
}
