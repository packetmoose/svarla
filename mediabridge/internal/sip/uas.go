package sip

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/pion/srtp/v3"
)

// srtpProfileAes128CmHmacSha1_80 is the SRTP protection profile used for SDES negotiation.
var srtpProfileAes128CmHmacSha1_80 = srtp.ProtectionProfileAes128CmHmacSha1_80

// timeNow is a variable for testing — allows mocking time in tests.
var timeNow = time.Now

// EventCallback is called when SIP events occur that need to be communicated
// to the rest of the MediaBridge (session store updates, event emissions).
type EventCallback func(event UASEvent)

// UASEvent represents an event emitted by the SIP UAS.
type UASEvent struct {
	Type      UASEventType
	SessionID string
	Codec     *Codec // set on provider_connected (INVITE accepted)
	RemoteIP  string // RTP remote IP from SDP
	RemotePort int   // RTP remote port from SDP
	Reason    string // set on provider_disconnected
	SRTPSession *SRTPSession // set when SRTP is negotiated; nil for unencrypted
}

// UASEventType identifies the kind of SIP UAS event.
type UASEventType string

const (
	EventProviderConnected    UASEventType = "provider_connected"
	EventProviderDisconnected UASEventType = "provider_disconnected"
)

// UASConfig holds configuration for the SIP User Agent Server.
type UASConfig struct {
	Port        int          // Listen port (default 5060)
	TLSPort     int          // TLS listen port (default 5061)
	MediaPort   int          // RTP media port for SDP answers (default 5062)
	PublicIP    string       // Public IP for SDP answers and Contact headers
	AllowedIPs  []string     // IP allowlist; empty = allow all
	CertManager *CertManager // TLS certificate manager; nil = TLS disabled
}

// SessionLookup is a function that checks if a session ID exists and is
// expecting a SIP connection. Returns true if the session is valid.
type SessionLookup func(sessionID string) bool

// UAS is the SIP User Agent Server that listens for incoming SIP messages
// from telephony providers and manages SIP dialogs.
type UAS struct {
	cfg       UASConfig
	logger    *slog.Logger
	lookup    SessionLookup
	callback  EventCallback
	allowlist *IPAllowlist
	dialogs   *DialogStore

	udpConn  *net.UDPConn
	tcpLn    net.Listener
	tlsLn    net.Listener

	// connStore holds persistent TCP/TLS connections keyed by remote address.
	// SIP over TCP/TLS requires responses to be sent on the same connection
	// the request arrived on (RFC 3261 §18.2.2).
	connStore   map[string]net.Conn
	connStoreMu sync.RWMutex

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// NewUAS creates a new SIP User Agent Server.
func NewUAS(cfg UASConfig, lookup SessionLookup, callback EventCallback, logger *slog.Logger) *UAS {
	ctx, cancel := context.WithCancel(context.Background())
	return &UAS{
		cfg:       cfg,
		logger:    logger,
		lookup:    lookup,
		callback:  callback,
		allowlist: NewIPAllowlist(cfg.AllowedIPs),
		dialogs:   NewDialogStore(),
		connStore: make(map[string]net.Conn),
		ctx:       ctx,
		cancel:    cancel,
	}
}

// Start begins listening for SIP messages on UDP, TCP, and TLS.
func (u *UAS) Start() error {
	addr := fmt.Sprintf(":%d", u.cfg.Port)

	// Start UDP listener.
	udpAddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return fmt.Errorf("resolving UDP addr: %w", err)
	}
	u.udpConn, err = net.ListenUDP("udp", udpAddr)
	if err != nil {
		return fmt.Errorf("listening UDP on %s: %w", addr, err)
	}

	// Start TCP listener.
	u.tcpLn, err = net.Listen("tcp", addr)
	if err != nil {
		u.udpConn.Close()
		return fmt.Errorf("listening TCP on %s: %w", addr, err)
	}

	// Start TLS listener if CertManager is configured.
	if u.cfg.CertManager != nil {
		tlsAddr := fmt.Sprintf(":%d", u.cfg.TLSPort)
		tlsConfig := &tls.Config{
			MinVersion:     tls.VersionTLS12,
			GetCertificate: u.cfg.CertManager.GetCertificate,
		}
		u.tlsLn, err = tls.Listen("tcp", tlsAddr, tlsConfig)
		if err != nil {
			u.udpConn.Close()
			u.tcpLn.Close()
			return fmt.Errorf("listening TLS on %s: %w", tlsAddr, err)
		}
	}

	u.logger.Info("SIP UAS started",
		slog.String("addr", addr),
		slog.Int("port", u.cfg.Port),
		slog.String("publicIp", u.cfg.PublicIP),
	)

	// Start goroutines for UDP and TCP.
	u.wg.Add(2)
	go u.udpLoop()
	go u.tcpLoop()

	// Start TLS goroutine if listener is available.
	if u.tlsLn != nil {
		u.wg.Add(1)
		go u.tlsLoop()
		u.logger.Info("SIP TLS listener started",
			slog.Int("tlsPort", u.cfg.TLSPort),
		)
	}

	return nil
}

