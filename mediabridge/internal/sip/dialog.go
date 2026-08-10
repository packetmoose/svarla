package sip

import (
	"sync"
	"time"
)

// DialogState represents the state of a SIP dialog.
type DialogState string

const (
	DialogEarly      DialogState = "early"
	DialogConfirmed  DialogState = "confirmed"
	DialogTerminated DialogState = "terminated"
)

// Dialog represents an active SIP dialog tied to a MediaBridge session.
type Dialog struct {
	mu sync.RWMutex

	SessionID   string      // MediaBridge session ID (user part of Request-URI)
	CallID      string      // SIP Call-ID
	State       DialogState
	LocalTag    string      // Our tag (To header tag in responses)
	RemoteTag   string      // Their tag (From header tag)
	RemoteAddr  string      // Remote address (IP:port) for sending responses/requests
	RemoteURI   string      // Remote Contact URI for subsequent requests
	LocalCSeq   int         // Our CSeq counter for outbound requests
	RemoteCSeq  int         // Their last CSeq for ordering
	NegotiatedCodec *Codec  // Negotiated audio codec
	RemoteIP    string      // Remote RTP IP from SDP
	RemotePort  int         // Remote RTP port from SDP
	CreatedAt   time.Time
	Transport   string      // "udp" or "tcp"
	SRTPSession *SRTPSession // SRTP session for encrypted media; nil when unencrypted
}

// NewDialog creates a dialog from an incoming INVITE.
func NewDialog(sessionID, callID, remoteTag, remoteAddr, transport string) *Dialog {
	return &Dialog{
		SessionID:  sessionID,
		CallID:     callID,
		State:      DialogEarly,
		LocalTag:   "mb-" + generateTag(),
		RemoteTag:  remoteTag,
		RemoteAddr: remoteAddr,
		CreatedAt:  timeNow(),
		Transport:  transport,
	}
}

// SetConfirmed transitions the dialog to confirmed state.
func (d *Dialog) SetConfirmed() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.State = DialogConfirmed
}

// SetTerminated transitions the dialog to terminated state.
func (d *Dialog) SetTerminated() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.State = DialogTerminated
}

// IsConfirmed returns whether the dialog is in confirmed state.
func (d *Dialog) IsConfirmed() bool {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.State == DialogConfirmed
}

// DialogStore manages active SIP dialogs, indexed by session ID.
type DialogStore struct {
	mu      sync.RWMutex
	bySession map[string]*Dialog // sessionID → dialog
	byCallID  map[string]*Dialog // callID → dialog
}

// NewDialogStore creates a new dialog store.
func NewDialogStore() *DialogStore {
	return &DialogStore{
		bySession: make(map[string]*Dialog),
		byCallID:  make(map[string]*Dialog),
	}
}

// Add registers a dialog in the store.
func (ds *DialogStore) Add(d *Dialog) {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	ds.bySession[d.SessionID] = d
	ds.byCallID[d.CallID] = d
}

// GetBySession retrieves a dialog by session ID.
func (ds *DialogStore) GetBySession(sessionID string) *Dialog {
	ds.mu.RLock()
	defer ds.mu.RUnlock()
	return ds.bySession[sessionID]
}

// GetByCallID retrieves a dialog by SIP Call-ID.
func (ds *DialogStore) GetByCallID(callID string) *Dialog {
	ds.mu.RLock()
	defer ds.mu.RUnlock()
	return ds.byCallID[callID]
}

// Remove removes a dialog from the store.
func (ds *DialogStore) Remove(sessionID string) {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	if d, ok := ds.bySession[sessionID]; ok {
		delete(ds.byCallID, d.CallID)
		delete(ds.bySession, sessionID)
	}
}

// All returns all active dialogs. Used during graceful shutdown.
func (ds *DialogStore) All() []*Dialog {
	ds.mu.RLock()
	defer ds.mu.RUnlock()
	dialogs := make([]*Dialog, 0, len(ds.bySession))
	for _, d := range ds.bySession {
		dialogs = append(dialogs, d)
	}
	return dialogs
}

// Count returns the number of active dialogs.
func (ds *DialogStore) Count() int {
	ds.mu.RLock()
	defer ds.mu.RUnlock()
	return len(ds.bySession)
}
