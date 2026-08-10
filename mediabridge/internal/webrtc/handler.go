package webrtc

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
)

// OfferRequest is the JSON body for POST /sessions/:sessionId/offer.
type OfferRequest struct {
	SDPOffer string `json:"sdpOffer"`
}

// OfferResponse is the JSON response for POST /sessions/:sessionId/offer.
type OfferResponse struct {
	SDPAnswer     string         `json:"sdpAnswer"`
	ICECandidates []ICECandidate `json:"iceCandidates"`
}

// Handler provides HTTP handlers for the WebRTC endpoint.
type Handler struct {
	engine *Engine
	logger *slog.Logger
}

// NewHandler creates a new WebRTC HTTP handler.
func NewHandler(engine *Engine, logger *slog.Logger) *Handler {
	return &Handler{
		engine: engine,
		logger: logger,
	}
}

// RegisterRoutes registers the WebRTC offer endpoint on the given mux.
// The route pattern is: POST /sessions/{sessionId}/offer
func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /sessions/{sessionId}/offer", h.handleOffer)
}

// handleOffer processes an SDP offer and returns an SDP answer with ICE candidates.
func (h *Handler) handleOffer(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("sessionId")
	if sessionID == "" {
		// Fallback: try to extract from path manually for Go < 1.22 pattern support.
		sessionID = extractSessionID(r.URL.Path)
	}

	if sessionID == "" {
		h.writeError(w, http.StatusBadRequest, "missing sessionId in path")
		return
	}

	// Parse request body.
	var req OfferRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %v", err))
		return
	}

	if req.SDPOffer == "" {
		h.writeError(w, http.StatusBadRequest, "sdpOffer is required")
		return
	}

	h.logger.Info("handling SDP offer",
		slog.String("sessionId", sessionID),
		slog.Int("sdpLength", len(req.SDPOffer)),
	)

	// Process the offer through the engine.
	sdpAnswer, candidates, err := h.engine.HandleOffer(sessionID, req.SDPOffer)
	if err != nil {
		h.logger.Error("failed to handle offer",
			slog.String("sessionId", sessionID),
			slog.String("error", err.Error()),
		)
		h.writeError(w, http.StatusInternalServerError, fmt.Sprintf("failed to process offer: %v", err))
		return
	}

	// Return the answer.
	resp := OfferResponse{
		SDPAnswer:     sdpAnswer,
		ICECandidates: candidates,
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		h.logger.Error("failed to write response",
			slog.String("sessionId", sessionID),
			slog.String("error", err.Error()),
		)
	}
}

// writeError writes a JSON error response.
func (h *Handler) writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}

// extractSessionID extracts the session ID from a path like /sessions/{id}/offer.
func extractSessionID(path string) string {
	// Expected: /sessions/<sessionId>/offer
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(parts) >= 3 && parts[0] == "sessions" && parts[2] == "offer" {
		return parts[1]
	}
	return ""
}
