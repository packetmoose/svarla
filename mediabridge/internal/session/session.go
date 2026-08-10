// Package session provides in-memory session state management for the MediaBridge.
// Sessions are ephemeral — all state is lost on restart per requirement 4.8.
package session

import (
	"sync"
	"time"
)

// Status represents the lifecycle state of a session.
type Status string

const (
	StatusCreated         Status = "CREATED"
	StatusWaitingClient   Status = "WAITING_CLIENT"
	StatusClientConnected Status = "CLIENT_CONNECTED"
	StatusBridging        Status = "BRIDGING"
	StatusActive          Status = "ACTIVE"
	StatusClosing         Status = "CLOSING"
	StatusDestroyed       Status = "DESTROYED"
)

// ProviderLegType defines how the provider connects audio.
type ProviderLegType string

const (
	ProviderLegSIP       ProviderLegType = "sip"
	ProviderLegWebSocket ProviderLegType = "websocket"
	ProviderLegPending   ProviderLegType = "pending"
)

// ProviderLeg describes the provider-side audio connection.
type ProviderLeg struct {
	Type           ProviderLegType `json:"type"`
	URI            string          `json:"uri,omitempty"`
	Protocol       string          `json:"protocol,omitempty"`
	ExpectedCallId string          `json:"expectedCallId,omitempty"`
}

// AudioTapConfig holds audio tap configuration for a session.
type AudioTapConfig struct {
	Enabled  bool   `json:"enabled"`
	Endpoint string `json:"endpoint,omitempty"`
}

// Options holds optional session configuration.
type Options struct {
	Ringback bool            `json:"ringback"`
	AudioTap *AudioTapConfig `json:"audioTap,omitempty"`
}

// ProviderRTPInfo holds the provider's RTP endpoint info from the SIP INVITE.
type ProviderRTPInfo struct {
	RemoteIP       string
	RemotePort     int
	Codec          string
	CodecClockRate int
	PayloadType    uint8
}

// Session represents a single call session in the MediaBridge.
type Session struct {
	mu sync.RWMutex

	ID                string
	Status            Status
	ProviderLeg       ProviderLeg
	Options           Options
	ClientConnected   bool
	ProviderConnected bool
	Codec             string
	CreatedAt         time.Time
	ConnectedAt       *time.Time // when call became ACTIVE

	// ProviderRTP holds the provider's RTP endpoint info set when the SIP
	// INVITE is accepted. Used to create the media session when both legs connect.
	ProviderRTP *ProviderRTPInfo
}

// NewSession creates a session with the given ID and configuration.
func NewSession(id string, providerLeg ProviderLeg, opts Options) *Session {
	return &Session{
		ID:          id,
		Status:      StatusCreated,
		ProviderLeg: providerLeg,
		Options:     opts,
		CreatedAt:   time.Now(),
	}
}

// GetStatus returns a snapshot of the session status fields.
func (s *Session) GetStatus() StatusInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var duration int
	if s.ConnectedAt != nil {
		duration = int(time.Since(*s.ConnectedAt).Seconds())
	}

	return StatusInfo{
		SessionID:         s.ID,
		Status:            s.Status,
		ClientConnected:   s.ClientConnected,
		ProviderConnected: s.ProviderConnected,
		DurationSeconds:   duration,
		Codec:             s.Codec,
	}
}

// SetStatus updates the session status.
func (s *Session) SetStatus(status Status) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Status = status
}

// SetProviderLeg updates the provider leg configuration.
func (s *Session) SetProviderLeg(leg ProviderLeg) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ProviderLeg = leg
}

// GetProviderLegType returns the provider leg type.
func (s *Session) GetProviderLegType() ProviderLegType {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.ProviderLeg.Type
}

// SetRingback updates the ringback option.
func (s *Session) SetRingback(enabled bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Options.Ringback = enabled
}

// SetProviderRTP stores the provider's RTP endpoint info.
func (s *Session) SetProviderRTP(info *ProviderRTPInfo) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ProviderRTP = info
	s.ProviderConnected = true
}

// SetClientConnected marks the client as connected.
func (s *Session) SetClientConnected(connected bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ClientConnected = connected
}

// BothLegsReady returns true if both the provider and client are connected,
// meaning the media session can be started.
func (s *Session) BothLegsReady() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.ProviderConnected && s.ClientConnected
}

// GetProviderRTP returns the provider RTP info (nil if not yet connected).
func (s *Session) GetProviderRTP() *ProviderRTPInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.ProviderRTP
}

// StatusInfo is a read-only snapshot of session status.
type StatusInfo struct {
	SessionID         string `json:"sessionId"`
	Status            Status `json:"status"`
	ClientConnected   bool   `json:"clientConnected"`
	ProviderConnected bool   `json:"providerConnected"`
	DurationSeconds   int    `json:"durationSeconds"`
	Codec             string `json:"codec"`
}
