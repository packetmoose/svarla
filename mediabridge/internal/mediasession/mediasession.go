// Package mediasession provides the orchestration layer that connects the
// SIP RTP transport, the audio bridge, and the WebRTC peer connection for
// bidirectional audio flow.
package mediasession

import (
	"fmt"
	"log/slog"
	"sync"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"mediabridge/internal/bridge"
	"mediabridge/internal/sip"
)

// Config holds configuration for creating a MediaSession.
type Config struct {
	SessionID      string
	SIPCodec       string // e.g. "PCMU"
	SIPClockRate   int
	SIPPayloadType uint8
	RemoteIP       string // Provider's RTP IP
	RemotePort     int    // Provider's RTP port
	RTPListener    *sip.RTPListener // Shared RTP listener
	SRTPSession    *sip.SRTPSession // Optional SRTP session for encrypted media
	Logger         *slog.Logger
}

// MediaSession ties together the SIP RTP transport, the audio bridge, and
// the WebRTC audio tracks for a single call session.
type MediaSession struct {
	mu sync.RWMutex

	sessionID    string
	config       Config
	logger       *slog.Logger
	rtpTransport *sip.RTPTransport
	audioBridge  *bridge.Bridge
	localTrack   *webrtc.TrackLocalStaticRTP
	running      bool
}

// New creates a new MediaSession. It sets up the audio bridge but does not
// start audio flow until Start() is called.
func New(cfg Config) (*MediaSession, error) {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}

	// Create the audio bridge.
	audioBridge, err := bridge.New(bridge.Config{
		SessionID:      cfg.SessionID,
		SIPCodec:       cfg.SIPCodec,
		SIPClockRate:   cfg.SIPClockRate,
		SIPPayloadType: cfg.SIPPayloadType,
		Logger:         cfg.Logger,
	})
	if err != nil {
		return nil, fmt.Errorf("creating audio bridge: %w", err)
	}

	ms := &MediaSession{
		sessionID:   cfg.SessionID,
		config:      cfg,
		logger:      cfg.Logger,
		audioBridge: audioBridge,
	}

	return ms, nil
}

// SetLocalTrack sets the WebRTC local audio track for sending audio to the client.
func (ms *MediaSession) SetLocalTrack(track *webrtc.TrackLocalStaticRTP) {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	ms.localTrack = track
}

// Start begins bidirectional audio flow.
// It registers with the shared RTP listener, wires up the bridge, and begins processing.
func (ms *MediaSession) Start() error {
	ms.mu.Lock()
	if ms.running {
		ms.mu.Unlock()
		return nil
	}
	ms.mu.Unlock()

	// Register with the shared RTP listener to receive packets from this provider.
	rtpTransport, err := ms.config.RTPListener.RegisterSession(
		ms.config.RemoteIP,
		ms.config.RemotePort,
		func(pkt *rtp.Packet) {
			// If SRTP session is active, decrypt the incoming packet.
			if ms.config.SRTPSession != nil {
				encrypted, merr := pkt.Marshal()
				if merr != nil {
					return
				}
				decrypted, derr := ms.config.SRTPSession.DecryptRTP(encrypted)
				if derr != nil {
					// Drop packet on decrypt failure.
					return
				}
				plainPkt := &rtp.Packet{}
				if uerr := plainPkt.Unmarshal(decrypted); uerr != nil {
					return
				}
				ms.audioBridge.HandleProviderRTP(plainPkt)
			} else {
				ms.audioBridge.HandleProviderRTP(pkt)
			}
		},
	)
	if err != nil {
		return fmt.Errorf("registering RTP session: %w", err)
	}
	ms.rtpTransport = rtpTransport

	// Wire Bridge → WebRTC (provider-to-client output).
	ms.mu.RLock()
	localTrack := ms.localTrack
	ms.mu.RUnlock()

	if localTrack != nil {
		ms.audioBridge.SetWebRTCWriter(bridge.RTPWriterFunc(func(pkt *rtp.Packet) error {
			return localTrack.WriteRTP(pkt)
		}))
	}

	// Wire Bridge → SIP RTP (client-to-provider output).
	ms.audioBridge.SetSIPWriter(bridge.RTPWriterFunc(func(pkt *rtp.Packet) error {
		// If SRTP session is active, encrypt before sending.
		if ms.config.SRTPSession != nil {
			plain, merr := pkt.Marshal()
			if merr != nil {
				return merr
			}
			encrypted, eerr := ms.config.SRTPSession.EncryptRTP(plain)
			if eerr != nil {
				return eerr
			}
			// Send raw encrypted bytes via the underlying UDP connection.
			return ms.rtpTransport.WriteRaw(encrypted)
		}
		return ms.rtpTransport.WriteRTP(pkt)
	}))

	// Start the bridge (begins jitter buffer playout loop).
	ms.audioBridge.Start()

	ms.mu.Lock()
	ms.running = true
	ms.mu.Unlock()

	ms.logger.Info("media session started",
		slog.String("sessionId", ms.sessionID),
		slog.String("remoteRTP", fmt.Sprintf("%s:%d", ms.config.RemoteIP, ms.config.RemotePort)),
	)

	return nil
}

// HandleClientRTP processes an RTP packet received from the WebRTC client.
// This is called from the WebRTC OnTrack handler with Opus RTP packets.
func (ms *MediaSession) HandleClientRTP(pkt *rtp.Packet) {
	ms.audioBridge.HandleClientRTP(pkt)
}

// HandleClientPCM processes decoded PCM audio from the WebRTC client.
// PCM is expected at 48kHz, 16-bit, mono.
func (ms *MediaSession) HandleClientPCM(pcm48k []int16) {
	ms.audioBridge.HandleClientPCM(pcm48k)
}

// Stop terminates the media session, stopping the bridge and unregistering from RTP listener.
func (ms *MediaSession) Stop() {
	ms.mu.Lock()
	if !ms.running {
		ms.mu.Unlock()
		return
	}
	ms.running = false
	ms.mu.Unlock()

	ms.audioBridge.Stop()

	// Unregister from the shared RTP listener.
	ms.config.RTPListener.UnregisterSession(ms.config.RemoteIP, ms.config.RemotePort)

	ms.logger.Info("media session stopped",
		slog.String("sessionId", ms.sessionID),
	)
}

// IsRunning returns whether the media session is currently active.
func (ms *MediaSession) IsRunning() bool {
	ms.mu.RLock()
	defer ms.mu.RUnlock()
	return ms.running
}

// Bridge returns the underlying audio bridge (for stats/monitoring).
func (ms *MediaSession) Bridge() *bridge.Bridge {
	return ms.audioBridge
}
