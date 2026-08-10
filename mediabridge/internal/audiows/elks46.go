package audiows

import (
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"mediabridge/internal/events"
	"mediabridge/internal/session"

	"github.com/gorilla/websocket"
)

// Elks46Handler handles 46elks Realtime Voice API WebSocket connections.
// It translates between 46elks JSON/base64 protocol and raw PCM audio,
// bridging to the session's audio pipeline.
type Elks46Handler struct {
	store       *session.Store
	eventClient *events.Server
	logger      *slog.Logger
	upgrader    websocket.Upgrader

	mu    sync.Mutex
	conns map[string]*websocket.Conn // sessionID → conn

	// Write channels: serializes all writes to avoid gorilla/websocket concurrent write issues.
	writeChs map[string]chan []byte // sessionID → write channel

	// Audio callback: invoked with sessionID and raw PCM 16-bit 16kHz data.
	onAudioFunc func(sessionID string, pcmData []byte)

	// Connect callback: invoked when a 46elks provider connects and is matched to a session.
	onConnectFunc func(sessionID string)
}

// NewElks46Handler creates a handler for 46elks Realtime Voice API WebSocket connections.
func NewElks46Handler(store *session.Store, eventClient *events.Server, logger *slog.Logger) *Elks46Handler {
	return &Elks46Handler{
		store:       store,
		eventClient: eventClient,
		logger:      logger,
		conns:       make(map[string]*websocket.Conn),
		writeChs:    make(map[string]chan []byte),
		upgrader: websocket.Upgrader{
			CheckOrigin:    func(r *http.Request) bool { return true },
			ReadBufferSize: maxMessageSize,
			WriteBufferSize: maxMessageSize,
		},
	}
}

// SetOnAudio registers a callback for incoming audio data.
func (h *Elks46Handler) SetOnAudio(fn func(sessionID string, pcmData []byte)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.onAudioFunc = fn
}

// SetOnConnect registers a callback for when a provider connects.
func (h *Elks46Handler) SetOnConnect(fn func(sessionID string)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.onConnectFunc = fn
}

// SendAudioFrame sends PCM audio to the 46elks provider for the given session.
func (h *Elks46Handler) SendAudioFrame(sessionID string, pcmData []byte) error {
	h.mu.Lock()
	ch, ok := h.writeChs[sessionID]
	h.mu.Unlock()

	if !ok || ch == nil {
		return nil
	}

	msg := elks46AudioMsg{
		T:    "audio",
		Data: base64.StdEncoding.EncodeToString(pcmData),
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	// Non-blocking send: drop frame if write channel is full (prevents latency buildup).
	select {
	case ch <- payload:
	default:
		// Channel full — drop this frame to prevent latency accumulation.
	}
	return nil
}

// CloseConnection sends a bye message to 46elks and closes the WebSocket for the session.
func (h *Elks46Handler) CloseConnection(sessionID string) {
	h.mu.Lock()
	conn, ok := h.conns[sessionID]
	ch := h.writeChs[sessionID]
	h.mu.Unlock()

	if !ok || conn == nil {
		return
	}

	// Send bye via the write channel if available.
	if ch != nil {
		byeMsg, _ := json.Marshal(elks46BaseMsg{T: "bye"})
		select {
		case ch <- byeMsg:
		default:
		}
		// Close the channel to signal the write goroutine to exit.
		h.mu.Lock()
		delete(h.writeChs, sessionID)
		h.mu.Unlock()
		close(ch)
	} else {
		h.sendJSON(conn, elks46BaseMsg{T: "bye"})
		_ = conn.Close()
	}
}

// IsConnected returns whether a 46elks provider is connected for the session.
func (h *Elks46Handler) IsConnected(sessionID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.conns[sessionID]
	return ok
}

// ServeHTTP handles the WebSocket upgrade at /audio/46elks.
func (h *Elks46Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.logger.Error("46elks audio ws upgrade failed", slog.String("error", err.Error()))
		return
	}

	h.logger.Info("46elks audio ws connection received", slog.String("remote", r.RemoteAddr))

	// Read the hello message to identify the call.
	conn.SetReadLimit(maxMessageSize)
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))

	_, msgData, err := conn.ReadMessage()
	if err != nil {
		h.logger.Error("46elks audio ws: failed to read hello", slog.String("error", err.Error()))
		_ = conn.Close()
		return
	}

	var hello elks46HelloMsg
	if err := json.Unmarshal(msgData, &hello); err != nil || hello.T != "hello" || hello.CallID == "" {
		h.logger.Error("46elks audio ws: invalid hello message",
			slog.String("raw", string(msgData)),
		)
		_ = conn.Close()
		return
	}

	// Find the session expecting this callId.
	sessionID := h.findSessionByCallId(hello.CallID)
	if sessionID == "" {
		h.logger.Error("46elks audio ws: no session for callid",
			slog.String("callid", hello.CallID),
		)
		_ = conn.Close()
		return
	}

	h.logger.Info("46elks audio ws matched to session",
		slog.String("sessionId", sessionID),
		slog.String("callid", hello.CallID),
		slog.String("from", hello.From),
		slog.String("to", hello.To),
	)

	// Track connection.
	h.mu.Lock()
	h.conns[sessionID] = conn
	h.mu.Unlock()

	// Send format declarations.
	h.sendJSON(conn, elks46FormatMsg{T: "listening", Format: "pcm_16000"})
	h.sendJSON(conn, elks46FormatMsg{T: "sending", Format: "pcm_16000"})

	// Emit provider_connected event.
	h.eventClient.EmitSessionEvent(sessionID, "provider_connected", "")

	// Notify connect callback.
	h.mu.Lock()
	onConnect := h.onConnectFunc
	h.mu.Unlock()
	if onConnect != nil {
		onConnect(sessionID)
	}

	// Serve the connection (read/write loops).
	h.serveElks46Connection(sessionID, conn)
}

