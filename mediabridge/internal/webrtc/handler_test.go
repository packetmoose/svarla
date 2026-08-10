package webrtc

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newTestHandler(t *testing.T) (*Handler, *Engine) {
	t.Helper()
	port := getFreePort(t)
	logger := newTestLogger()

	engine, err := NewEngine(EngineConfig{
		PublicIP: "192.0.2.1",
		TCPPort:  port,
	}, logger)
	if err != nil {
		t.Fatalf("NewEngine() error: %v", err)
	}

	handler := NewHandler(engine, logger)
	return handler, engine
}

func TestHandler_HandleOffer_Success(t *testing.T) {
	handler, engine := newTestHandler(t)
	defer engine.Close()

	sdpOffer := createTestOffer(t, engine.config.TCPPort)

	body, _ := json.Marshal(OfferRequest{SDPOffer: sdpOffer})
	req := httptest.NewRequest(http.MethodPost, "/sessions/test-session/offer", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	// Set path value for Go 1.22+ routing.
	req.SetPathValue("sessionId", "test-session")

	w := httptest.NewRecorder()
	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", w.Code, http.StatusOK, w.Body.String())
	}

	var resp OfferResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if resp.SDPAnswer == "" {
		t.Error("sdpAnswer is empty")
	}
	if len(resp.ICECandidates) == 0 {
		t.Error("iceCandidates is empty")
	}

	// Verify ICE candidate contains the public IP.
	candidate := resp.ICECandidates[0]
	if candidate.SDPMid != "0" {
		t.Errorf("candidate sdpMid = %q, want \"0\"", candidate.SDPMid)
	}
	if candidate.SDPMLineIndex != 0 {
		t.Errorf("candidate sdpMLineIndex = %d, want 0", candidate.SDPMLineIndex)
	}
}

func TestHandler_HandleOffer_MissingBody(t *testing.T) {
	handler, engine := newTestHandler(t)
	defer engine.Close()

	req := httptest.NewRequest(http.MethodPost, "/sessions/test-session/offer", bytes.NewReader([]byte("{}")))
	req.Header.Set("Content-Type", "application/json")
	req.SetPathValue("sessionId", "test-session")

	w := httptest.NewRecorder()
	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandler_HandleOffer_InvalidSDP(t *testing.T) {
	handler, engine := newTestHandler(t)
	defer engine.Close()

	body, _ := json.Marshal(OfferRequest{SDPOffer: "garbage"})
	req := httptest.NewRequest(http.MethodPost, "/sessions/bad-sdp/offer", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.SetPathValue("sessionId", "bad-sdp")

	w := httptest.NewRecorder()
	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", w.Code, http.StatusInternalServerError)
	}
}

func TestHandler_HandleOffer_InvalidJSON(t *testing.T) {
	handler, engine := newTestHandler(t)
	defer engine.Close()

	req := httptest.NewRequest(http.MethodPost, "/sessions/test/offer", bytes.NewReader([]byte("not json")))
	req.Header.Set("Content-Type", "application/json")
	req.SetPathValue("sessionId", "test")

	w := httptest.NewRecorder()
	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestExtractSessionID(t *testing.T) {
	tests := []struct {
		path     string
		expected string
	}{
		{"/sessions/abc-123/offer", "abc-123"},
		{"/sessions/my-session-id/offer", "my-session-id"},
		{"/sessions//offer", ""},
		{"/other/path", ""},
		{"/sessions/id/other", ""},
		{"", ""},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			got := extractSessionID(tt.path)
			if got != tt.expected {
				t.Errorf("extractSessionID(%q) = %q, want %q", tt.path, got, tt.expected)
			}
		})
	}
}
