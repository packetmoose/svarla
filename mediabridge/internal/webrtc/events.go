package webrtc

// EventType identifies the kind of session event.
type EventType string

const (
	// EventClientConnected indicates the WebRTC peer connection is established.
	EventClientConnected EventType = "client_connected"
	// EventClientDisconnected indicates the WebRTC peer connection was lost.
	EventClientDisconnected EventType = "client_disconnected"
	// EventProviderConnected indicates the provider leg is connected.
	EventProviderConnected EventType = "provider_connected"
	// EventProviderDisconnected indicates the provider leg was lost.
	EventProviderDisconnected EventType = "provider_disconnected"
	// EventStateChanged indicates the session state has changed.
	EventStateChanged EventType = "state_changed"
)

// SessionEvent represents an event emitted during the lifecycle of a session.
type SessionEvent struct {
	// SessionID is the unique identifier for the session.
	SessionID string
	// Type is the event type.
	Type EventType
	// Reason provides additional context (e.g., "ice_failed", "bye").
	Reason string
	// State is the current session state at the time of the event.
	State SessionState
}

// EventHandler is a function that handles session events.
type EventHandler func(event SessionEvent)
