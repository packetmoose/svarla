package signaling

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/packetmoose/svarla/modem-gateway/internal/identity"
)

const (
	// authTimeout is the maximum time to wait for the authentication flow to complete.
	authTimeout = 30 * time.Second
)

// AuthPairPayload is sent by the binary during initial pairing.
type AuthPairPayload struct {
	Type          string `json:"type"`
	PublicKey     string `json:"publicKey"`
	PairingSecret string `json:"pairingSecret"`
}

// AuthChallengePayload is received from the server during reconnection auth.
type AuthChallengePayload struct {
	Type  string `json:"type"`
	Nonce string `json:"nonce"` // base64-encoded 32 bytes
}

// AuthResponsePayload is sent by the binary in response to a challenge.
type AuthResponsePayload struct {
	Type      string `json:"type"`
	Signature string `json:"signature"` // base64-encoded Ed25519 signature
}

// AuthSuccessPayload is received from the server on successful authentication.
type AuthSuccessPayload struct {
	Type string `json:"type"`
}

// AuthErrorPayload is received from the server on authentication failure.
type AuthErrorPayload struct {
	Type   string `json:"type"`
	Reason string `json:"reason"`
}

// PairingAuthenticator handles the authentication flow with the Svarla server.
// It implements the Authenticator interface.
//
// For initial pairing (when pairingSecret is set), it sends an auth_pair message
// with the public key and pairing secret, then waits for auth_success or auth_error.
//
// For reconnection (no pairing secret), it waits for the server to send an
// auth_challenge containing a nonce, signs it with Ed25519, sends auth_response,
// then waits for auth_success or auth_error.
type PairingAuthenticator struct {
	identity      *identity.Identity
	pairingSecret string
}

// Verify PairingAuthenticator implements the Authenticator interface at compile time.
var _ Authenticator = (*PairingAuthenticator)(nil)

// NewPairingAuthenticator creates an authenticator with the given identity and optional pairing secret.
// If pairingSecret is non-empty, the next Authenticate call will perform initial pairing.
// If pairingSecret is empty, the next Authenticate call will perform challenge-response auth.
func NewPairingAuthenticator(id *identity.Identity, pairingSecret string) *PairingAuthenticator {
	return &PairingAuthenticator{
		identity:      id,
		pairingSecret: pairingSecret,
	}
}

// Authenticate performs the full authentication flow on the given client.
// It blocks until auth_success is received, an auth_error is received,
// the context is cancelled, or a timeout occurs (30 seconds).
func (a *PairingAuthenticator) Authenticate(ctx context.Context, client *Client) error {
	// Channel to receive the auth result.
	resultCh := make(chan authResult, 1)

	// Register a temporary message handler for auth messages.
	// The handler becomes a no-op after auth completes since resultCh is
	// buffered and only read once.
	client.OnMessage(func(msg Message) {
		switch msg.Type {
		case TypeAuthChallenge:
			a.handleChallenge(client, msg, resultCh)
		case TypeAuthSuccess:
			select {
			case resultCh <- authResult{success: true}:
			default:
			}
		case TypeAuthError:
			var payload AuthErrorPayload
			if err := msg.ParsePayload(&payload); err != nil {
				select {
				case resultCh <- authResult{err: fmt.Errorf("auth error (failed to parse reason): %w", err)}:
				default:
				}
				return
			}
			select {
			case resultCh <- authResult{err: fmt.Errorf("authentication rejected: %s", payload.Reason)}:
			default:
			}
		}
	})

	// Start reading now that all handlers (including auth) are registered.
	// This ensures the server's auth_challenge is never lost to a race.
	client.StartReading()

	// Initiate the appropriate auth flow.
	if a.pairingSecret != "" {
		if err := a.sendPairRequest(client); err != nil {
			return fmt.Errorf("failed to send pairing request: %w", err)
		}
	}
	// If no pairing secret, we wait for the server to send an auth_challenge.

	// Wait for the result, timeout, or context cancellation.
	select {
	case result := <-resultCh:
		if result.err != nil {
			return result.err
		}
		if a.pairingSecret != "" {
			log.Println("[signaling] pairing successful — you may now remove 'pairingSecret' from your config file")
		} else {
			log.Println("[signaling] authentication successful")
		}
		return nil
	case <-time.After(authTimeout):
		return errors.New("authentication timed out (30s)")
	case <-ctx.Done():
		return ctx.Err()
	}
}

// sendPairRequest sends the initial auth_pair message with the public key and pairing secret.
func (a *PairingAuthenticator) sendPairRequest(client *Client) error {
	payload := AuthPairPayload{
		Type:          TypeAuthPair,
		PublicKey:     a.identity.PublicKeyBase64(),
		PairingSecret: a.pairingSecret,
	}

	msg, err := NewMessage(TypeAuthPair, payload)
	if err != nil {
		return err
	}

	return client.Send(msg)
}

// handleChallenge processes an auth_challenge message by signing the nonce and
// sending an auth_response. If any step fails, it sends an error on resultCh.
func (a *PairingAuthenticator) handleChallenge(client *Client, msg Message, resultCh chan<- authResult) {
	var challenge AuthChallengePayload
	if err := msg.ParsePayload(&challenge); err != nil {
		select {
		case resultCh <- authResult{err: fmt.Errorf("failed to parse auth challenge: %w", err)}:
		default:
		}
		return
	}

	nonce, err := base64.StdEncoding.DecodeString(challenge.Nonce)
	if err != nil {
		select {
		case resultCh <- authResult{err: fmt.Errorf("failed to decode challenge nonce: %w", err)}:
		default:
		}
		return
	}

	// Sign the nonce with our Ed25519 private key.
	signature := a.identity.Sign(nonce)

	// Send the auth_response.
	payload := AuthResponsePayload{
		Type:      TypeAuthResponse,
		Signature: base64.StdEncoding.EncodeToString(signature),
	}

	responseMsg, err := NewMessage(TypeAuthResponse, payload)
	if err != nil {
		select {
		case resultCh <- authResult{err: fmt.Errorf("failed to create auth response message: %w", err)}:
		default:
		}
		return
	}

	if err := client.Send(responseMsg); err != nil {
		select {
		case resultCh <- authResult{err: fmt.Errorf("failed to send auth response: %w", err)}:
		default:
		}
	}
	// Now wait for auth_success or auth_error — handled by the main handler switch.
}

// authResult is an internal type for communicating auth outcome from the handler.
type authResult struct {
	success bool
	err     error
}
