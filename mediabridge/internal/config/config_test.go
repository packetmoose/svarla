package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDefaults(t *testing.T) {
	cfg := Defaults()

	if cfg.WebRTC.Port != 10443 {
		t.Errorf("expected WebRTC.Port 10443, got %d", cfg.WebRTC.Port)
	}
	if cfg.Server.ControlPort != 9090 {
		t.Errorf("expected Server.ControlPort 9090, got %d", cfg.Server.ControlPort)
	}
	if cfg.SIP.Port != 5060 {
		t.Errorf("expected SIP.Port 5060, got %d", cfg.SIP.Port)
	}
	if cfg.SIP.MediaPort != 5062 {
		t.Errorf("expected SIP.MediaPort 5062, got %d", cfg.SIP.MediaPort)
	}
	if cfg.SIP.TLS.Port != 5061 {
		t.Errorf("expected SIP.TLS.Port 5061, got %d", cfg.SIP.TLS.Port)
	}
	if cfg.AudioWS.Port != 9091 {
		t.Errorf("expected AudioWS.Port 9091, got %d", cfg.AudioWS.Port)
	}
	if cfg.Network.PublicIP != "127.0.0.1" {
		t.Errorf("expected Network.PublicIP 127.0.0.1, got %s", cfg.Network.PublicIP)
	}
	if cfg.Log.JSON != false {
		t.Errorf("expected Log.JSON false, got %v", cfg.Log.JSON)
	}
	if cfg.Log.Level != "info" {
		t.Errorf("expected Log.Level info, got %s", cfg.Log.Level)
	}
}

func TestLoad(t *testing.T) {
	content := []byte(`
webrtc:
  port: 9999
server:
  controlPort: 8080
network:
  publicIp: "203.0.113.1"
log:
  level: "debug"
  json: true
`)
	dir := t.TempDir()
	path := filepath.Join(dir, "test-config.yaml")
	if err := os.WriteFile(path, content, 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cfg.WebRTC.Port != 9999 {
		t.Errorf("expected WebRTC.Port 9999, got %d", cfg.WebRTC.Port)
	}
	if cfg.Server.ControlPort != 8080 {
		t.Errorf("expected Server.ControlPort 8080, got %d", cfg.Server.ControlPort)
	}
	if cfg.Network.PublicIP != "203.0.113.1" {
		t.Errorf("expected Network.PublicIP 203.0.113.1, got %s", cfg.Network.PublicIP)
	}
	// Unspecified fields should retain defaults.
	if cfg.SIP.Port != 5060 {
		t.Errorf("expected SIP.Port to default to 5060, got %d", cfg.SIP.Port)
	}
	if cfg.Log.Level != "debug" {
		t.Errorf("expected Log.Level debug, got %s", cfg.Log.Level)
	}
	if cfg.Log.JSON != true {
		t.Errorf("expected Log.JSON true, got %v", cfg.Log.JSON)
	}
}

func TestLoadMissingFile(t *testing.T) {
	cfg, err := Load("/nonexistent/path/config.yaml")
	if err == nil {
		t.Fatal("expected error for missing file")
	}
	// Should still return defaults.
	if cfg.WebRTC.Port != 10443 {
		t.Errorf("expected defaults on error, got WebRTC.Port %d", cfg.WebRTC.Port)
	}
}