// Shutdown gracefully stops the UAS. Sends BYE on all active dialogs.
func (u *UAS) Shutdown(ctx context.Context) {
	u.cancel()

	// Send BYE on all active dialogs.
	dialogs := u.dialogs.All()
	for _, d := range dialogs {
		if d.IsConfirmed() {
			u.sendBye(d)
		}
		// Close SRTP session to zero key material.
		if d.SRTPSession != nil {
			d.SRTPSession.Close()
		}
		d.SetTerminated()
	}

	if u.udpConn != nil {
		u.udpConn.Close()
	}
	if u.tcpLn != nil {
		u.tcpLn.Close()
	}
	if u.tlsLn != nil {
		u.tlsLn.Close()
	}

	u.wg.Wait()
	u.logger.Info("SIP UAS shut down", slog.Int("dialogs_closed", len(dialogs)))
}

// SendBye sends a SIP BYE for the given session, terminating the SIP dialog.
// Called when the Server destroys a session.
func (u *UAS) SendBye(sessionID string) error {
	d := u.dialogs.GetBySession(sessionID)
	if d == nil {
		return fmt.Errorf("no active dialog for session %s", sessionID)
	}
	if !d.IsConfirmed() {
		return fmt.Errorf("dialog for session %s not confirmed", sessionID)
	}

	u.sendBye(d)

	// Close SRTP session to zero key material.
	if d.SRTPSession != nil {
		d.SRTPSession.Close()
	}

	d.SetTerminated()
	u.dialogs.Remove(sessionID)
	return nil
}

// Dialogs returns the dialog store for external inspection (e.g., testing).
func (u *UAS) Dialogs() *DialogStore {
	return u.dialogs
}

// udpLoop reads UDP packets and processes them.
func (u *UAS) udpLoop() {
	defer u.wg.Done()

	buf := make([]byte, 65535)
	for {
		select {
		case <-u.ctx.Done():
			return
		default:
		}

		u.udpConn.SetReadDeadline(time.Now().Add(1 * time.Second))
		n, remoteAddr, err := u.udpConn.ReadFromUDP(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			select {
			case <-u.ctx.Done():
				return
			default:
				u.logger.Warn("UDP read error", slog.String("error", err.Error()))
				continue
			}
		}

		data := make([]byte, n)
		copy(data, buf[:n])
		go u.handleMessage(data, remoteAddr.String(), "udp")
	}
}

// tcpLoop accepts TCP connections and reads SIP messages.
func (u *UAS) tcpLoop() {
	defer u.wg.Done()

	for {
		select {
		case <-u.ctx.Done():
			return
		default:
		}

		conn, err := u.tcpLn.Accept()
		if err != nil {
			select {
			case <-u.ctx.Done():
				return
			default:
				u.logger.Warn("TCP accept error", slog.String("error", err.Error()))
				continue
			}
		}

		u.wg.Add(1)
		go u.handleTCPConn(conn)
	}
}

