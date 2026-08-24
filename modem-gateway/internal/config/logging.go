// logging.go configures the global log/slog logger based on LogConfig.
//
// Log levels map to slog as follows:
//
//	error   → slog.LevelError (8)
//	warn    → slog.LevelWarn  (4)
//	info    → slog.LevelInfo  (0)
//	debug   → slog.LevelDebug (-4)
//	verbose → LevelVerbose    (-8), a custom level below Debug
//
// Sensitive information handling:
//
// Callers MUST NOT log pairing secrets, private keys, SIM PINs, or message
// body contents at levels above verbose. Raw AT command exchanges (both
// commands sent and responses received) should only be logged at verbose
// level for debugging purposes. This is enforced at call sites rather than
// by the logging framework itself.
package config

import (
	"fmt"
	"io"
	"log/slog"
	"os"
)

// LevelVerbose is a custom slog level below Debug, used for extremely detailed
// output including raw AT command exchanges and message body contents.
const LevelVerbose = slog.Level(-8)

// levelNames maps configuration string values to slog levels.
var levelNames = map[string]slog.Level{
	"error":   slog.LevelError,
	"warn":    slog.LevelWarn,
	"info":    slog.LevelInfo,
	"debug":   slog.LevelDebug,
	"verbose": LevelVerbose,
}

// SetupLogging configures the global slog logger based on the provided LogConfig.
// If cfg.File is non-empty, log output is written to that file (created or appended).
// Otherwise, output goes to stdout. The configured level acts as the minimum level
// for log output.
//
// Returns the opened file (if any) so the caller can close it during shutdown,
// or nil if logging to stdout.
func SetupLogging(cfg LogConfig) (*os.File, error) {
	level, ok := levelNames[cfg.Level]
	if !ok {
		return nil, fmt.Errorf("unsupported log level %q; valid values: error, warn, info, debug, verbose", cfg.Level)
	}

	var w io.Writer = os.Stdout
	var file *os.File

	if cfg.File != "" {
		f, err := os.OpenFile(cfg.File, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err != nil {
			return nil, fmt.Errorf("failed to open log file %q: %w", cfg.File, err)
		}
		w = f
		file = f
	}

	opts := &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			// Replace the level string for the custom verbose level so it
			// renders as "VERBOSE" instead of "DEBUG-4".
			if a.Key == slog.LevelKey {
				lvl, ok := a.Value.Any().(slog.Level)
				if ok && lvl == LevelVerbose {
					a.Value = slog.StringValue("VERBOSE")
				}
			}
			return a
		},
	}

	handler := slog.NewTextHandler(w, opts)
	slog.SetDefault(slog.New(handler))

	return file, nil
}

// IsVerbose returns true if the given LogConfig has level set to "verbose".
// Callers can use this to decide whether to include sensitive details in log messages.
func IsVerbose(cfg LogConfig) bool {
	return cfg.Level == "verbose"
}
