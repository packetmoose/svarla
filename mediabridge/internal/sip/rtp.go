// Package sip provides SIP signaling and RTP transport for the MediaBridge.
package sip

import (
	"fmt"
	"log/slog"
	"net"
	"sync"

	"github.com/pion/rtp"
)

// RTPListener is a shared UDP listener for incoming RTP on a single port.
// It dispatches received packets to registered sessions based on the remote
// sender's IP address (since each SIP dialog has a known remote RTP IP).
type RTPListener struct {
	mu       sync.RWMutex
	port     int
	conn     *net.UDPConn
	logger   *slog.Logger
	sessions map[string]*RTPSession // keyed by remote IP:port
	running  bool
	done     chan struct{}
	wg       sync.WaitGroup
}

// RTPSession represents one session's RTP state within the shared listener.
type RTPSession struct {
	remoteAddr *net.UDPAddr
	onRTP      func(*rtp.Packet)
}

// NewRTPListener creates a shared RTP listener on the given UDP port.
func NewRTPListener(port int, logger *slog.Logger) *RTPListener {
	if logger == nil {
		logger = slog.Default()
	}
	return &RTPListener{
		port:     port,
		logger:   logger,
		sessions: make(map[string]*RTPSession),
		done:     make(chan struct{}),
	}
}

// Start begins listening for incoming RTP packets.
func (l *RTPListener) Start() error {
	l.mu.Lock()
	if l.running {
		l.mu.Unlock()
		return nil
	}
	l.mu.Unlock()

	addr, err := net.ResolveUDPAddr("udp", fmt.Sprintf("0.0.0.0:%d", l.port))
	if err != nil {
		return fmt.Errorf("resolving RTP listen addr: %w", err)
	}

	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		return fmt.Errorf("listening on UDP port %d: %w", l.port, err)
	}

	l.mu.Lock()
	l.conn = conn
	l.running = true
	l.mu.Unlock()

	l.logger.Info("RTP listener started", slog.Int("port", l.port))

	l.wg.Add(1)
	go l.readLoop()

	return nil
}

// Stop shuts down the RTP listener.
func (l *RTPListener) Stop() {
	l.mu.Lock()
	if !l.running {
		l.mu.Unlock()
		return
	}
	l.running = false
	l.mu.Unlock()

	close(l.done)
	if l.conn != nil {
		l.conn.Close()
	}
	l.wg.Wait()
	l.logger.Info("RTP listener stopped", slog.Int("port", l.port))
}

// RegisterSession adds a session to receive RTP from the given remote address.
// The onRTP callback is called for each packet received from that remote.
func (l *RTPListener) RegisterSession(remoteIP string, remotePort int, onRTP func(*rtp.Packet)) (*RTPTransport, error) {
	remoteAddr, err := net.ResolveUDPAddr("udp", fmt.Sprintf("%s:%d", remoteIP, remotePort))
	if err != nil {
		return nil, fmt.Errorf("resolving remote RTP addr: %w", err)
	}

	key := remoteAddr.String()

	l.mu.Lock()
	l.sessions[key] = &RTPSession{
		remoteAddr: remoteAddr,
		onRTP:      onRTP,
	}
	l.mu.Unlock()

	l.logger.Info("RTP session registered",
		slog.String("remoteAddr", key),
	)

	return &RTPTransport{
		listener:   l,
		remoteAddr: remoteAddr,
	}, nil
}

// UnregisterSession removes a session from the dispatcher.
func (l *RTPListener) UnregisterSession(remoteIP string, remotePort int) {
	// Use the same resolution as RegisterSession to ensure consistent key format.
	remoteAddr, err := net.ResolveUDPAddr("udp", fmt.Sprintf("%s:%d", remoteIP, remotePort))
	if err != nil {
		// Fallback to string format.
		key := fmt.Sprintf("%s:%d", remoteIP, remotePort)
		l.mu.Lock()
		delete(l.sessions, key)
		l.mu.Unlock()
		l.logger.Info("RTP session unregistered", slog.String("remoteAddr", key))
		return
	}

	key := remoteAddr.String()
	l.mu.Lock()
	delete(l.sessions, key)
	l.mu.Unlock()

	l.logger.Info("RTP session unregistered", slog.String("remoteAddr", key))
}

// readLoop continuously reads RTP packets and dispatches them.
func (l *RTPListener) readLoop() {
	defer l.wg.Done()

	buf := make([]byte, 1500)

	for {
		select {
		case <-l.done:
			return
		default:
		}

		n, remoteAddr, err := l.conn.ReadFromUDP(buf)
		if err != nil {
			select {
			case <-l.done:
				return
			default:
				l.logger.Debug("RTP read error", slog.String("error", err.Error()))
				continue
			}
		}

		if n < 12 {
			continue
		}

		pkt := &rtp.Packet{}
		if err := pkt.Unmarshal(buf[:n]); err != nil {
			continue
		}

		// Dispatch to the matching session.
		key := remoteAddr.String()
		l.mu.RLock()
		session, ok := l.sessions[key]
		l.mu.RUnlock()

		if ok && session.onRTP != nil {
			session.onRTP(pkt)
		} else {
			// Try matching by IP only (port may differ from SDP due to symmetric NAT).
			// Once found, update the key so future packets match exactly.
			l.mu.Lock()
			var matched *RTPSession
			var oldKey string
			for k, s := range l.sessions {
				if s.remoteAddr.IP.Equal(remoteAddr.IP) {
					matched = s
					oldKey = k
					break
				}
			}
			if matched != nil && oldKey != key {
				// Learn the actual source port — re-register under the real address.
				delete(l.sessions, oldKey)
				matched.remoteAddr = remoteAddr
				l.sessions[key] = matched
			}
			l.mu.Unlock()

			if matched != nil && matched.onRTP != nil {
				matched.onRTP(pkt)
			}
		}
	}
}

// RTPTransport handles sending RTP packets to a specific remote address.
// It uses the shared RTPListener's UDP connection for sending.
type RTPTransport struct {
	listener   *RTPListener
	remoteAddr *net.UDPAddr
}

// WriteRTP sends an RTP packet to the remote provider address.
func (t *RTPTransport) WriteRTP(pkt *rtp.Packet) error {
	t.listener.mu.RLock()
	conn := t.listener.conn
	t.listener.mu.RUnlock()

	if conn == nil {
		return fmt.Errorf("RTP listener not started")
	}

	data, err := pkt.Marshal()
	if err != nil {
		return fmt.Errorf("marshaling RTP packet: %w", err)
	}

	_, err = conn.WriteToUDP(data, t.remoteAddr)
	return err
}

// WriteRaw sends raw bytes (e.g., pre-encrypted SRTP) to the remote provider address.
func (t *RTPTransport) WriteRaw(data []byte) error {
	t.listener.mu.RLock()
	conn := t.listener.conn
	t.listener.mu.RUnlock()

	if conn == nil {
		return fmt.Errorf("RTP listener not started")
	}

	_, err := conn.WriteToUDP(data, t.remoteAddr)
	return err
}

// SetRemoteAddr updates the remote address for sending RTP.
func (t *RTPTransport) SetRemoteAddr(ip string, port int) error {
	addr, err := net.ResolveUDPAddr("udp", fmt.Sprintf("%s:%d", ip, port))
	if err != nil {
		return fmt.Errorf("resolving new remote addr: %w", err)
	}
	t.remoteAddr = addr
	return nil
}