// handleTCPConn reads SIP messages from a TCP connection.
func (u *UAS) handleTCPConn(conn net.Conn) {
	defer u.wg.Done()
	defer conn.Close()

	remoteAddr := conn.RemoteAddr().String()

	// Store the connection so responses can be sent back on the same connection
	// (RFC 3261 §18.2.2).
	u.connStoreMu.Lock()
	u.connStore[remoteAddr] = conn
	u.connStoreMu.Unlock()
	defer func() {
		u.connStoreMu.Lock()
		delete(u.connStore, remoteAddr)
		u.connStoreMu.Unlock()
	}()

	buf := make([]byte, 65535)

	for {
		select {
		case <-u.ctx.Done():
			return
		default:
		}

		conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		n, err := conn.Read(buf)
		if err != nil {
			return
		}

		data := make([]byte, n)
		copy(data, buf[:n])
		u.handleMessage(data, remoteAddr, "tcp")
	}
}

// tlsLoop accepts TLS connections and reads SIP messages.
func (u *UAS) tlsLoop() {
	defer u.wg.Done()

	for {
		select {
		case <-u.ctx.Done():
			return
		default:
		}

		conn, err := u.tlsLn.Accept()
		if err != nil {
			select {
			case <-u.ctx.Done():
				return
			default:
				u.logger.Warn("TLS accept error", slog.String("error", err.Error()))
				continue
			}
		}

		u.wg.Add(1)
		go u.handleTLSConn(conn)
	}
}

// handleTLSConn handles a TLS connection, performing the handshake and reading SIP messages.
func (u *UAS) handleTLSConn(conn net.Conn) {
	defer u.wg.Done()
	defer conn.Close()

	// Perform TLS handshake explicitly to catch handshake failures gracefully.
	tlsConn, ok := conn.(*tls.Conn)
	if !ok {
		u.logger.Warn("TLS connection type assertion failed")
		return
	}

	// Set a deadline for the handshake to prevent blocking indefinitely.
	tlsConn.SetDeadline(time.Now().Add(10 * time.Second))
	if err := tlsConn.Handshake(); err != nil {
		u.logger.Info("TLS handshake failed",
			slog.String("remote", conn.RemoteAddr().String()),
			slog.String("error", err.Error()),
		)
		return
	}
	// Clear the deadline after successful handshake; per-read deadlines are set below.
	tlsConn.SetDeadline(time.Time{})

	remoteAddr := conn.RemoteAddr().String()

	// Store the connection so responses can be sent back on the same connection
	// (RFC 3261 §18.2.2).
	u.connStoreMu.Lock()
	u.connStore[remoteAddr] = conn
	u.connStoreMu.Unlock()
	defer func() {
		u.connStoreMu.Lock()
		delete(u.connStore, remoteAddr)
		u.connStoreMu.Unlock()
	}()

	buf := make([]byte, 65535)

	for {
		select {
		case <-u.ctx.Done():
			return
		default:
		}

		conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		n, err := conn.Read(buf)
		if err != nil {
			return
		}

		data := make([]byte, n)
		copy(data, buf[:n])
		u.handleMessage(data, remoteAddr, "tls")
	}
}

// handleMessage parses and dispatches a SIP message.
func (u *UAS) handleMessage(data []byte, remoteAddr, transport string) {
	// Security: check IP allowlist.
	if !u.allowlist.IsAllowed(remoteAddr) {
		u.logger.Warn("SIP message rejected by IP allowlist",
			slog.String("remote", remoteAddr),
		)
		return
	}

	msg, err := ParseMessage(data)
	if err != nil {
		u.logger.Warn("SIP parse error",
			slog.String("error", err.Error()),
			slog.String("remote", remoteAddr),
		)
		return
	}

	if !msg.IsRequest {
		// We're a UAS — ignore responses (we don't send requests except BYE).
		return
	}

	switch msg.Method {
	case MethodINVITE:
		u.handleInvite(msg, remoteAddr, transport)
	case MethodBYE:
		u.handleBye(msg, remoteAddr, transport)
	case MethodACK:
		u.handleAck(msg, remoteAddr, transport)
	case MethodCANCEL:
		u.handleCancel(msg, remoteAddr, transport)
	default:
		// Respond with 405 Method Not Allowed.
		resp := BuildResponse(msg, 405, "Method Not Allowed", nil, map[string]string{
			"Allow": "INVITE, ACK, BYE, CANCEL",
		})
		u.send(resp, remoteAddr, transport)
	}
}

