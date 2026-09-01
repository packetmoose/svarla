package config

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSetupLogging_DefaultStdout(t *testing.T) {
	cfg := LogConfig{Level: "info"}
	file, err := SetupLogging(cfg)
	if err != nil {
		t.Fatalf("SetupLogging returned error: %v", err)
	}
	if file != nil {
		file.Close()
		t.Fatal("Expected nil file for stdout logging")
	}

	// Verify the default logger is enabled at info level.
	if !slog.Default().Enabled(nil, slog.LevelInfo) {
		t.Error("Expected info level to be enabled")
	}
	if slog.Default().Enabled(nil, slog.LevelDebug) {
		t.Error("Expected debug level to be disabled at info level")
	}
}

func TestSetupLogging_AllLevels(t *testing.T) {
	tests := []struct {
		level       string
		enabledAt   slog.Level
		disabledAt  slog.Level
	}{
		{"error", slog.LevelError, slog.LevelWarn},
		{"warn", slog.LevelWarn, slog.LevelInfo},
		{"info", slog.LevelInfo, slog.LevelDebug},
		{"debug", slog.LevelDebug, LevelVerbose},
		{"verbose", LevelVerbose, slog.Level(-12)},
	}

	for _, tt := range tests {
		t.Run(tt.level, func(t *testing.T) {
			cfg := LogConfig{Level: tt.level}
			file, err := SetupLogging(cfg)
			if err != nil {
				t.Fatalf("SetupLogging(%q) returned error: %v", tt.level, err)
			}
			if file != nil {
				file.Close()
			}

			if !slog.Default().Enabled(nil, tt.enabledAt) {
				t.Errorf("Expected level %v to be enabled at %q", tt.enabledAt, tt.level)
			}
			if slog.Default().Enabled(nil, tt.disabledAt) {
				t.Errorf("Expected level %v to be disabled at %q", tt.disabledAt, tt.level)
			}
		})
	}
}

func TestSetupLogging_InvalidLevel(t *testing.T) {
	cfg := LogConfig{Level: "trace"}
	file, err := SetupLogging(cfg)
	if err == nil {
		if file != nil {
			file.Close()
		}
		t.Fatal("Expected error for invalid log level")
	}
	if !strings.Contains(err.Error(), "unsupported log level") {
		t.Errorf("Expected 'unsupported log level' in error, got: %v", err)
	}
}

func TestSetupLogging_FileOutput(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "test.log")

	cfg := LogConfig{Level: "info", File: logPath}
	file, err := SetupLogging(cfg)
	if err != nil {
		t.Fatalf("SetupLogging returned error: %v", err)
	}
	if file == nil {
		t.Fatal("Expected non-nil file for file logging")
	}
	defer file.Close()

	// Log a message and verify it appears in the file.
	slog.Info("test message", "key", "value")

	// Close and read the file.
	file.Close()
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("Failed to read log file: %v", err)
	}

	content := string(data)
	if !strings.Contains(content, "test message") {
		t.Errorf("Expected log file to contain 'test message', got: %s", content)
	}
	if !strings.Contains(content, "key=value") {
		t.Errorf("Expected log file to contain 'key=value', got: %s", content)
	}
}

func TestSetupLogging_FileOutputAppends(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "test.log")

	// Write some existing content.
	if err := os.WriteFile(logPath, []byte("existing line\n"), 0644); err != nil {
		t.Fatal(err)
	}

	cfg := LogConfig{Level: "info", File: logPath}
	file, err := SetupLogging(cfg)
	if err != nil {
		t.Fatalf("SetupLogging returned error: %v", err)
	}
	defer file.Close()

	slog.Info("appended message")
	file.Close()

	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}

	content := string(data)
	if !strings.Contains(content, "existing line") {
		t.Error("Expected existing content to be preserved")
	}
	if !strings.Contains(content, "appended message") {
		t.Error("Expected appended log message")
	}
}

func TestSetupLogging_InvalidFilePath(t *testing.T) {
	cfg := LogConfig{Level: "info", File: "/nonexistent/path/that/should/fail/log.txt"}
	file, err := SetupLogging(cfg)
	if err == nil {
		if file != nil {
			file.Close()
		}
		t.Fatal("Expected error for invalid file path")
	}
	if !strings.Contains(err.Error(), "failed to open log file") {
		t.Errorf("Expected 'failed to open log file' in error, got: %v", err)
	}
}

func TestSetupLogging_VerboseLevelLabel(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "verbose.log")

	cfg := LogConfig{Level: "verbose", File: logPath}
	file, err := SetupLogging(cfg)
	if err != nil {
		t.Fatalf("SetupLogging returned error: %v", err)
	}
	defer file.Close()

	// Log at verbose level.
	slog.Log(nil, LevelVerbose, "verbose detail")
	file.Close()

	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}

	content := string(data)
	if !strings.Contains(content, "VERBOSE") {
		t.Errorf("Expected 'VERBOSE' level label in output, got: %s", content)
	}
	if !strings.Contains(content, "verbose detail") {
		t.Errorf("Expected 'verbose detail' message, got: %s", content)
	}
}

func TestIsVerbose(t *testing.T) {
	if !IsVerbose(LogConfig{Level: "verbose"}) {
		t.Error("Expected IsVerbose to return true for 'verbose'")
	}
	if IsVerbose(LogConfig{Level: "debug"}) {
		t.Error("Expected IsVerbose to return false for 'debug'")
	}
	if IsVerbose(LogConfig{Level: "info"}) {
		t.Error("Expected IsVerbose to return false for 'info'")
	}
}

func TestLevelVerboseConstant(t *testing.T) {
	// Verify verbose is below debug.
	if LevelVerbose >= slog.LevelDebug {
		t.Errorf("LevelVerbose (%d) should be below slog.LevelDebug (%d)", LevelVerbose, slog.LevelDebug)
	}
}
