// Package controlapi provides HTTP handlers for the MediaBridge ControlAPI.
// The ControlAPI is the internal REST API used by the Server to manage sessions.
// It binds to localhost only (127.0.0.1) per requirement 4.7.
package controlapi

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"mediabridge/internal/config"
	"mediabridge/internal/session"
)

// SessionTeardown is called when a session is destroyed via the control API.
// Implementations should close all resources associated with the session
// (WebRTC peer connection, SIP dialog, media session) so that connected
// clients detect the termination promptly.
type SessionTeardown func(sessionID string)

// Handler holds the dependencies for ControlAPI HTTP handlers.
type Handler struct {
	store           *session.Store
	cfg             config.Config
	startTime       time.Time
	logger          *slog.Logger
	sessionTeardown SessionTeardown
}

// NewHandler creates a new ControlAPI handler.
func NewHandler(store *session.Store, cfg config.Config, startTime time.Time, logger *slog.Logger) *Handler {
	return &Handler{
		store:     store,
		cfg:       cfg,
		startTime: startTime,
		logger:    logger,
	}
}

// SetSessionTeardown registers a callback invoked when a session is destroyed.
// The callback should close the WebRTC peer connection, SIP dialog, and media
// session so that remote clients detect the disconnection immediately.
func (h *Handler) SetSessionTeardown(fn SessionTeardown) {
	h.sessionTeardown = fn
}

// Register adds all ControlAPI routes to the given mux.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /sessions", h.createSession)
	mux.HandleFunc("GET /sessions/{sessionId}", h.getSession)
	mux.HandleFunc("PATCH /sessions/{sessionId}", h.patchSession)
	mux.HandleFunc("DELETE /sessions/{sessionId}", h.deleteSession)
	mux.HandleFunc("GET /health", h.health)
}

// --- Request/Response types ---

// CreateSessionRequest is the JSON body for POST /sessions.
type CreateSessionRequest struct {
	SessionID   string              `json:"sessionId"`
	ProviderLeg session.ProviderLeg `json:"providerLeg"`
	Options     *SessionOptions     `json:"options,omitempty"`
}

// SessionOptions maps the "options" field in the create request.
type SessionOptions struct {
	Ringback bool                    `json:"ringback"`
	AudioTap *session.AudioTapConfig `json:"audioTap,omitempty"`
}

// CreateSessionResponse is the JSON response for POST /sessions.
type CreateSessionResponse struct {
	SessionID  string         `json:"sessionId"`
	Status     session.Status `json:"status"`
	SIPUri     string         `json:"sipUri"`
	SIPSUri    string         `json:"sipsUri"`
	AudioWsURL string         `json:"audioWsUrl"`
}

// PatchSessionRequest is the JSON body for PATCH /sessions/:sessionId.
type PatchSessionRequest struct {
	ProviderLeg *session.ProviderLeg `json:"providerLeg,omitempty"`
	Ringback    *bool                `json:"ringback,omitempty"`
}

// HealthResponse is the JSON response for GET /health.
type HealthResponse struct {
	Status         string `json:"status"`
	ActiveSessions int    `json:"activeSessions"`
	Uptime         int    `json:"uptime"`
}

// ErrorResponse is a standard error response body.
type ErrorResponse struct {
	Error string `json:"error"`
}

// --- Handlers ---

func (h *Handler) createSession(w http.ResponseWriter, r *http.Request) {
	var req CreateSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	if req.SessionID == "" {
		h.writeError(w, http.StatusBadRequest, "sessionId is required")
		return
	}

	// Build session options.
	opts := session.Options{}
	if req.Options != nil {
		opts.Ringback = req.Options.Ringback
		if req.Options.AudioTap != nil {
			opts.AudioTap = req.Options.AudioTap
		}
	}

	sess := session.NewSession(req.SessionID, req.ProviderLeg, opts)

	if err := h.store.Create(sess); err != nil {
		h.writeError(w, http.StatusConflict, err.Error())
		return
	}

	h.logger.Info("session created",
		slog.String("sessionId", req.SessionID),
		slog.String("providerLegType", string(req.ProviderLeg.Type)),
	)

	// Build SIP URI, SIPS URI, and audio WS URL for this session.
	sipURI := fmt.Sprintf("sip:%s@%s:%d", req.SessionID, h.cfg.Network.PublicIP, h.cfg.SIP.Port)
	sipsURI := fmt.Sprintf("sips:%s@%s:%d", req.SessionID, h.cfg.Network.PublicIP, h.cfg.SIP.TLS.Port)
	audioWsURL := fmt.Sprintf("ws://%s:%d/audio/%s", h.cfg.Network.PublicIP, h.cfg.AudioWS.Port, req.SessionID)

	resp := CreateSessionResponse{
		SessionID:  req.SessionID,
		Status:     session.StatusCreated,
		SIPUri:     sipURI,
		SIPSUri:    sipsURI,
		AudioWsURL: audioWsURL,
	}

	h.writeJSON(w, http.StatusCreated, resp)
}

func (h *Handler) getSession(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("sessionId")

	sess := h.store.Get(sessionID)
	if sess == nil {
		h.writeError(w, http.StatusNotFound, "session not found")
		return
	}

	info := sess.GetStatus()
	h.writeJSON(w, http.StatusOK, info)
}

func (h *Handler) patchSession(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("sessionId")

	sess := h.store.Get(sessionID)
	if sess == nil {
		h.writeError(w, http.StatusNotFound, "session not found")
		return
	}

	var req PatchSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	if req.ProviderLeg != nil {
		sess.SetProviderLeg(*req.ProviderLeg)
		h.logger.Info("session provider leg updated",
			slog.String("sessionId", sessionID),
			slog.String("type", string(req.ProviderLeg.Type)),
			slog.String("uri", req.ProviderLeg.URI),
		)
	}

	if req.Ringback != nil {
		sess.SetRingback(*req.Ringback)
		h.logger.Info("session ringback toggled",
			slog.String("sessionId", sessionID),
			slog.Bool("ringback", *req.Ringback),
		)
	}

	h.writeJSON(w, http.StatusOK, sess.GetStatus())
}

func (h *Handler) deleteSession(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("sessionId")

	if !h.store.Delete(sessionID) {
		h.writeError(w, http.StatusNotFound, "session not found")
		return
	}

	// Tear down all associated resources (WebRTC peer connection, SIP dialog,
	// media session) so that the remote client detects the disconnection
	// immediately via ICE failure rather than waiting for a timeout.
	if h.sessionTeardown != nil {
		h.sessionTeardown(sessionID)
	}

	h.logger.Info("session destroyed", slog.String("sessionId", sessionID))
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) health(w http.ResponseWriter, r *http.Request) {
	uptime := int(time.Since(h.startTime).Seconds())

	resp := HealthResponse{
		Status:         "ok",
		ActiveSessions: h.store.Count(),
		Uptime:         uptime,
	}

	h.writeJSON(w, http.StatusOK, resp)
}

// --- Helpers ---

func (h *Handler) writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		h.logger.Error("failed to write JSON response", slog.String("error", err.Error()))
	}
}

func (h *Handler) writeError(w http.ResponseWriter, status int, msg string) {
	h.writeJSON(w, status, ErrorResponse{Error: msg})
}
