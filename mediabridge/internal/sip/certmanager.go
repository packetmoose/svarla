package sip

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"os"
	"sync"
	"time"
)

// CertManagerConfig holds configuration for the Certificate Manager.
type CertManagerConfig struct {
	CertPath string // Path to PEM-encoded certificate file
	KeyPath  string // Path to PEM-encoded private key file
}

// CertManager manages TLS certificates for the SIP TLS listener.
type CertManager struct {
	cfg        CertManagerConfig
	logger     *slog.Logger
	mu         sync.RWMutex
	current    *tls.Certificate
	lastMod    time.Time // kept for backward compat; prefer lastCertMod/lastKeyMod
	lastCertMod time.Time
	lastKeyMod  time.Time
	ctx        context.Context
	cancel     context.CancelFunc
}

// NewCertManager creates a CertManager that loads certs from configured paths.
func NewCertManager(cfg CertManagerConfig, logger *slog.Logger) *CertManager {
	ctx, cancel := context.WithCancel(context.Background())
	return &CertManager{
		cfg:    cfg,
		logger: logger,
		ctx:    ctx,
		cancel: cancel,
	}
}

// LoadOrGenerate loads the configured cert/key or generates a self-signed fallback.
// Returns an error only if the self-signed generation itself fails (fatal).
func (cm *CertManager) LoadOrGenerate() error {
	cert, err := cm.loadFromFiles()
	if err == nil {
		cm.mu.Lock()
		cm.current = cert
		cm.mu.Unlock()
		cm.logger.Info("TLS certificate loaded from files",
			"certPath", cm.cfg.CertPath,
			"keyPath", cm.cfg.KeyPath,
		)
		return nil
	}

	// Log the reason we're falling back to self-signed.
	cm.logger.Warn("falling back to self-signed certificate",
		"reason", err.Error(),
	)

	selfSigned, genErr := cm.generateSelfSigned()
	if genErr != nil {
		return fmt.Errorf("failed to generate self-signed certificate: %w", genErr)
	}

	cm.mu.Lock()
	cm.current = selfSigned
	cm.mu.Unlock()

	cm.logger.Warn("using self-signed certificate; mount a trusted certificate for production")
	return nil
}

// GetCertificate returns the current certificate for use in tls.Config.GetCertificate.
func (cm *CertManager) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	cm.mu.RLock()
	defer cm.mu.RUnlock()

	if cm.current == nil {
		return nil, errors.New("no certificate loaded")
	}
	return cm.current, nil
}

// StartWatching begins polling for certificate file changes.
// It polls every 30 seconds, waits 2 seconds for stabilization after detecting
// a change, then validates and loads the new cert+key pair.
func (cm *CertManager) StartWatching(ctx context.Context) {
	// Initialize last known mod times from current files.
	cm.initModTimes()

	go cm.watchLoop(ctx)
}

// initModTimes records the current modification times for cert and key files.
func (cm *CertManager) initModTimes() {
	if info, err := os.Stat(cm.cfg.CertPath); err == nil {
		cm.lastCertMod = info.ModTime()
	}
	if info, err := os.Stat(cm.cfg.KeyPath); err == nil {
		cm.lastKeyMod = info.ModTime()
	}
}

// watchLoop is the main polling loop that checks for certificate file changes.
func (cm *CertManager) watchLoop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-cm.ctx.Done():
			return
		case <-ticker.C:
			cm.checkForChanges(ctx)
		}
	}
}

// checkForChanges checks if cert or key files have been modified and triggers a reload.
func (cm *CertManager) checkForChanges(ctx context.Context) {
	certChanged := false
	keyChanged := false

	if info, err := os.Stat(cm.cfg.CertPath); err == nil {
		if !info.ModTime().Equal(cm.lastCertMod) {
			certChanged = true
		}
	}

	if info, err := os.Stat(cm.cfg.KeyPath); err == nil {
		if !info.ModTime().Equal(cm.lastKeyMod) {
			keyChanged = true
		}
	}

	if !certChanged && !keyChanged {
		return
	}

	cm.logger.Info("certificate file change detected, waiting for stabilization",
		"certChanged", certChanged,
		"keyChanged", keyChanged,
	)

	// Stabilization debounce: wait 2 seconds for both files to finish writing.
	select {
	case <-time.After(2 * time.Second):
	case <-ctx.Done():
		return
	case <-cm.ctx.Done():
		return
	}

	cm.reloadCertificate()
}

