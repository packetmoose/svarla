// Package config provides configuration loading for the MediaBridge.
package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// Config holds all configuration for the MediaBridge process.
type Config struct {
	WebRTC  WebRTCConfig  `yaml:"webrtc"`
	Server  ServerConfig  `yaml:"server"`
	Network NetworkConfig `yaml:"network"`
	SIP     SIPConfig     `yaml:"sip"`
	AudioWS AudioWSConfig `yaml:"audioWs"`
	Audio   AudioConfig   `yaml:"audio"`
	Log     LogConfig     `yaml:"log"`
}

// WebRTCConfig holds WebRTC-related settings.
type WebRTCConfig struct {
	Port int `yaml:"port"` // TCP port for WebRTC connections, default 10443
}

// ServerConfig holds control server settings.
type ServerConfig struct {
	ControlPort int `yaml:"controlPort"` // HTTP port for ControlAPI, default 9090
}

// NetworkConfig holds network identity settings.
type NetworkConfig struct {
	PublicIP string `yaml:"publicIp"` // Public IP for ICE/SDP, default "127.0.0.1"
}

// SIPConfig holds SIP-related configuration.
type SIPConfig struct {
	Port      int       `yaml:"port"`      // SIP signaling port (UDP+TCP), default 5060
	MediaPort int       `yaml:"mediaPort"` // RTP media port, default 5062
	TLS       TLSConfig `yaml:"tls"`       // SIP-over-TLS settings

	// AllowedIPs is the list of provider IPs or CIDRs allowed to send SIP.
	// If empty, all IPs are allowed (open mode).
	AllowedIPs []string `yaml:"allowedIps"`
}

// TLSConfig holds TLS-specific configuration for SIPS.
type TLSConfig struct {
	Port     int    `yaml:"port"`     // TLS listen port, default 5061
	CertPath string `yaml:"certPath"` // Path to cert PEM
	KeyPath  string `yaml:"keyPath"`  // Path to key PEM
}

// AudioWSConfig holds audio WebSocket settings.
type AudioWSConfig struct {
	Port int `yaml:"port"` // WebSocket port for provider audio streams, default 9091
}

// AudioConfig holds audio-related settings.
type AudioConfig struct {
	RingbackCadence string `yaml:"ringbackCadence"` // "eu" or "us"
	SIPCodec        string `yaml:"sipCodec"`        // "g711_ulaw" or "opus"
}

// LogConfig holds logging configuration.
type LogConfig struct {
	Level string `yaml:"level"` // "debug", "info", "warn", "error"
	JSON  bool   `yaml:"json"`  // true for JSON, false for human-readable text
}

// Defaults returns a Config with sensible defaults.
func Defaults() Config {
	return Config{
		WebRTC: WebRTCConfig{
			Port: 10443,
		},
		Server: ServerConfig{
			ControlPort: 9090,
		},
		Network: NetworkConfig{
			PublicIP: "127.0.0.1",
		},
		SIP: SIPConfig{
			Port:      5060,
			MediaPort: 5062,
			TLS: TLSConfig{
				Port:     5061,
				CertPath: "/etc/mediabridge/tls/cert.pem",
				KeyPath:  "/etc/mediabridge/tls/key.pem",
			},
		},
		AudioWS: AudioWSConfig{
			Port: 9091,
		},
		Audio: AudioConfig{
			RingbackCadence: "eu",
			SIPCodec:        "g711_ulaw",
		},
		Log: LogConfig{
			Level: "info",
			JSON:  false,
		},
	}
}

// Load reads configuration from the given YAML file path.
// Missing fields retain their default values.
func Load(path string) (Config, error) {
	cfg := Defaults()

	data, err := os.ReadFile(path)
	if err != nil {
		return cfg, fmt.Errorf("reading config file %s: %w", path, err)
	}

	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("parsing config file %s: %w", path, err)
	}

	// Treat empty TLS paths as absent — fall back to defaults.
	defaults := Defaults()
	if cfg.SIP.TLS.CertPath == "" {
		cfg.SIP.TLS.CertPath = defaults.SIP.TLS.CertPath
	}
	if cfg.SIP.TLS.KeyPath == "" {
		cfg.SIP.TLS.KeyPath = defaults.SIP.TLS.KeyPath
	}

	// Environment variable overrides.
	if ip := os.Getenv("PUBLIC_IP"); ip != "" {
		cfg.Network.PublicIP = ip
	}
	if lvl := os.Getenv("LOG_LEVEL"); lvl != "" {
		cfg.Log.Level = lvl
	}

	if err := cfg.Validate(); err != nil {
		return cfg, err
	}

	return cfg, nil
}

// Validate checks the configuration for invalid values.
func (c *Config) Validate() error {
	if c.SIP.TLS.Port < 1 || c.SIP.TLS.Port > 65535 {
		return fmt.Errorf("invalid SIP TLS port %d: must be in range [1, 65535]", c.SIP.TLS.Port)
	}
	if c.SIP.TLS.Port == c.SIP.Port {
		return fmt.Errorf("SIP TLS port %d conflicts with SIP port", c.SIP.TLS.Port)
	}
	return nil
}
