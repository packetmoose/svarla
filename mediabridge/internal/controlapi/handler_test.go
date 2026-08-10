package controlapi

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"mediabridge/internal/config"
	"mediabridge/internal/session"
)

func setupTestHandler() (*Handler, *http.ServeMux) {
	store := session.NewStore()
	cfg := config.Defaults()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := NewHandler(store, cfg, time.Now(), logger)
	mux := http.NewServeMux()
	h.Register(mux)
	return h, mux
}

func TestHealthEndpoint(t *testing.T) {
	_, mux := setupTestHandler()

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}

	var resp HealthResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Status != "ok" {
		t.Fatalf("expected status 'ok', got '%s'", resp.Status)
	}
	if resp.ActiveSessions != 0 {
		t.Fatalf("expected 0 active sessions, got %d", resp.ActiveSessions)
	}
}

func TestCreateSession(t *testing.T) {
	_, mux := setupTestHandler()

	body := `{
		"sessionId": "session-123",
		"providerLeg": {"type": "sip", "uri": "sip:conf@provider.com"},
		"options": {"ringback": true, "audioTap": {"enabled": false}}
	}`

	req := httptest.NewRequest(http.MethodPost, "/sessions", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected status 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp CreateSessionResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.SessionID != "session-123" {
		t.Fatalf("expected sessionId 'session-123', got '%s'", resp.SessionID)
	}
	if resp.Status != session.StatusCreated {
		t.Fatalf("expected status CREATED, got '%s'", resp.Status)
	}
	if resp.SIPUri == "" {
		t.Fatal("expected non-empty sipUri")
	}
	if resp.AudioWsURL == "" {
		t.Fatal("expected non-empty audioWsUrl")
	}
}

func TestCreateSessionMissingID(t *testing.T) {
	_, mux := setupTestHandler()

	body := `{"providerLeg": {"type": "pending"}}`
	req := httptest.NewRequest(http.MethodPost, "/sessions", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d", w.Code)
	}
}

func TestCreateSessionDuplicate(t *testing.T) {
	_, mux := setupTestHandler()

	body := `{"sessionId": "dup-1", "providerLeg": {"type": "pending"}}`

	req := httptest.NewRequest(http.MethodPost, "/sessions", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("first create: expected 201, got %d", w.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/sessions", bytes.NewBufferString(body))
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("duplicate create: expected 409, got %d", w.Code)
	}
}

func TestGetSession(t *testing.T) {
	_, mux := setupTestHandler()

	// Create a session first.
	body := `{"sessionId": "get-1", "providerLeg": {"type": "websocket", "uri": "ws://host:9091/audio/get-1"}}`
	req := httptest.NewRequest(http.MethodPost, "/sessions", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	// Now GET it.
	req = httptest.NewRequest(http.MethodGet, "/sessions/get-1", nil)
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}

	var resp session.StatusInfo
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.SessionID != "get-1" {
		t.Fatalf("expected sessionId 'get-1', got '%s'", resp.SessionID)
	}
	if resp.Status != session.StatusCreated {
		t.Fatalf("expected status CREATED, got '%s'", resp.Status)
	}
	if resp.ClientConnected {
		t.Fatal("expected clientConnected to be false")
	}
	if resp.ProviderConnected {
		t.Fatal("expected providerConnected to be false")
	}
}

func TestGetSessionNotFound(t *testing.T) {
	_, mux := setupTestHandler()

	req := httptest.NewRequest(http.MethodGet, "/sessions/nonexistent", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected status 404, got %d", w.Code)
	}
}

func TestPatchSession(t *testing.T) {
	_, mux := setupTestHandler()

	// Create session.
	createBody := `{"sessionId": "patch-1", "providerLeg": {"type": "pending"}, "options": {"ringback": true}}`
	req := httptest.NewRequest(http.MethodPost, "/sessions", bytes.NewBufferString(createBody))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	// Patch provider leg and ringback.
	patchBody := `{"providerLeg": {"type": "sip", "uri": "sip:updated@host:5060"}, "ringback": false}`
	req = httptest.NewRequest(http.MethodPatch, "/sessions/patch-1", bytes.NewBufferString(patchBody))
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp session.StatusInfo
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.SessionID != "patch-1" {
		t.Fatalf("expected sessionId 'patch-1', got '%s'", resp.SessionID)
	}
}

func TestPatchSessionNotFound(t *testing.T) {
	_, mux := setupTestHandler()

	patchBody := `{"ringback": false}`
	req := httptest.NewRequest(http.MethodPatch, "/sessions/nonexistent", bytes.NewBufferString(patchBody))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected status 404, got %d", w.Code)
	}
}

func TestDeleteSession(t *testing.T) {
	_, mux := setupTestHandler()

	// Create session.
	body := `{"sessionId": "del-1", "providerLeg": {"type": "pending"}}`
	req := httptest.NewRequest(http.MethodPost, "/sessions", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	// Delete it.
	req = httptest.NewRequest(http.MethodDelete, "/sessions/del-1", nil)
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("expected status 204, got %d", w.Code)
	}

	// Verify it's gone.
	req = httptest.NewRequest(http.MethodGet, "/sessions/del-1", nil)
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 after delete, got %d", w.Code)
	}
}

func TestDeleteSessionNotFound(t *testing.T) {
	_, mux := setupTestHandler()

	req := httptest.NewRequest(http.MethodDelete, "/sessions/nonexistent", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected status 404, got %d", w.Code)
	}
}

func TestHealthReportsActiveSessions(t *testing.T) {
	_, mux := setupTestHandler()

	// Create two sessions.
	for _, id := range []string{"health-1", "health-2"} {
		body := `{"sessionId": "` + id + `", "providerLeg": {"type": "pending"}}`
		req := httptest.NewRequest(http.MethodPost, "/sessions", bytes.NewBufferString(body))
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
	}

	// Check health.
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	var resp HealthResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode: %v", err)
	}

	if resp.ActiveSessions != 2 {
		t.Fatalf("expected 2 active sessions, got %d", resp.ActiveSessions)
	}
}

func TestCreateSessionWithAudioTap(t *testing.T) {
	_, mux := setupTestHandler()

	body := `{
		"sessionId": "tap-1",
		"providerLeg": {"type": "pending"},
		"options": {
			"ringback": false,
			"audioTap": {"enabled": true, "endpoint": "ws://localhost:9092/tap/tap-1"}
		}
	}`

	req := httptest.NewRequest(http.MethodPost, "/sessions", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
}

func TestCreateSessionSipUriFormat(t *testing.T) {
	_, mux := setupTestHandler()

	body := `{"sessionId": "uri-1", "providerLeg": {"type": "sip", "uri": "sip:orig@provider.com"}}`
	req := httptest.NewRequest(http.MethodPost, "/sessions", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	var resp CreateSessionResponse
	_ = json.NewDecoder(w.Body).Decode(&resp)

	// sipUri should contain the session ID and the configured SIP port.
	expectedSipUri := "sip:uri-1@127.0.0.1:5060"
	if resp.SIPUri != expectedSipUri {
		t.Fatalf("expected sipUri '%s', got '%s'", expectedSipUri, resp.SIPUri)
	}

	expectedWsUrl := "ws://127.0.0.1:9091/audio/uri-1"
	if resp.AudioWsURL != expectedWsUrl {
		t.Fatalf("expected audioWsUrl '%s', got '%s'", expectedWsUrl, resp.AudioWsURL)
	}
}
