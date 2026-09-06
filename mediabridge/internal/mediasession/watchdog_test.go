package mediasession

import (
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// newWatchdogTestSession builds a MediaSession wired only for exercising the
// provider-RTP-inactivity watchdog in isolation (no real RTP listener or audio
// bridge). It runs the watchdog goroutine directly rather than via Start().
func newWatchdogTestSession(timeout, interval time.Duration, onTimeout func()) *MediaSession {
	ms := &MediaSession{
		sessionID: "test-session",
		logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		config: Config{
			SessionID:          "test-session",
			ProviderRTPTimeout: timeout,
			OnProviderTimeout:  onTimeout,
		},
		watchdogInterval: interval,
		watchdogStop:     make(chan struct{}),
	}
	return ms
}

func TestProviderRTPWatchdog_FiresAfterTimeout(t *testing.T) {
	var fired atomic.Int32
	done := make(chan struct{}, 1)

	ms := newWatchdogTestSession(60*time.Millisecond, 10*time.Millisecond, func() {
		fired.Add(1)
		select {
		case done <- struct{}{}:
		default:
		}
	})

	// Seed liveness "now" — no further packets will arrive, so the watchdog
	// should fire after the timeout elapses.
	ms.lastProviderRTP.Store(time.Now().UnixNano())

	ms.watchdogWg.Add(1)
	go ms.providerRTPWatchdog()

	select {
	case <-done:
		// good
	case <-time.After(2 * time.Second):
		t.Fatal("watchdog did not fire OnProviderTimeout within 2s")
	}

	ms.watchdogWg.Wait() // goroutine should have returned after firing

	if got := fired.Load(); got != 1 {
		t.Fatalf("expected OnProviderTimeout to fire exactly once, got %d", got)
	}
}

func TestProviderRTPWatchdog_DoesNotFireWhilePacketsArrive(t *testing.T) {
	var fired atomic.Int32

	ms := newWatchdogTestSession(60*time.Millisecond, 10*time.Millisecond, func() {
		fired.Add(1)
	})

	ms.lastProviderRTP.Store(time.Now().UnixNano())

	ms.watchdogWg.Add(1)
	go ms.providerRTPWatchdog()

	// Simulate steady provider RTP by refreshing the timestamp faster than the
	// timeout for a period comfortably longer than the timeout itself.
	stop := time.After(300 * time.Millisecond)
	tick := time.NewTicker(15 * time.Millisecond)
	defer tick.Stop()
	var stopRefresh bool
	for !stopRefresh {
		select {
		case <-tick.C:
			ms.lastProviderRTP.Store(time.Now().UnixNano())
		case <-stop:
			stopRefresh = true
		}
	}

	if got := fired.Load(); got != 0 {
		t.Fatalf("watchdog fired despite continuous RTP (fired=%d)", got)
	}

	// Stop the watchdog cleanly.
	ms.timeoutFired.Store(true)
	close(ms.watchdogStop)
	ms.watchdogWg.Wait()
}

func TestProviderRTPWatchdog_DoesNotFireAfterStop(t *testing.T) {
	var fired atomic.Int32
	var once sync.Once

	ms := newWatchdogTestSession(60*time.Millisecond, 10*time.Millisecond, func() {
		fired.Add(1)
	})

	ms.lastProviderRTP.Store(time.Now().UnixNano())

	ms.watchdogWg.Add(1)
	go ms.providerRTPWatchdog()

	// Immediately simulate Stop()'s guard: mark fired and signal stop before the
	// timeout elapses. The watchdog must exit without invoking the callback.
	once.Do(func() {
		ms.timeoutFired.Store(true)
		close(ms.watchdogStop)
	})

	ms.watchdogWg.Wait()

	// Give any errant goroutine a moment; none should call the callback.
	time.Sleep(120 * time.Millisecond)
	if got := fired.Load(); got != 0 {
		t.Fatalf("watchdog fired after stop (fired=%d)", got)
	}
}