// handleInvite processes an incoming INVITE (new call or re-INVITE).
func (u *UAS) handleInvite(msg *Message, remoteAddr, transport string) {
	// Extract session ID from Request-URI.
	sessionID := ExtractSessionIDFromURI(msg.RequestURI)
	if sessionID == "" {
		u.logger.Warn("INVITE with empty session ID", slog.String("uri", msg.RequestURI))
		resp := BuildResponse(msg, 404, "Not Found", nil, nil)
		u.send(resp, remoteAddr, transport)
		return
	}

	u.logger.Info("SIP INVITE received",
		slog.String("sessionId", sessionID),
		slog.String("remote", remoteAddr),
		slog.String("callId", msg.CallID),
		slog.String("transport", strings.ToUpper(transport)),
	)

	// Check if this is a re-INVITE (dialog already exists for this Call-ID).
	existingDialog := u.dialogs.GetByCallID(msg.CallID)
	if existingDialog != nil && existingDialog.IsConfirmed() {
		u.handleReInvite(msg, existingDialog, remoteAddr, transport)
		return
	}

	// Verify the session exists in the session store.
	if !u.lookup(sessionID) {
		u.logger.Warn("INVITE for unknown session",
			slog.String("sessionId", sessionID),
		)
		resp := BuildResponse(msg, 404, "Not Found", nil, nil)
		u.send(resp, remoteAddr, transport)
		return
	}

	// Parse the SDP offer from the INVITE body.
	if len(msg.Body) == 0 {
		u.logger.Warn("INVITE without SDP body", slog.String("sessionId", sessionID))
		resp := BuildResponse(msg, 400, "Bad Request", nil, nil)
		u.send(resp, remoteAddr, transport)
		return
	}

	sdpOffer, err := ParseSDP(msg.Body)
	if err != nil {
		u.logger.Warn("INVITE SDP parse error",
			slog.String("sessionId", sessionID),
			slog.String("error", err.Error()),
		)
		resp := BuildResponse(msg, 400, "Bad Request", nil, nil)
		u.send(resp, remoteAddr, transport)
		return
	}

	// Negotiate codec.
	codec, err := NegotiateCodec(sdpOffer)
	if err != nil {
		u.logger.Warn("codec negotiation failed",
			slog.String("sessionId", sessionID),
			slog.String("error", err.Error()),
		)
		resp := BuildResponse(msg, 488, "Not Acceptable Here", nil, nil)
		u.send(resp, remoteAddr, transport)
		return
	}

	// Negotiate SDES/SRTP if crypto attributes are offered.
	cryptoAttrs, _ := ParseCryptoAttributes(msg.Body)
	var srtpSession *SRTPSession
	var sdpCryptoLine string
	useSRTP := false

	if len(cryptoAttrs) > 0 {
		sdesResult, err := NegotiateSDES(cryptoAttrs)
		if err != nil {
			u.logger.Warn("SDES negotiation error",
				slog.String("sessionId", sessionID),
				slog.String("error", err.Error()),
			)
			resp := BuildResponse(msg, 488, "Not Acceptable Here", nil, nil)
			u.send(resp, remoteAddr, transport)
			return
		}
		if sdesResult == nil {
			// No supported crypto suite — reject with 488.
			u.logger.Warn("no supported crypto suite in offer",
				slog.String("sessionId", sessionID),
			)
			resp := BuildResponse(msg, 488, "Not Acceptable Here", nil, nil)
			u.send(resp, remoteAddr, transport)
			return
		}

		// Create SRTP session with negotiated keys.
		srtpSession, err = NewSRTPSession(
			sdesResult.LocalKey,
			sdesResult.RemoteKey,
			srtpProfileAes128CmHmacSha1_80,
		)
		if err != nil {
			u.logger.Warn("failed to create SRTP session",
				slog.String("sessionId", sessionID),
				slog.String("error", err.Error()),
			)
			resp := BuildResponse(msg, 500, "Internal Server Error", nil, nil)
			u.send(resp, remoteAddr, transport)
			return
		}

		useSRTP = true
		sdpCryptoLine = FormatCryptoAnswer(sdesResult)
	}

	// Send 100 Trying (provisional).
	trying := BuildResponse(msg, 100, "Trying", nil, nil)
	u.send(trying, remoteAddr, transport)

	// Create dialog.
	remoteTag := extractTag(msg.From)
	d := NewDialog(sessionID, msg.CallID, remoteTag, remoteAddr, transport)
	d.NegotiatedCodec = codec
	d.RemoteIP = sdpOffer.IP
	d.RemotePort = sdpOffer.Port
	d.RemoteURI = extractContactURI(msg.Contact)
	if d.RemoteURI == "" {
		d.RemoteURI = msg.RequestURI
	}
	d.SRTPSession = srtpSession
	u.dialogs.Add(d)

	// Generate SDP answer.
	sdpAnswer := GenerateSDPAnswer(SDPAnswer{
		Codec:      *codec,
		LocalIP:    u.cfg.PublicIP,
		LocalPort:  u.cfg.MediaPort,
		UseSRTP:    useSRTP,
		CryptoLine: sdpCryptoLine,
	})

	// Send 200 OK with SDP answer.
	contact := fmt.Sprintf("<sip:%s@%s:%d;transport=%s>", sessionID, u.cfg.PublicIP, u.cfg.Port, transport)
	resp := BuildResponse(msg, 200, "OK", sdpAnswer, map[string]string{
		"Contact":      contact,
		"Content-Type": "application/sdp",
	})
	u.send(resp, remoteAddr, transport)

	d.SetConfirmed()

	u.logger.Info("SIP INVITE accepted",
		slog.String("sessionId", sessionID),
		slog.String("codec", codec.Name),
		slog.Int("clockRate", codec.ClockRate),
		slog.String("remoteIp", sdpOffer.IP),
		slog.Int("remotePort", sdpOffer.Port),
	)

	// Log transport security status per requirements 8.2, 8.3, 8.4.
	if transport == "tls" {
		if useSRTP {
			u.logger.Info("session using encrypted signaling and encrypted media",
				slog.String("sessionId", sessionID),
				slog.String("callId", msg.CallID),
			)
		} else {
			u.logger.Info("session using encrypted signaling and unencrypted media",
				slog.String("sessionId", sessionID),
				slog.String("callId", msg.CallID),
			)
		}
	} else {
		u.logger.Info("session using unencrypted signaling",
			slog.String("sessionId", sessionID),
			slog.String("callId", msg.CallID),
			slog.String("transport", strings.ToUpper(transport)),
		)
	}

	// Emit provider_connected event.
	u.callback(UASEvent{
		Type:        EventProviderConnected,
		SessionID:   sessionID,
		Codec:       codec,
		RemoteIP:    sdpOffer.IP,
		RemotePort:  sdpOffer.Port,
		SRTPSession: srtpSession,
	})
}

