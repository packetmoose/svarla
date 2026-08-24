package modem

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"
)

// Reconnection backoff parameters.
const (
	reconnectBackoffMin = 2 * time.Second
	reconnectBackoffMax = 30 * time.Second

	// healthCheckInterval is how often we probe the modem with a simple AT command.
	healthCheckInterval = 10 * time.Second
	// healthCheckTimeout is how long we wait for the modem to respond before
	// declaring it unresponsive (matches requirement 11.1: 10 seconds).
	healthCheckTimeout = 10 * time.Second
)

// ErrModemUnavailable is returned when an operation is attempted while
// the modem is disconnected or unresponsive.
var ErrModemUnavailable = errors.New("modem: device unavailable")

// ReconnectCallbacks holds the callbacks invoked on modem connect/disconnect events.
type ReconnectCallbacks struct {
	// OnConnected is called when the modem is recovered and reinitialized.
	// It should notify Svarla of "modem_connected" status.
	OnConnected func()
	// OnDisconnected is called when the modem is detected as unavailable.
	// It should notify Svarla of "modem_disconnected" status.
	OnDisconnected func()
	// OnCallLost is called when the modem is lost during an active call.
	// The caller should close the audio WebSocket and report COMPLETED with "modem_lost" reason.
	OnCallLost func()
}

// ReconnectManager monitors modem health and handles automatic reconnection
// with exponential backoff when the modem becomes unavailable (USB disconnect,
// unresponsive device, etc.).
type ReconnectManager struct {
	serialPortPath string
	pcmPortPath    string
	callbacks      ReconnectCallbacks

	mu        sync.RWMutex
	available bool
	modem     *Modem
	sm        *StateMachine

	cancel context.CancelFunc
	done   chan struct{}
}

// NewReconnectManager creates a ReconnectManager that monitors the modem at
// the given serial port path and invokes callbacks on state changes.
//
// The pcmPortPath is optional; if non-empty, the PCM audio port will be
// reopened on reconnection (the actual PCM port management is handled by
// the audio pipeline, but the reconnect manager needs to know the path
// for validation).
func NewReconnectManager(serialPortPath, pcmPortPath string, callbacks ReconnectCallbacks) *ReconnectManager {
	return &ReconnectManager{
		serialPortPath: serialPortPath,
		pcmPortPath:    pcmPortPath,
		callbacks:      callbacks,
		done:           make(chan struct{}),
	}
}

// IsAvailable returns true if the modem is connected and operational.
// Returns false while the modem is disconnected or during reconnection.
func (rm *ReconnectManager) IsAvailable() bool {
	rm.mu.RLock()
	defer rm.mu.RUnlock()
	return rm.available
}

// Modem returns the current Modem instance, or nil if unavailable.
func (rm *ReconnectManager) Modem() *Modem {
	rm.mu.RLock()
	defer rm.mu.RUnlock()
	return rm.modem
}

// StateMachine returns the state machine managed by the reconnect manager.
func (rm *ReconnectManager) StateMachine() *StateMachine {
	rm.mu.RLock()
	defer rm.mu.RUnlock()
	return rm.sm
}

// Start begins the health monitoring loop. It performs initial connection
// and then monitors the modem for failures, reconnecting as needed.
// This method blocks until the context is cancelled or Stop is called.
func (rm *ReconnectManager) Start(ctx context.Context) {
	ctx, rm.cancel = context.WithCancel(ctx)

	// Initial connection attempt.
	rm.connect(ctx)

	// Health monitoring loop.
	ticker := time.NewTicker(healthCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			close(rm.done)
			return
		case <-ticker.C:
			rm.mu.RLock()
			isAvailable := rm.available
			m := rm.modem
			rm.mu.RUnlock()

			if !isAvailable {
				// Already in reconnection mode; try to reconnect.
				rm.connect(ctx)
				continue
			}

			// Probe modem health with a simple AT command.
			if m != nil {
				_, err := m.SendCommand("AT", healthCheckTimeout)
				if err != nil {
					slog.Warn("Modem health check failed, starting reconnection",
						"error", err,
					)
					rm.handleDisconnect(ctx)
				}
			}
		}
	}
}

// Stop halts the health monitoring loop and closes the modem connection.
func (rm *ReconnectManager) Stop() {
	if rm.cancel != nil {
		rm.cancel()
	}

	// Wait for the monitoring loop to exit.
	<-rm.done

	// Close the modem if connected.
	rm.mu.Lock()
	if rm.modem != nil {
		_ = rm.modem.Close()
		rm.modem = nil
	}
	rm.available = false
	rm.mu.Unlock()
}

