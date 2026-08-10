// Package logging provides structured logging for the MediaBridge.
package logging

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"
)

// Setup initializes the global slog logger with the given level and format.
// Output is always written to stdout.
func Setup(level, format string) *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn", "warning":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}

	opts := &slog.HandlerOptions{
		Level: lvl,
	}

	var handler slog.Handler
	if strings.ToLower(format) == "json" {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	} else {
		handler = &prettyHandler{w: os.Stdout, level: lvl}
	}

	logger := slog.New(handler)
	slog.SetDefault(logger)
	return logger
}

// prettyHandler outputs logs in a human-readable format similar to pino-pretty:
// [HH:MM:SS.mmm] LEVEL: message key=value key=value
type prettyHandler struct {
	w     io.Writer
	level slog.Level
	mu    sync.Mutex
	attrs []slog.Attr
	group string
}

func (h *prettyHandler) Enabled(_ context.Context, level slog.Level) bool {
	return level >= h.level
}

func (h *prettyHandler) Handle(_ context.Context, r slog.Record) error {
	timestamp := r.Time.Format("15:04:05.000")
	level := levelString(r.Level)

	var b strings.Builder
	b.WriteString(fmt.Sprintf("[%s] %s: %s", timestamp, level, r.Message))

	// Pre-set attrs from WithAttrs
	for _, a := range h.attrs {
		writeAttr(&b, h.group, a)
	}

	// Record attrs
	r.Attrs(func(a slog.Attr) bool {
		writeAttr(&b, h.group, a)
		return true
	})

	b.WriteByte('\n')

	h.mu.Lock()
	defer h.mu.Unlock()
	_, err := io.WriteString(h.w, b.String())
	return err
}

func (h *prettyHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	newAttrs := make([]slog.Attr, len(h.attrs), len(h.attrs)+len(attrs))
	copy(newAttrs, h.attrs)
	newAttrs = append(newAttrs, attrs...)
	return &prettyHandler{w: h.w, level: h.level, attrs: newAttrs, group: h.group}
}

func (h *prettyHandler) WithGroup(name string) slog.Handler {
	prefix := name
	if h.group != "" {
		prefix = h.group + "." + name
	}
	newAttrs := make([]slog.Attr, len(h.attrs))
	copy(newAttrs, h.attrs)
	return &prettyHandler{w: h.w, level: h.level, attrs: newAttrs, group: prefix}
}

func writeAttr(b *strings.Builder, group string, a slog.Attr) {
	if a.Equal(slog.Attr{}) {
		return
	}
	key := a.Key
	if group != "" {
		key = group + "." + key
	}
	b.WriteString(fmt.Sprintf(" %s=%v", key, a.Value))
}

func levelString(l slog.Level) string {
	switch {
	case l >= slog.LevelError:
		return "ERROR"
	case l >= slog.LevelWarn:
		return "WARN"
	case l >= slog.LevelInfo:
		return "INFO"
	default:
		return "DEBUG"
	}
}

// FormatDuration formats a duration as a human-readable string for log output.
func FormatDuration(d time.Duration) string {
	if d < time.Second {
		return fmt.Sprintf("%dms", d.Milliseconds())
	}
	return fmt.Sprintf("%.1fs", d.Seconds())
}