// handleReInvite handles a re-INVITE for codec renegotiation.
func (u *UAS) handleReInvite(msg *Message, d *Dialog, remoteAddr, transport string) {
	u.logger.Info("SIP re-INVITE received",
		slog.String("sessionId", d.SessionID),
		slog.String("callId", d.CallID),
	)

	if len(msg.Body) == 0 {
		resp := BuildResponse(msg, 400, "Bad Request", nil, nil)
		u.send(resp, remoteAddr, transport)
		return
	}

	sdpOffer, err := ParseSDP(msg.Body)
	if err != nil {
		resp := BuildResponse(msg, 400, "Bad Request", nil, nil)
		u.send(resp, remoteAddr, transport)
		return
	}

	codec, err := NegotiateCodec(sdpOffer)
	if err != nil {
		resp := BuildResponse(msg, 488, "Not Acceptable Here", nil, nil)
		u.send(resp, remoteAddr, transport)
		return
	}

	// Update dialog with new codec.
	d.mu.Lock()
	d.NegotiatedCodec = codec
	d.RemoteIP = sdpOffer.IP
	d.RemotePort = sdpOffer.Port
	d.mu.Unlock()

	// Generate new SDP answer.
	sdpAnswer := GenerateSDPAnswer(SDPAnswer{
		Codec:     *codec,
		LocalIP:   u.cfg.PublicIP,
		LocalPort: u.cfg.MediaPort,
	})

	contact := fmt.Sprintf("<sip:%s@%s:%d;transport=%s>", d.SessionID, u.cfg.PublicIP, u.cfg.Port, transport)
	resp := BuildResponse(msg, 200, "OK", sdpAnswer, map[string]string{
		"Contact":      contact,
		"Content-Type": "application/sdp",
	})
	u.send(resp, remoteAddr, transport)

	u.logger.Info("SIP re-INVITE accepted",
		slog.String("sessionId", d.SessionID),
		slog.String("codec", codec.Name),
	)
}

