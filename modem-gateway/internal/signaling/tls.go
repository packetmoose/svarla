package signaling

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"

	"github.com/packetmoose/svarla/modem-gateway/internal/config"
)

// BuildTLSConfig constructs a *tls.Config from the application's TLS settings.
// Returns nil if no custom TLS configuration is needed (default system roots, verification enabled).
func BuildTLSConfig(cfg config.TLSConfig) (*tls.Config, error) {
	// If no custom settings, return nil to use Go's default TLS behavior.
	if cfg.CACert == "" && !cfg.SkipVerify {
		return nil, nil
	}

	tlsConfig := &tls.Config{
		InsecureSkipVerify: cfg.SkipVerify, //nolint:gosec // user-configured for dev/testing
	}

	if cfg.CACert != "" {
		caCert, err := os.ReadFile(cfg.CACert)
		if err != nil {
			return nil, fmt.Errorf("failed to read CA certificate file %q: %w", cfg.CACert, err)
		}

		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caCert) {
			return nil, fmt.Errorf("failed to parse CA certificate from %q: no valid PEM certificates found", cfg.CACert)
		}

		tlsConfig.RootCAs = pool
	}

	return tlsConfig, nil
}
