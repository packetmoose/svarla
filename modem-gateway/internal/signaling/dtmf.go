// Package signaling - DTMF send and receive handler for modem-gateway.
package signaling

import (
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/packetmoose/svarla/modem-gateway/internal/modem"
)

// DTMFTimeout is the timeout for AT+VTS commands (5 seconds).
const DTMFTimeout = 5 * time.Second

// CallStateProvider is the interface that the DTMF handler uses to check
// whether a call is active and retrieve the active call ID.
// This is implemented by the call manager (task 11.1).
type CallStateProvider interface {
	// IsCallActive returns true if there is an active voice call.
	IsCallActive() bool
	// ActiveCallID returns the ID of the current active call, or "" if none.
	ActiveCallID() string
}

// SendDTMFPayload is the payload for a send_dtmf message from Svarla.
type SendDTMFPayload struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	CallID    string `json:"callId"`
	Digit     string `json:"digit"`
}

// DTMFResultPayload is the payload for a dtmf_result message sent to Svarla.
type DTMFResultPayload struct {
	Type        string `json:"type"`
	RequestID   string `json:"requestId"`
	Success     bool   `json:"success"`
	ErrorReason string `json:"errorReason,omitempty"`
}

// DTMFReceivedPayload is the payload for a dtmf_received message sent to Svarla.
type DTMFReceivedPayload struct {
	Type   string `json:"type"`
	CallID string `json:"callId"`
	Digit  string `json:"digit"`
}

// DTMFClient is the interface required by DTMFHandler for sending messages
// and registering message handlers. Both *Client and *ReconnectingClient
// satisfy this interface.
type DTMFClient interface {
	Send(msg Message) error
	OnMessage(handler func(msg Message))
}

// DTMFHandler manages DTMF send and receive operations. It handles
// send_dtmf messages from Svarla (sending AT+VTS to the modem) and
// forwards +DTMF URCs received from the modem back to Svarla.
type DTMFHandler struct {
	modem      *modem.Modem
	client     DTMFClient
	callState  CallStateProvider
}

// NewDTMFHandler creates a new DTMFHandler. It registers:
//   - A message handler on the signaling client for send_dtmf messages.
//   - A URC handler on the modem for +DTMF URCs.
func NewDTMFHandler(m *modem.Modem, client DTMFClient, callState CallStateProvider) *DTMFHandler {
	h := &DTMFHandler{
		modem:     m,
		client:    client,
		callState: callState,
	}

	// Register the +DTMF URC handler on the modem.
	m.OnURC(func(urc modem.URC) {
		if urc.Prefix == "+DTMF" {
			h.handleDTMFURC(urc)
		}
	})

	// Register the send_dtmf message handler on the signaling client.
	client.OnMessage(func(msg Message) {
		if msg.Type == TypeSendDTMF {
			h.handleSendDTMF(msg)
		}
	})

	return h
}

// handleSendDTMF processes a send_dtmf message from the Svarla server.
// It validates that a call is active, sends AT+VTS=<digit>, and reports
// the result back via a dtmf_result message.
func (h *DTMFHandler) handleSendDTMF(msg Message) {
	var payload SendDTMFPayload
	if err := msg.ParsePayload(&payload); err != nil {
		slog.Error("Failed to parse send_dtmf payload", "error", err)
		return
	}

	// Reject if no call is active.
	if !h.callState.IsCallActive() {
		h.sendResult(payload.RequestID, false, "no active call")
		return
	}

	// Send the DTMF tone via AT+VTS.
	cmd := fmt.Sprintf("AT+VTS=%s", payload.Digit)
	_, err := h.modem.SendCommand(cmd, DTMFTimeout)
	if err != nil {
		slog.Warn("AT+VTS failed", "digit", payload.Digit, "error", err)
		h.sendResult(payload.RequestID, false, err.Error())
		return
	}

	slog.Debug("DTMF tone sent", "digit", payload.Digit)
	h.sendResult(payload.RequestID, true, "")
}

// sendResult sends a dtmf_result message back to Svarla.
func (h *DTMFHandler) sendResult(requestID string, success bool, errorReason string) {
	result := DTMFResultPayload{
		Type:        TypeDTMFResult,
		RequestID:   requestID,
		Success:     success,
		ErrorReason: errorReason,
	}

	msg, err := NewMessage(TypeDTMFResult, result)
	if err != nil {
		slog.Error("Failed to create dtmf_result message", "error", err)
		return
	}

	if err := h.client.Send(msg); err != nil {
		slog.Error("Failed to send dtmf_result", "error", err)
	}
}

// handleDTMFURC processes a +DTMF URC from the modem. It extracts the
// digit and forwards it to Svarla via a dtmf_received message.
func (h *DTMFHandler) handleDTMFURC(urc modem.URC) {
	// Parse the digit from the URC data.
	// Format: +DTMF: <digit> (e.g., "+DTMF: 5" or "+DTMF: *")
	digit := strings.TrimSpace(urc.Data)
	if digit == "" {
		slog.Warn("Received +DTMF URC with empty data", "raw", urc.Raw)
		return
	}

	// Only forward if a call is active.
	if !h.callState.IsCallActive() {
		slog.Debug("Ignoring +DTMF URC: no active call", "digit", digit)
		return
	}

	callID := h.callState.ActiveCallID()

	slog.Debug("DTMF tone received", "digit", digit, "callId", callID)

	received := DTMFReceivedPayload{
		Type:   TypeDTMFReceived,
		CallID: callID,
		Digit:  digit,
	}

	msg, err := NewMessage(TypeDTMFReceived, received)
	if err != nil {
		slog.Error("Failed to create dtmf_received message", "error", err)
		return
	}

	if err := h.client.Send(msg); err != nil {
		slog.Error("Failed to send dtmf_received", "error", err)
	}
}