func (h *Elks46Handler) serveElks46Connection(sessionID string, conn *websocket.Conn) {
	// Create write channel for this session (buffer ~200ms of frames to absorb jitter).
	writeCh := make(chan []byte, 10)
	h.mu.Lock()
	h.writeChs[sessionID] = writeCh
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.conns, sessionID)
		delete(h.writeChs, sessionID)
		h.mu.Unlock()
		_ = conn.Close()

		h.logger.Info("46elks audio ws disconnected", slog.String("sessionId", sessionID))
		h.eventClient.EmitSessionEvent(sessionID, "provider_disconnected", "ws_closed")
	}()

	// Reset read deadline for normal operation.
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	// Write goroutine: drains the write channel and sends to WebSocket.
	// Also handles periodic pings. All writes go through this single goroutine.
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()
		for {
			select {
			case payload, ok := <-writeCh:
				if !ok {
					// Channel closed — send close frame and exit.
					_ = conn.WriteControl(
						websocket.CloseMessage,
						websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
						time.Now().Add(writeWait),
					)
					return
				}
				_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
				if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
					return
				}
			case <-ticker.C:
				_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					return
				}
			case <-done:
				return
			}
		}
	}()

	// Read loop: receive messages from 46elks.
	for {
		_, msgData, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err,
				websocket.CloseNormalClosure,
				websocket.CloseGoingAway,
			) {
				h.logger.Warn("46elks audio ws read error",
					slog.String("sessionId", sessionID),
					slog.String("error", err.Error()),
				)
			}
			close(done)
			return
		}

		h.handleElks46Message(sessionID, msgData)
	}
}

func (h *Elks46Handler) handleElks46Message(sessionID string, data []byte) {
	var msg elks46BaseMsg
	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}

	switch msg.T {
	case "audio":
		var audioMsg elks46AudioMsg
		if err := json.Unmarshal(data, &audioMsg); err != nil || audioMsg.Data == "" {
			return
		}
		pcmData, err := base64.StdEncoding.DecodeString(audioMsg.Data)
		if err != nil {
			return
		}

		h.mu.Lock()
		onAudio := h.onAudioFunc
		h.mu.Unlock()
		if onAudio != nil {
			onAudio(sessionID, pcmData)
		}

	case "bye":
		h.logger.Info("46elks sent bye", slog.String("sessionId", sessionID))
		// Connection will be closed by the deferred cleanup.
		h.mu.Lock()
		conn, ok := h.conns[sessionID]
		h.mu.Unlock()
		if ok && conn != nil {
			_ = conn.Close()
		}

	case "sync":
		// Buffer checkpoint — no action needed.
	}
}

// findSessionByCallId searches all sessions for one with expectedCallId matching.
func (h *Elks46Handler) findSessionByCallId(callId string) string {
	return h.store.FindByExpectedCallId(callId)
}

func (h *Elks46Handler) sendJSON(conn *websocket.Conn, v interface{}) {
	payload, err := json.Marshal(v)
	if err != nil {
		return
	}
	_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
	_ = conn.WriteMessage(websocket.TextMessage, payload)
}

// ─── 46elks Message Types ───────────────────────────────────────────────────

type elks46BaseMsg struct {
	T string `json:"t"`
}

type elks46HelloMsg struct {
	T      string `json:"t"`
	CallID string `json:"callid"`
	From   string `json:"from"`
	To     string `json:"to"`
}

type elks46AudioMsg struct {
	T    string `json:"t"`
	Data string `json:"data"`
}

type elks46FormatMsg struct {
	T      string `json:"t"`
	Format string `json:"format"`
}