// handleBye processes an incoming BYE (provider hanging up).
func (u *UAS) handleBye(msg *Message, remoteAddr, transport string) {
	d := u.dialogs.GetByCallID(msg.CallID)
	if d == nil {
		// No matching dialog — respond 481.
		resp := BuildResponse(msg, 481, "Call/Transaction Does Not Exist", nil, nil)
		u.send(resp, remoteAddr, transport)
		return
	}

	u.logger.Info("SIP BYE received",
		slog.String("sessionId", d.SessionID),
		slog.String("callId", msg.CallID),
	)

	// Send 200 OK to acknowledge the BYE.
	resp := BuildResponse(msg, 200, "OK", nil, nil)
	u.send(resp, remoteAddr, transport)

	// Close SRTP session to zero key material.
	if d.SRTPSession != nil {
		d.SRTPSession.Close()
	}

	d.SetTerminated()
	u.dialogs.Remove(d.SessionID)

	// Emit provider_disconnected event.
	u.callback(UASEvent{
		Type:      EventProviderDisconnected,
		SessionID: d.SessionID,
		Reason:    "bye",
	})
}

// handleAck processes an ACK (acknowledgment of our 200 OK).
func (u *UAS) handleAck(msg *Message, remoteAddr, transport string) {
	// ACK confirms dialog establishment. We already marked confirmed
	// when we sent 200 OK. No further action needed.
	u.logger.Debug("SIP ACK received", slog.String("callId", msg.CallID))
}

// handleCancel processes a CANCEL (caller abandoning before answer).
func (u *UAS) handleCancel(msg *Message, remoteAddr, transport string) {
	d := u.dialogs.GetByCallID(msg.CallID)
	if d == nil {
		resp := BuildResponse(msg, 481, "Call/Transaction Does Not Exist", nil, nil)
		u.send(resp, remoteAddr, transport)
		return
	}

	u.logger.Info("SIP CANCEL received",
		slog.String("sessionId", d.SessionID),
		slog.String("callId", msg.CallID),
	)

	// Send 200 OK to the CANCEL.
	resp := BuildResponse(msg, 200, "OK", nil, nil)
	u.send(resp, remoteAddr, transport)

	// Close SRTP session to zero key material.
	if d.SRTPSession != nil {
		d.SRTPSession.Close()
	}

	d.SetTerminated()
	u.dialogs.Remove(d.SessionID)

	u.callback(UASEvent{
		Type:      EventProviderDisconnected,
		SessionID: d.SessionID,
		Reason:    "cancelled",
	})
}

