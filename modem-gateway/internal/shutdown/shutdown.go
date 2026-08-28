// Package shutdown provides graceful shutdown coordination for the modem-gateway binary.
// It performs an ordered shutdown sequence: terminate active calls, flush buffers,
// close the signaling WebSocket, and close the modem serial port.
package shutdown

import (
	"context"
	"log"
)

// CallTerminator defines the interface for terminating an active call during shutdown.
type CallTerminator interface {
	// HasActiveCall reports whether a call is currently in progress.
	HasActiveCall() bool
	// Shutdown terminates the active call (ATH), closes the audio bridge,
	// and notifies Svarla with COMPLETED state and "shutdown" reason.
	Shutdown()
}

// Flusher defines the interface for flushing a buffer to disk.
type Flusher interface {
	Flush() error
}

// SignalingCloser defines the interface for closing the signaling WebSocket.
type SignalingCloser interface {
	Close() error
}

// ModemCloser defines the interface for closing the modem serial port.
type ModemCloser interface {
	Close() error
}

// Coordinator performs an ordered graceful shutdown of the modem-gateway subsystems.
// The shutdown sequence is:
//  1. Terminate active call (ATH, close audio WS, notify Svarla)
//  2. Flush SMS buffer to disk
//  3. Flush missed call buffer to disk
//  4. Close signaling WebSocket with normal closure
//  5. Close modem serial port
type Coordinator struct {
	callTerminator   CallTerminator
	smsBuffer        Flusher
	missedCallBuffer Flusher
	signalingClient  SignalingCloser
	modem            ModemCloser
}

// CoordinatorConfig holds the dependencies for creating a shutdown Coordinator.
// All fields are optional — nil fields are skipped during shutdown.
type CoordinatorConfig struct {
	CallTerminator   CallTerminator
	SMSBuffer        Flusher
	MissedCallBuffer Flusher
	SignalingClient   SignalingCloser
	Modem            ModemCloser
}

// NewCoordinator creates a shutdown Coordinator with the given dependencies.
func NewCoordinator(cfg CoordinatorConfig) *Coordinator {
	return &Coordinator{
		callTerminator:   cfg.CallTerminator,
		smsBuffer:        cfg.SMSBuffer,
		missedCallBuffer: cfg.MissedCallBuffer,
		signalingClient:  cfg.SignalingClient,
		modem:            cfg.Modem,
	}
}

// Shutdown performs the ordered shutdown sequence. It respects the context
// for cancellation (e.g., the 10-second force-exit deadline set by the caller).
// Errors from individual steps are logged but do not halt the sequence.
func (c *Coordinator) Shutdown(ctx context.Context) error {
	log.Println("shutdown: starting graceful shutdown sequence")

	// Step 1: Terminate active call if any.
	if err := ctx.Err(); err != nil {
		return err
	}
	if c.callTerminator != nil && c.callTerminator.HasActiveCall() {
		log.Println("shutdown: terminating active call")
		c.callTerminator.Shutdown()
	}

	// Step 2: Flush SMS buffer to disk.
	if err := ctx.Err(); err != nil {
		return err
	}
	if c.smsBuffer != nil {
		log.Println("shutdown: flushing SMS buffer to disk")
		if err := c.smsBuffer.Flush(); err != nil {
			log.Printf("shutdown: failed to flush SMS buffer: %v", err)
		}
	}

	// Step 3: Flush missed call buffer to disk.
	if err := ctx.Err(); err != nil {
		return err
	}
	if c.missedCallBuffer != nil {
		log.Println("shutdown: flushing missed call buffer to disk")
		if err := c.missedCallBuffer.Flush(); err != nil {
			log.Printf("shutdown: failed to flush missed call buffer: %v", err)
		}
	}

	// Step 4: Close signaling WebSocket with normal closure.
	if err := ctx.Err(); err != nil {
		return err
	}
	if c.signalingClient != nil {
		log.Println("shutdown: closing signaling WebSocket")
		if err := c.signalingClient.Close(); err != nil {
			log.Printf("shutdown: failed to close signaling client: %v", err)
		}
	}

	// Step 5: Close modem serial port.
	if err := ctx.Err(); err != nil {
		return err
	}
	if c.modem != nil {
		log.Println("shutdown: closing modem serial port")
		if err := c.modem.Close(); err != nil {
			log.Printf("shutdown: failed to close modem: %v", err)
		}
	}

	log.Println("shutdown: graceful shutdown complete")
	return nil
}

// FlushBuffers flushes SMS and missed call buffers to disk. This is intended
// to be called early in the shutdown sequence — before potentially slow
// operations like modem teardown — to ensure data is persisted even if the
// process is force-killed.
func (c *Coordinator) FlushBuffers() {
	if c.smsBuffer != nil {
		log.Println("shutdown: flushing SMS buffer to disk")
		if err := c.smsBuffer.Flush(); err != nil {
			log.Printf("shutdown: failed to flush SMS buffer: %v", err)
		}
	}
	if c.missedCallBuffer != nil {
		log.Println("shutdown: flushing missed call buffer to disk")
		if err := c.missedCallBuffer.Flush(); err != nil {
			log.Printf("shutdown: failed to flush missed call buffer: %v", err)
		}
	}
}
