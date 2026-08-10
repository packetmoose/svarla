package sip

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
)

// CryptoAttribute represents a parsed a=crypto line from SDP.
type CryptoAttribute struct {
	Tag       int    // Crypto tag (e.g., 1)
	Suite     string // e.g., "AES_CM_128_HMAC_SHA1_80"
	KeyParams string // Base64-encoded key material (inline:<base64>)
}

// SDESResult holds the result of SDES negotiation.
type SDESResult struct {
	Selected    CryptoAttribute // The selected offer attribute
	LocalKey    []byte          // Generated local SRTP master key + salt (30 bytes)
	LocalKeyB64 string          // Base64-encoded local key for SDP answer
	RemoteKey   []byte          // Decoded remote key from offer
}

// ParseCryptoAttributes extracts a=crypto lines from SDP body.
// Malformed lines are skipped gracefully; only successfully parsed attributes
// are returned in their original order.
func ParseCryptoAttributes(sdpBody []byte) ([]CryptoAttribute, error) {
	var attrs []CryptoAttribute

	lines := strings.Split(string(sdpBody), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "a=crypto:") {
			continue
		}

		attr, err := parseCryptoLine(line)
		if err != nil {
			// Skip malformed lines gracefully
			continue
		}
		attrs = append(attrs, attr)
	}

	return attrs, nil
}

// parseCryptoLine parses a single a=crypto line per RFC 4568 format:
//
//	a=crypto:<tag> <crypto-suite> <key-params>
func parseCryptoLine(line string) (CryptoAttribute, error) {
	// Strip the "a=crypto:" prefix to get "<tag> <suite> <key-params>"
	rest := strings.TrimPrefix(line, "a=crypto:")

	// Split into at least 3 parts: tag, suite, key-params
	parts := strings.Fields(rest)
	if len(parts) < 3 {
		return CryptoAttribute{}, fmt.Errorf("malformed crypto line: need at least 3 fields, got %d", len(parts))
	}

	tag, err := strconv.Atoi(parts[0])
	if err != nil {
		return CryptoAttribute{}, fmt.Errorf("invalid crypto tag %q: %w", parts[0], err)
	}

	suite := parts[1]
	keyParams := parts[2]

	return CryptoAttribute{
		Tag:       tag,
		Suite:     suite,
		KeyParams: keyParams,
	}, nil
}

// supportedSuite is the only SRTP crypto suite we support.
const supportedSuite = "AES_CM_128_HMAC_SHA1_80"

// NegotiateSDES selects the first supported crypto suite from the offered list
// and generates local SRTP key material.
// Returns nil, nil if no supported suite is found (caller should reject with 488).
func NegotiateSDES(offered []CryptoAttribute) (*SDESResult, error) {
	// Find the first offered entry with a supported suite (case-insensitive)
	var selected *CryptoAttribute
	for i := range offered {
		if strings.EqualFold(offered[i].Suite, supportedSuite) {
			selected = &offered[i]
			break
		}
	}

	if selected == nil {
		return nil, nil
	}

	// Generate 30 random bytes for local SRTP master key + salt
	localKey := make([]byte, 30)
	if _, err := rand.Read(localKey); err != nil {
		return nil, fmt.Errorf("failed to generate local SRTP key: %w", err)
	}

	// Base64-encode the local key for inclusion in SDP answer
	localKeyB64 := base64.StdEncoding.EncodeToString(localKey)

	// Decode the remote key from the offered key-params
	// Key params format: "inline:<base64-key>"
	remoteKeyB64 := strings.TrimPrefix(selected.KeyParams, "inline:")
	remoteKey, err := base64.StdEncoding.DecodeString(remoteKeyB64)
	if err != nil {
		return nil, fmt.Errorf("failed to decode remote key: %w", err)
	}

	return &SDESResult{
		Selected:    *selected,
		LocalKey:    localKey,
		LocalKeyB64: localKeyB64,
		RemoteKey:   remoteKey,
	}, nil
}

// FormatCryptoAnswer formats the a=crypto line for the SDP answer.
// Output format: a=crypto:<tag> <suite> inline:<base64-local-key>
func FormatCryptoAnswer(result *SDESResult) string {
	return fmt.Sprintf("a=crypto:%d %s inline:%s",
		result.Selected.Tag,
		result.Selected.Suite,
		result.LocalKeyB64,
	)
}
