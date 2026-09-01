// Package config handles YAML configuration file parsing and validation
// for the modem-gateway binary.
package config

import (
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config is the top-level configuration structure for the modem-gateway binary.
type Config struct {
	Connection ConnectionConfig `yaml:"connection"`
	Modem      ModemConfig      `yaml:"modem"`
	TLS        TLSConfig        `yaml:"tls"`
	Log        LogConfig        `yaml:"log"`
}

// ConnectionConfig holds the Svarla signaling WebSocket connection settings.
type ConnectionConfig struct {
	Endpoint      string `yaml:"endpoint"`      // Required: wss://svarla.example/ws/providers/{id}/signaling
	PairingSecret string `yaml:"pairingSecret"` // One-time setup, remove after pairing
}

// ModemConfig holds modem serial port and feature settings.
type ModemConfig struct {
	SerialPort          string `yaml:"serialPort"`          // Required, default: /dev/ttyUSB2
	PhoneNumber         string `yaml:"phoneNumber"`         // E.164 override
	VoiceEnabled        *bool  `yaml:"voiceEnabled"`        // Default: true (pointer to distinguish unset from false)
	PcmAudioPort        string `yaml:"pcmAudioPort"`        // Optional override, auto-detected
	NetworkRegistration bool   `yaml:"networkRegistration"` // Default: false
	SimPin              string `yaml:"simPin"`              // Optional
}

// TLSConfig holds TLS settings for WebSocket connections.
type TLSConfig struct {
	CACert     string `yaml:"caCert"`     // PEM file path
	SkipVerify bool   `yaml:"skipVerify"` // Default: false
}

// LogConfig holds logging configuration.
type LogConfig struct {
	Level string `yaml:"level"` // Default: info
	File  string `yaml:"file"`  // Optional, empty = stdout
}

// validLogLevels defines the accepted log level values.
var validLogLevels = map[string]bool{
	"error":   true,
	"warn":    true,
	"info":    true,
	"debug":   true,
	"verbose": true,
}

// Load reads and parses the YAML configuration file at the given path,
// validates required fields, and applies defaults.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("configuration file not found at %q\nRun with --generate-config to create a default configuration file", path)
		}
		return nil, fmt.Errorf("failed to read configuration file: %w", err)
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("invalid configuration syntax: %w", err)
	}

	applyDefaults(&cfg)

	if err := validate(&cfg); err != nil {
		return nil, err
	}

	return &cfg, nil
}

// applyDefaults fills in default values for optional fields that were not set.
func applyDefaults(cfg *Config) {
	if cfg.Modem.SerialPort == "" {
		cfg.Modem.SerialPort = "/dev/ttyUSB2"
	}

	if cfg.Modem.VoiceEnabled == nil {
		t := true
		cfg.Modem.VoiceEnabled = &t
	}

	if cfg.Log.Level == "" {
		cfg.Log.Level = "info"
	}
}

// validate checks required fields and valid values. Returns a descriptive
// error if validation fails.
func validate(cfg *Config) error {
	var errs []string

	if strings.TrimSpace(cfg.Connection.Endpoint) == "" {
		errs = append(errs, "connection.endpoint is required: set the Svarla signaling WebSocket URL (e.g., wss://svarla.example/ws/providers/<id>/signaling)")
	}

	if strings.TrimSpace(cfg.Modem.SerialPort) == "" {
		errs = append(errs, "modem.serialPort is required: set the AT command serial port device path (e.g., /dev/ttyUSB2)")
	}

	if !validLogLevels[cfg.Log.Level] {
		errs = append(errs, fmt.Sprintf("log.level must be one of: error, warn, info, debug, verbose (got %q)", cfg.Log.Level))
	}

	if len(errs) > 0 {
		return fmt.Errorf("configuration validation failed:\n  - %s", strings.Join(errs, "\n  - "))
	}

	return nil
}

// GenerateDefault writes a default configuration file at the given path.
// The file includes commented explanations for all available options.
func GenerateDefault(path string) error {
	const defaultConfig = `# modem-gateway configuration file
# See documentation for all available options.

connection:
  # Required: Svarla signaling WebSocket endpoint URL.
  # Format: wss://<svarla-host>/ws/providers/<provider-id>/signaling
  endpoint: ""

  # One-time pairing secret from Svarla provider creation.
  # Remove this line after successful pairing.
  pairingSecret: ""

modem:
  # Required: AT command serial port device path.
  serialPort: "/dev/ttyUSB2"

  # Optional: Phone number in E.164 format (e.g., +15551234567).
  # Used as fallback if AT+CNUM does not return a number.
  # phoneNumber: ""

  # Enable voice calls (default: true).
  voiceEnabled: true

  # Optional: PCM audio serial port device path.
  # Auto-detected from modem USB interfaces if not specified.
  # pcmAudioPort: "/dev/ttyUSB1"

  # Enable self-managed network registration (default: false).
  # When false, assumes host OS handles cellular registration.
  networkRegistration: false

  # Optional: SIM PIN for automatic unlock.
  # simPin: ""

tls:
  # Optional: Path to custom CA certificate in PEM format.
  # caCert: ""

  # Skip TLS certificate verification (default: false).
  # WARNING: Only use for development/testing.
  skipVerify: false

log:
  # Log level: error, warn, info, debug, verbose (default: info).
  level: "info"

  # Optional: Log to file instead of stdout.
  # file: "/var/log/modem-gateway.log"
`

	return os.WriteFile(path, []byte(defaultConfig), 0644)
}

// IsVoiceEnabled returns whether voice calls are enabled.
// This is a convenience method since VoiceEnabled is a pointer
// to distinguish unset (default true) from explicit false.
func (c *Config) IsVoiceEnabled() bool {
	if c.Modem.VoiceEnabled == nil {
		return true
	}
	return *c.Modem.VoiceEnabled
}
