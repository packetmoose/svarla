package identity

import (
	"crypto/ed25519"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestGenerate(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "test.key")

	id := New(keyPath)

	if id.Exists() {
		t.Fatal("Exists() should be false before Generate()")
	}

	if err := id.Generate(); err != nil {
		t.Fatalf("Generate() failed: %v", err)
	}

	if !id.Exists() {
		t.Fatal("Exists() should be true after Generate()")
	}

	// Verify file permissions are 0600
	info, err := os.Stat(keyPath)
	if err != nil {
		t.Fatalf("failed to stat key file: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Errorf("key file permissions = %o, want 0600", perm)
	}

	// Verify public key is 32 bytes (Ed25519 public key size)
	pub := id.PublicKey()
	if len(pub) != ed25519.PublicKeySize {
		t.Errorf("public key length = %d, want %d", len(pub), ed25519.PublicKeySize)
	}
}

func TestLoadAfterGenerate(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "test.key")

	// Generate a key
	original := New(keyPath)
	if err := original.Generate(); err != nil {
		t.Fatalf("Generate() failed: %v", err)
	}

	originalPub := original.PublicKey()

	// Load the key in a new Identity instance
	loaded := New(keyPath)
	if err := loaded.Load(); err != nil {
		t.Fatalf("Load() failed: %v", err)
	}

	loadedPub := loaded.PublicKey()

	// Public keys should match
	if !originalPub.Equal(loadedPub) {
		t.Error("loaded public key does not match original")
	}
}

func TestPublicKeyBase64(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "test.key")

	id := New(keyPath)
	if err := id.Generate(); err != nil {
		t.Fatalf("Generate() failed: %v", err)
	}

	b64 := id.PublicKeyBase64()

	// Should be valid base64
	decoded, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatalf("PublicKeyBase64() returned invalid base64: %v", err)
	}

	// Decoded should be 32 bytes
	if len(decoded) != ed25519.PublicKeySize {
		t.Errorf("decoded base64 length = %d, want %d", len(decoded), ed25519.PublicKeySize)
	}

	// Should match the raw public key
	pub := id.PublicKey()
	for i := range pub {
		if pub[i] != decoded[i] {
			t.Fatalf("decoded base64 differs from PublicKey() at byte %d", i)
		}
	}
}

func TestSign(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "test.key")

	id := New(keyPath)
	if err := id.Generate(); err != nil {
		t.Fatalf("Generate() failed: %v", err)
	}

	// Sign a 32-byte nonce (simulating a challenge)
	nonce := make([]byte, 32)
	for i := range nonce {
		nonce[i] = byte(i)
	}

	sig := id.Sign(nonce)

	// Verify signature with the public key
	if !ed25519.Verify(id.PublicKey(), nonce, sig) {
		t.Error("signature verification failed")
	}

	// Signature should be 64 bytes (Ed25519 signature size)
	if len(sig) != ed25519.SignatureSize {
		t.Errorf("signature length = %d, want %d", len(sig), ed25519.SignatureSize)
	}
}

func TestSignVerifyAfterReload(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "test.key")

	// Generate and sign
	id1 := New(keyPath)
	if err := id1.Generate(); err != nil {
		t.Fatalf("Generate() failed: %v", err)
	}
	pub := id1.PublicKey()

	// Reload and sign again
	id2 := New(keyPath)
	if err := id2.Load(); err != nil {
		t.Fatalf("Load() failed: %v", err)
	}

	nonce := []byte("this is a 32 byte challenge!!!..")
	sig := id2.Sign(nonce)

	// Verify with original public key
	if !ed25519.Verify(pub, nonce, sig) {
		t.Error("signature from reloaded key failed verification with original public key")
	}
}

func TestLoadNonexistentFile(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "nonexistent.key")

	id := New(keyPath)
	if err := id.Load(); err == nil {
		t.Error("Load() should fail for nonexistent file")
	}
}

func TestLoadInvalidPEM(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "bad.key")

	if err := os.WriteFile(keyPath, []byte("not a PEM file"), 0600); err != nil {
		t.Fatalf("failed to write test file: %v", err)
	}

	id := New(keyPath)
	if err := id.Load(); err == nil {
		t.Error("Load() should fail for invalid PEM data")
	}
}

func TestLoadWrongPEMType(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "wrong.key")

	// Write a PEM block with wrong type
	pemData := "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBALRiMLAHudeSA/x3hB2f+2NRkJLA\n-----END RSA PRIVATE KEY-----\n"
	if err := os.WriteFile(keyPath, []byte(pemData), 0600); err != nil {
		t.Fatalf("failed to write test file: %v", err)
	}

	id := New(keyPath)
	if err := id.Load(); err == nil {
		t.Error("Load() should fail for wrong PEM type")
	}
}

func TestExistsReturnsFalseForMissingFile(t *testing.T) {
	id := New("/tmp/definitely-does-not-exist-12345.key")
	if id.Exists() {
		t.Error("Exists() should be false for missing file")
	}
}