// handleDisconnect is called when the modem is detected as unavailable.
// It closes the current modem, transitions the state machine, notifies
// callbacks, and starts the reconnection loop.
func (rm *ReconnectManager) handleDisconnect(ctx context.Context) {
	rm.mu.Lock()
	wasInCall := rm.sm != nil && rm.sm.State() == StateInCall
	if rm.modem != nil {
		_ = rm.modem.Close()
		rm.modem = nil
	}
	if rm.sm != nil {
		rm.sm.TransitionToDisconnected()
	}
	rm.available = false
	rm.mu.Unlock()

	// Notify about call loss if we were in a call.
	if wasInCall && rm.callbacks.OnCallLost != nil {
		rm.callbacks.OnCallLost()
	}

	// Notify about modem disconnection.
	if rm.callbacks.OnDisconnected != nil {
		rm.callbacks.OnDisconnected()
	}

	slog.Info("Modem disconnected, starting reconnection loop")

	// Start reconnection with backoff.
	rm.reconnectLoop(ctx)
}

// connect performs the initial connection: open serial port, initialize modem,
// set up state machine. If it fails, it enters the reconnection loop.
func (rm *ReconnectManager) connect(ctx context.Context) {
	port, err := OpenSerialPort(rm.serialPortPath)
	if err != nil {
		slog.Warn("Failed to open serial port, entering reconnection loop",
			"path", rm.serialPortPath,
			"error", err,
		)
		rm.reconnectLoop(ctx)
		return
	}

	m := New(port)
	m.Open()

	sm := NewStateMachine()
	sm.RegisterURCHandler(m)

	// Run init sequence.
	if err := sm.TransitionToInitializing(); err != nil {
		slog.Error("Failed to transition to initializing", "error", err)
		_ = m.Close()
		rm.reconnectLoop(ctx)
		return
	}

	_, err = RunInitSequence(ctx, m)
	if err != nil {
		slog.Warn("Modem initialization failed, entering reconnection loop",
			"error", err,
		)
		_ = m.Close()
		rm.reconnectLoop(ctx)
		return
	}

	// Transition state machine to ready (RunInitSequence sets Modem state,
	// but we also need to transition the external StateMachine).
	if err := sm.TransitionToReady(); err != nil {
		slog.Error("Failed to transition to ready", "error", err)
		_ = m.Close()
		rm.reconnectLoop(ctx)
		return
	}

	// Success - update state.
	rm.mu.Lock()
	rm.modem = m
	rm.sm = sm
	rm.available = true
	rm.mu.Unlock()

	slog.Info("Modem connected and initialized")

	if rm.callbacks.OnConnected != nil {
		rm.callbacks.OnConnected()
	}
}

// reconnectLoop attempts to reconnect to the modem with exponential backoff.
// It blocks until reconnection succeeds or the context is cancelled.
func (rm *ReconnectManager) reconnectLoop(ctx context.Context) {
	backoff := reconnectBackoffMin

	for {
		// Check for cancellation before waiting.
		select {
		case <-ctx.Done():
			return
		default:
		}

		slog.Debug("Attempting modem reconnection",
			"backoff", backoff,
		)

		// Wait with backoff.
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}

		// Attempt to open the serial port.
		port, err := OpenSerialPort(rm.serialPortPath)
		if err != nil {
			slog.Debug("Reconnection attempt failed: cannot open serial port",
				"error", err,
				"nextBackoff", nextBackoff(backoff),
			)
			backoff = nextBackoff(backoff)
			continue
		}

		// Port opened - try to initialize.
		m := New(port)
		m.Open()

		sm := NewStateMachine()
		sm.RegisterURCHandler(m)

		if err := sm.TransitionToInitializing(); err != nil {
			slog.Error("Reconnection: failed to transition to initializing", "error", err)
			_ = m.Close()
			backoff = nextBackoff(backoff)
			continue
		}

		_, err = RunInitSequence(ctx, m)
		if err != nil {
			slog.Debug("Reconnection attempt failed: init sequence error",
				"error", err,
				"nextBackoff", nextBackoff(backoff),
			)
			_ = m.Close()
			backoff = nextBackoff(backoff)
			continue
		}

		if err := sm.TransitionToReady(); err != nil {
			slog.Error("Reconnection: failed to transition to ready", "error", err)
			_ = m.Close()
			backoff = nextBackoff(backoff)
			continue
		}

		// Success.
		rm.mu.Lock()
		rm.modem = m
		rm.sm = sm
		rm.available = true
		rm.mu.Unlock()

		slog.Info("Modem reconnected and reinitialized")

		if rm.callbacks.OnConnected != nil {
			rm.callbacks.OnConnected()
		}
		return
	}
}

// nextBackoff doubles the backoff duration, capped at the maximum.
func nextBackoff(current time.Duration) time.Duration {
	next := current * 2
	if next > reconnectBackoffMax {
		return reconnectBackoffMax
	}
	return next
}
