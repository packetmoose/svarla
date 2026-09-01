// Package identity manages Ed25519 keypair generation, storage, and
// challenge signing for device authentication with the Svarla server.
package identity

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
)

// pemType is the PEM block type used for the Ed25519 private key (PKCS8 format).
const pemType = "PRIVATE KEY"

// Identity manages an Ed25519 keypair for authentication with the Svarla server.
// The private key is stored as a PEM-encoded PKCS8 file on disk.
type Identity struct {
	keyPath    string
	privateKey ed25519.PrivateKey
	publicKey  ed25519.PublicKey
}

// New creates a new Identity that will read/write its key at keyPath.
func New(keyPath string) *Identity {
	return &Identity{
		keyPath: keyPath,
	}
}

// Exists returns true if the key file already exists on disk.
func (id *Identity) Exists() bool {
	_, err := os.Stat(id.keyPath)
	return err == nil
}

// Generate creates a new Ed25519 keypair and saves the private key
// as a PEM-encoded PKCS8 file with 0600 permissions.
func (id *Identity) Generate() error {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		return fmt.Errorf("identity: failed to generate Ed25519 keypair: %w", err)
	}

	if err := writeKeyFile(id.keyPath, priv); err != nil {
		return err
	}

	id.privateKey = priv
	id.publicKey = pub
	return nil
}

// Load reads an existing PEM-encoded private key from disk and derives
// the public key from it.
func (id *Identity) Load() error {
	data, err := os.ReadFile(id.keyPath)
	if err != nil {
		return fmt.Errorf("identity: failed to read key file %q: %w", id.keyPath, err)
	}

	block, _ := pem.Decode(data)
	if block == nil {
		return errors.New("identity: key file does not contain a valid PEM block")
	}

	if block.Type != pemType {
		return fmt.Errorf("identity: unexpected PEM type %q, expected %q", block.Type, pemType)
	}

	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return fmt.Errorf("identity: failed to parse PKCS8 private key: %w", err)
	}

	edKey, ok := key.(ed25519.PrivateKey)
	if !ok {
		return errors.New("identity: key file does not contain an Ed25519 private key")
	}

	id.privateKey = edKey
	id.publicKey = edKey.Public().(ed25519.PublicKey)
	return nil
}

// PublicKey returns the Ed25519 public key. Panics if no key has been
// generated or loaded.
func (id *Identity) PublicKey() ed25519.PublicKey {
	if id.publicKey == nil {
		panic("identity: no key loaded or generated")
	}
	return id.publicKey
}

// PublicKeyBase64 returns the public key encoded as a standard base64 string,
// suitable for use in the auth_pair signaling message.
func (id *Identity) PublicKeyBase64() string {
	return base64.StdEncoding.EncodeToString(id.PublicKey())
}

// Sign signs the given data with the Ed25519 private key and returns
// the signature. This is used to sign the 32-byte challenge nonce from
// the Svarla server during reconnection authentication.
func (id *Identity) Sign(data []byte) []byte {
	if id.privateKey == nil {
		panic("identity: no key loaded or generated")
	}
	return ed25519.Sign(id.privateKey, data)
}

// writeKeyFile marshals the private key to PKCS8 DER, wraps it in a PEM
// block, and writes it to path with restrictive permissions.
func writeKeyFile(path string, key ed25519.PrivateKey) error {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return fmt.Errorf("identity: failed to marshal private key to PKCS8: %w", err)
	}

	block := &pem.Block{
		Type:  pemType,
		Bytes: der,
	}

	pemData := pem.EncodeToMemory(block)

	if err := os.WriteFile(path, pemData, 0600); err != nil {
		return fmt.Errorf("identity: failed to write key file %q: %w", path, err)
	}

	return nil
}
