package sip

import (
	"fmt"
	"sync"

	"github.com/pion/rtp"
	"github.com/pion/srtp/v3"
)

// SRTPSession wraps an RTP session with SRTP encryption/decryption.
// It uses pion/srtp contexts for encrypting outgoing and decrypting incoming
// RTP packets based on SDES-negotiated key material.
type SRTPSession struct {
	mu        sync.Mutex
	localCtx  *srtp.Context // For encrypting outgoing packets
	remoteCtx *srtp.Context // For decrypting incoming packets
	localKey  []byte        // Copy of local key material (zeroed on close)
	remoteKey []byte        // Copy of remote key material (zeroed on close)
	closed    bool
}

// NewSRTPSession creates an SRTP session from negotiated SDES keys.
// localKey and remoteKey must each be 30 bytes (16-byte master key + 14-byte master salt).
// The profile should be srtp.ProtectionProfileAes128CmHmacSha1_80.
func NewSRTPSession(localKey, remoteKey []byte, profile srtp.ProtectionProfile) (*SRTPSession, error) {
	keyLen, err := profile.KeyLen()
	if err != nil {
		return nil, fmt.Errorf("getting key length for profile: %w", err)
	}
	saltLen, err := profile.SaltLen()
	if err != nil {
		return nil, fmt.Errorf("getting salt length for profile: %w", err)
	}

	expectedLen := keyLen + saltLen
	if len(localKey) != expectedLen {
		return nil, fmt.Errorf("local key must be %d bytes (got %d)", expectedLen, len(localKey))
	}
	if len(remoteKey) != expectedLen {
		return nil, fmt.Errorf("remote key must be %d bytes (got %d)", expectedLen, len(remoteKey))
	}

	// Store copies of key material so we can zero them on close.
	localKeyCopy := make([]byte, len(localKey))
	copy(localKeyCopy, localKey)
	remoteKeyCopy := make([]byte, len(remoteKey))
	copy(remoteKeyCopy, remoteKey)

	// Split key material into master key and master salt.
	localMasterKey := localKeyCopy[:keyLen]
	localMasterSalt := localKeyCopy[keyLen:]
	remoteMasterKey := remoteKeyCopy[:keyLen]
	remoteMasterSalt := remoteKeyCopy[keyLen:]

	// Create encryption context (local key for outgoing packets).
	localCtx, err := srtp.CreateContext(localMasterKey, localMasterSalt, profile,
		srtp.SRTPReplayProtection(64),
	)
	if err != nil {
		return nil, fmt.Errorf("creating local SRTP context: %w", err)
	}

	// Create decryption context (remote key for incoming packets).
	remoteCtx, err := srtp.CreateContext(remoteMasterKey, remoteMasterSalt, profile,
		srtp.SRTPReplayProtection(64),
	)
	if err != nil {
		return nil, fmt.Errorf("creating remote SRTP context: %w", err)
	}

	return &SRTPSession{
		localCtx:  localCtx,
		remoteCtx: remoteCtx,
		localKey:  localKeyCopy,
		remoteKey: remoteKeyCopy,
	}, nil
}

// DecryptRTP decrypts an incoming SRTP packet to plain RTP.
func (s *SRTPSession) DecryptRTP(encrypted []byte) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return nil, fmt.Errorf("SRTP session is closed")
	}

	header := &rtp.Header{}
	dst := make([]byte, 0, len(encrypted))
	decrypted, err := s.remoteCtx.DecryptRTP(dst, encrypted, header)
	if err != nil {
		return nil, fmt.Errorf("decrypting SRTP packet: %w", err)
	}

	return decrypted, nil
}

// EncryptRTP encrypts an outgoing RTP packet to SRTP.
func (s *SRTPSession) EncryptRTP(plainRTP []byte) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return nil, fmt.Errorf("SRTP session is closed")
	}

	header := &rtp.Header{}
	// Allocate enough space for the encrypted output (plaintext + auth tag overhead).
	dst := make([]byte, 0, len(plainRTP)+10)
	encrypted, err := s.localCtx.EncryptRTP(dst, plainRTP, header)
	if err != nil {
		return nil, fmt.Errorf("encrypting RTP packet: %w", err)
	}

	return encrypted, nil
}

// Close releases SRTP context resources and zeros key material.
func (s *SRTPSession) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return
	}
	s.closed = true

	// Zero local key material.
	for i := range s.localKey {
		s.localKey[i] = 0
	}

	// Zero remote key material.
	for i := range s.remoteKey {
		s.remoteKey[i] = 0
	}

	s.localCtx = nil
	s.remoteCtx = nil
}