// sendBye sends a BYE request within an established dialog.
func (u *UAS) sendBye(d *Dialog) {
	d.mu.Lock()
	d.LocalCSeq++
	cseq := d.LocalCSeq
	d.mu.Unlock()

	requestURI := d.RemoteURI
	if requestURI == "" {
		requestURI = fmt.Sprintf("sip:%s@%s", d.SessionID, d.RemoteAddr)
	}

	via := fmt.Sprintf("SIP/2.0/%s %s:%d;branch=z9hG4bK%s",
		strings.ToUpper(d.Transport), u.cfg.PublicIP, u.cfg.Port, generateTag())

	headers := map[string]string{
		"Via":     via,
		"From":    fmt.Sprintf("<sip:mediabridge@%s:%d>;tag=%s", u.cfg.PublicIP, u.cfg.Port, d.LocalTag),
		"To":      fmt.Sprintf("<sip:%s>;tag=%s", d.RemoteAddr, d.RemoteTag),
		"Call-ID": d.CallID,
		"CSeq":    fmt.Sprintf("%d BYE", cseq),
		"Max-Forwards": "70",
	}

	bye := BuildRequest(MethodBYE, requestURI, headers, nil)
	u.send(bye, d.RemoteAddr, d.Transport)

	u.logger.Info("SIP BYE sent",
		slog.String("sessionId", d.SessionID),
		slog.String("remote", d.RemoteAddr),
	)
}

// send writes data to the remote address via the specified transport.
func (u *UAS) send(data []byte, remoteAddr, transport string) {
	switch transport {
	case "udp":
		u.sendUDP(data, remoteAddr)
	case "tcp":
		u.sendTCP(data, remoteAddr)
	case "tls":
		u.sendTLS(data, remoteAddr)
	}
}

// sendUDP sends data via UDP.
func (u *UAS) sendUDP(data []byte, remoteAddr string) {
	addr, err := net.ResolveUDPAddr("udp", remoteAddr)
	if err != nil {
		u.logger.Warn("failed to resolve UDP addr", slog.String("addr", remoteAddr), slog.String("error", err.Error()))
		return
	}

	if u.udpConn == nil {
		return
	}

	_, err = u.udpConn.WriteToUDP(data, addr)
	if err != nil {
		u.logger.Warn("UDP send failed", slog.String("addr", remoteAddr), slog.String("error", err.Error()))
	}
}

// sendTCP sends data on the existing TCP connection for the given remote address.
// Per RFC 3261 §18.2.2, responses MUST be sent on the same connection the request arrived on.
func (u *UAS) sendTCP(data []byte, remoteAddr string) {
	u.connStoreMu.RLock()
	conn, ok := u.connStore[remoteAddr]
	u.connStoreMu.RUnlock()

	if !ok {
		u.logger.Warn("TCP send failed: no stored connection for remote",
			slog.String("addr", remoteAddr))
		return
	}

	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, err := conn.Write(data)
	if err != nil {
		u.logger.Warn("TCP write failed", slog.String("addr", remoteAddr), slog.String("error", err.Error()))
	}
}

// sendTLS sends data on the existing TLS connection for the given remote address.
// Per RFC 3261 §18.2.2, responses MUST be sent on the same connection the request arrived on.
func (u *UAS) sendTLS(data []byte, remoteAddr string) {
	u.connStoreMu.RLock()
	conn, ok := u.connStore[remoteAddr]
	u.connStoreMu.RUnlock()

	if !ok {
		u.logger.Warn("TLS send failed: no stored connection for remote",
			slog.String("addr", remoteAddr))
		return
	}

	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, err := conn.Write(data)
	if err != nil {
		u.logger.Warn("TLS write failed", slog.String("addr", remoteAddr), slog.String("error", err.Error()))
	}
}

// extractTag extracts the tag parameter from a From/To header value.
func extractTag(header string) string {
	parts := strings.Split(header, ";")
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if strings.HasPrefix(p, "tag=") {
			return strings.TrimPrefix(p, "tag=")
		}
	}
	return ""
}

// extractContactURI extracts the URI from a Contact header value.
// Example: "<sip:user@host:5060>" returns "sip:user@host:5060"
func extractContactURI(contact string) string {
	if idx := strings.Index(contact, "<"); idx >= 0 {
		end := strings.Index(contact[idx:], ">")
		if end >= 0 {
			return contact[idx+1 : idx+end]
		}
	}
	return contact
}