// reloadCertificate attempts to load the new cert+key pair and update the current certificate.
func (cm *CertManager) reloadCertificate() {
	cert, err := cm.loadFromFiles()
	if err != nil {
		cm.logger.Error("certificate hot-reload failed, retaining previous certificate",
			"error", err.Error(),
		)
		// Update mod times even on failure to avoid repeated reload attempts
		// for the same broken file.
		cm.updateModTimes()
		return
	}

	// Parse the leaf certificate for logging.
	leaf, parseErr := x509.ParseCertificate(cert.Certificate[0])
	if parseErr != nil {
		cm.logger.Error("certificate hot-reload failed: cannot parse leaf certificate",
			"error", parseErr.Error(),
		)
		cm.updateModTimes()
		return
	}

	cm.mu.Lock()
	cm.current = cert
	cm.mu.Unlock()

	cm.updateModTimes()

	cm.logger.Info("certificate hot-reload successful",
		"subject", leaf.Subject.CommonName,
		"expiry", leaf.NotAfter.Format(time.RFC3339),
	)
}

// updateModTimes refreshes the stored modification times from the current file state.
func (cm *CertManager) updateModTimes() {
	if info, err := os.Stat(cm.cfg.CertPath); err == nil {
		cm.lastCertMod = info.ModTime()
	}
	if info, err := os.Stat(cm.cfg.KeyPath); err == nil {
		cm.lastKeyMod = info.ModTime()
	}
}

// Stop halts the file watcher.
func (cm *CertManager) Stop() {
	cm.cancel()
}

// loadFromFiles attempts to load and validate a cert+key pair from the configured paths.
func (cm *CertManager) loadFromFiles() (*tls.Certificate, error) {
	certPEM, err := os.ReadFile(cm.cfg.CertPath)
	if err != nil {
		return nil, fmt.Errorf("reading certificate file: %w", err)
	}

	keyPEM, err := os.ReadFile(cm.cfg.KeyPath)
	if err != nil {
		return nil, fmt.Errorf("reading key file: %w", err)
	}

	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		cm.logger.Error("failed to parse certificate/key pair", "error", err)
		return nil, fmt.Errorf("parsing certificate/key pair: %w", err)
	}

	// Validate that the private key corresponds to the certificate's public key.
	if err := validateKeyPair(&cert); err != nil {
		cm.logger.Error("certificate and private key do not match", "error", err)
		return nil, fmt.Errorf("key mismatch: %w", err)
	}

	// Record modification time for hot-reload tracking.
	info, err := os.Stat(cm.cfg.CertPath)
	if err == nil {
		cm.lastMod = info.ModTime()
		cm.lastCertMod = info.ModTime()
	}
	if keyInfo, keyErr := os.Stat(cm.cfg.KeyPath); keyErr == nil {
		cm.lastKeyMod = keyInfo.ModTime()
	}

	return &cert, nil
}

// validateKeyPair verifies that the private key in the certificate corresponds
// to the certificate's public key.
func validateKeyPair(cert *tls.Certificate) error {
	if len(cert.Certificate) == 0 {
		return errors.New("certificate chain is empty")
	}

	x509Cert, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return fmt.Errorf("parsing x509 certificate: %w", err)
	}

	switch pub := x509Cert.PublicKey.(type) {
	case *rsa.PublicKey:
		priv, ok := cert.PrivateKey.(*rsa.PrivateKey)
		if !ok {
			return errors.New("private key type does not match certificate (expected RSA)")
		}
		if pub.N.Cmp(priv.N) != 0 {
			return errors.New("RSA private key does not match certificate public key")
		}
	case *ecdsa.PublicKey:
		priv, ok := cert.PrivateKey.(*ecdsa.PrivateKey)
		if !ok {
			return errors.New("private key type does not match certificate (expected ECDSA)")
		}
		if pub.X.Cmp(priv.X) != 0 || pub.Y.Cmp(priv.Y) != 0 {
			return errors.New("ECDSA private key does not match certificate public key")
		}
	default:
		return fmt.Errorf("unsupported public key type: %T", pub)
	}

	return nil
}

// generateSelfSigned generates a self-signed TLS certificate using ECDSA P-256.
// The certificate has EKU ServerAuth, SAN "localhost" + IP 127.0.0.1, and 365-day validity.
// A fresh certificate is generated on each call (no persistence).
func (cm *CertManager) generateSelfSigned() (*tls.Certificate, error) {
	// Generate ECDSA P-256 key pair.
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generating ECDSA P-256 key: %w", err)
	}

	// Generate a random serial number.
	serialNumber, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("generating serial number: %w", err)
	}

	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			CommonName: "mediabridge-self-signed",
		},
		NotBefore:             now,
		NotAfter:              now.Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"localhost"},
		IPAddresses:           []net.IP{net.IPv4(127, 0, 0, 1)},
	}

	// Create the self-signed certificate (issuer == subject).
	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &privateKey.PublicKey, privateKey)
	if err != nil {
		return nil, fmt.Errorf("creating self-signed certificate: %w", err)
	}

	// Encode to PEM and construct tls.Certificate.
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyDER, err := x509.MarshalECPrivateKey(privateKey)
	if err != nil {
		return nil, fmt.Errorf("marshaling ECDSA private key: %w", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	tlsCert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("creating TLS certificate from generated PEM: %w", err)
	}

	return &tlsCert, nil
}
