// Package main is the entry point for the MediaBridge process.
// MediaBridge is a Pion-based sidecar that terminates WebRTC connections
// from clients and bridges audio to telephony providers via SIP or WebSocket.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"mediabridge/internal/config"
	"mediabridge/internal/controlapi"
	"mediabridge/internal/events"
	"mediabridge/internal/logging"
	"mediabridge/internal/mediasession"
	"mediabridge/internal/ringback"
	"mediabridge/internal/session"
	"mediabridge/internal/sip"
	"mediabridge/internal/webrtc"
	"mediabridge/internal/audiows"
	"mediabridge/internal/bridge"

	"github.com/pion/rtp"
	webrtcPkg "github.com/pion/webrtc/v4"
)

const (
	defaultConfigPath   = "mediabridge-config.yaml"
	shutdownTimeout     = 5 * time.Second
	readHeaderTimeout   = 10 * time.Second
)

// mediaSessionStore is a thread-safe store for active media sessions.
type mediaSessionStore struct {
	mu       sync.RWMutex
	sessions map[string]*mediasession.MediaSession
}

// ringbackStore is a thread-safe store for active ringback tone senders.
type ringbackStore struct {
	mu      sync.Mutex
	senders map[string]*ringback.Sender
}

// stopRingback stops and removes the ringback sender for a session if one exists.
func (rs *ringbackStore) stopRingback(sessionID string) {
	rs.mu.Lock()
	sender, exists := rs.senders[sessionID]
	if exists {
		delete(rs.senders, sessionID)
	}
	rs.mu.Unlock()

	if exists && sender != nil {
		sender.Stop()
	}
}

func main() {
	configPath := flag.String("config", defaultConfigPath, "path to mediabridge-config.yaml")
	flag.Parse()

	// CONFIG_PATH env var overrides the -config flag.
	path := *configPath
	if envPath := os.Getenv("CONFIG_PATH"); envPath != "" {
		path = envPath
	}

	// Load configuration.
	cfg, err := config.Load(path)
	if err != nil {
		// If file not found, use defaults and log a warning after logger is set up.
		cfg = config.Defaults()
		if !os.IsNotExist(errors.Unwrap(err)) {
			fmt.Fprintf(os.Stderr, "warning: %v, using defaults\n", err)
		}
	}

	// Set up structured logging.
	logLevel := cfg.Log.Level
	logFormat := "text"
	if cfg.Log.JSON {
		logFormat = "json"
	}
	logger := logging.Setup(logLevel, logFormat)
	logger.Info("mediabridge starting",
		slog.String("version", "0.1.0"),
		slog.Int("controlPort", cfg.Server.ControlPort),
		slog.Int("webrtcPort", cfg.WebRTC.Port),
		slog.Int("sipPort", cfg.SIP.Port),
		slog.Int("sipMediaPort", cfg.SIP.MediaPort),
		slog.Int("audioWsPort", cfg.AudioWS.Port),
		slog.String("publicIp", cfg.Network.PublicIP),
	)

	// Set up in-memory session store (ephemeral, req 4.8).
	store := session.NewStore()

	// Media session store: holds active media sessions keyed by session ID.
	mediaSessions := &mediaSessionStore{
		sessions: make(map[string]*mediasession.MediaSession),
	}

	// Ringback sender store: holds active ringback tone senders keyed by session ID.
	ringbackSenders := &ringbackStore{
		senders: make(map[string]*ringback.Sender),
	}

	// Set up event WebSocket server (accepts connection from the Server on /events).
	startTime := time.Now()
	eventServer := events.NewServer(events.ServerConfig{}, func() (int, int) {
		return store.Count(), int(time.Since(startTime).Seconds())
	}, logger)
	eventServer.Start()

	// Set up WebRTC engine.
	webrtcEngine, err := webrtc.NewEngine(webrtc.EngineConfig{
		PublicIP: cfg.Network.PublicIP,
		TCPPort:  cfg.WebRTC.Port,
	}, logger)
	if err != nil {
		logger.Error("failed to create WebRTC engine", slog.String("error", err.Error()))
		os.Exit(1)
	}

	// RTP port for SIP media.
	rtpPort := cfg.SIP.MediaPort

	// Start the shared RTP listener on the SDP-advertised port.
	// This single UDP socket receives RTP from all SIP providers and dispatches
	// to the correct session based on the remote sender address.
	rtpListener := sip.NewRTPListener(rtpPort, logger)
	if err := rtpListener.Start(); err != nil {
		logger.Error("failed to start RTP listener", slog.String("error", err.Error()))
		os.Exit(1)
	}

	// tryStartMediaSession attempts to start the media session when both legs are ready.
	// Only handles SIP-based provider legs. WebSocket provider legs use tryStartWsMediaSession.
	tryStartMediaSession := func(sessionID string) {
		sess := store.Get(sessionID)
		if sess == nil {
			return
		}

		// Skip if this session uses a WebSocket provider leg (handled by tryStartWsMediaSession).
		if sess.GetProviderLegType() == session.ProviderLegWebSocket {
			return
		}

		if !sess.BothLegsReady() {
			return
		}

		// Atomically check-and-reserve the slot to prevent double creation
		// when both client_connected and provider_connected fire near-simultaneously.
		mediaSessions.mu.Lock()
		if _, exists := mediaSessions.sessions[sessionID]; exists {
			mediaSessions.mu.Unlock()
			return
		}
		// Reserve the slot with nil to prevent concurrent creation.
		mediaSessions.sessions[sessionID] = nil
		mediaSessions.mu.Unlock()

		// Stop ringback tone if it was playing while waiting for the client.
		ringbackSenders.stopRingback(sessionID)

		providerRTP := sess.GetProviderRTP()
		if providerRTP == nil {
			// Remove the nil reservation.
			mediaSessions.mu.Lock()
			delete(mediaSessions.sessions, sessionID)
			mediaSessions.mu.Unlock()
			return
		}

		// Get the WebRTC peer session for the local audio track.
		peerSession, ok := webrtcEngine.GetSession(sessionID)
		if !ok {
			logger.Warn("peer session not found for media session start",
				slog.String("sessionId", sessionID))
			// Remove the nil reservation.
			mediaSessions.mu.Lock()
			delete(mediaSessions.sessions, sessionID)
			mediaSessions.mu.Unlock()
			return
		}

		// Create and start the media session.
		ms, err := mediasession.New(mediasession.Config{
			SessionID:      sessionID,
			SIPCodec:       providerRTP.Codec,
			SIPClockRate:   providerRTP.CodecClockRate,
			SIPPayloadType: providerRTP.PayloadType,
			RemoteIP:       providerRTP.RemoteIP,
			RemotePort:     providerRTP.RemotePort,
			RTPListener:    rtpListener,
			Logger:         logger,
		})
		if err != nil {
			logger.Error("failed to create media session",
				slog.String("sessionId", sessionID),
				slog.String("error", err.Error()),
			)
			// Remove the nil reservation.
			mediaSessions.mu.Lock()
			delete(mediaSessions.sessions, sessionID)
			mediaSessions.mu.Unlock()
			return
		}

		// Wire the WebRTC local audio track (bridge → client).
		ms.SetLocalTrack(peerSession.AudioTrack())

		// Start the media session (registers RTP, wires writers, starts bridge playout).
		// Must happen BEFORE SetOnTrackHandler so that when client audio arrives,
		// the sipWriter is already connected and packets aren't dropped.
		if err := ms.Start(); err != nil {
			logger.Error("failed to start media session",
				slog.String("sessionId", sessionID),
				slog.String("error", err.Error()),
			)
			// Remove the nil reservation.
			mediaSessions.mu.Lock()
			delete(mediaSessions.sessions, sessionID)
			mediaSessions.mu.Unlock()
			return
		}

		// Wire the WebRTC OnTrack handler (client → bridge).
		// When the client sends audio, read RTP packets and feed them to the bridge.
		peerSession.SetOnTrackHandler(func(track *webrtcPkg.TrackRemote, receiver *webrtcPkg.RTPReceiver) {
			logger.Info("wiring client audio track to bridge",
				slog.String("sessionId", sessionID),
				slog.String("codec", track.Codec().MimeType),
			)
			go func() {
				buf := make([]byte, 1500)
				for {
					n, _, readErr := track.Read(buf)
					if readErr != nil {
						logger.Debug("client track read ended",
							slog.String("sessionId", sessionID),
							slog.String("error", readErr.Error()),
						)
						return
					}
					// Parse the RTP packet and forward to media session.
					pkt := &rtp.Packet{}
					if err := pkt.Unmarshal(buf[:n]); err != nil {
						continue
					}
					ms.HandleClientRTP(pkt)
				}
			}()
		})

		mediaSessions.mu.Lock()
		mediaSessions.sessions[sessionID] = ms
		mediaSessions.mu.Unlock()

		// Update session status.
		sess.SetStatus(session.StatusActive)

		logger.Info("media session started — audio bridging active",
			slog.String("sessionId", sessionID),
		)

		eventServer.EmitSessionEvent(sessionID, "bridging_active", "")
	}

	// stopMediaSession tears down the media session for a given session.
	stopMediaSession := func(sessionID string) {
		// Stop ringback tone if still playing.
		ringbackSenders.stopRingback(sessionID)

		mediaSessions.mu.Lock()
		ms, exists := mediaSessions.sessions[sessionID]
		if exists {
			delete(mediaSessions.sessions, sessionID)
		}
		mediaSessions.mu.Unlock()

		if exists && ms != nil {
			ms.Stop()
			logger.Info("media session stopped",
				slog.String("sessionId", sessionID),
			)
		}
	}

	// Set up TLS certificate manager for SIP-over-TLS (SIPS).
	certMgr := sip.NewCertManager(sip.CertManagerConfig{
		CertPath: cfg.SIP.TLS.CertPath,
		KeyPath:  cfg.SIP.TLS.KeyPath,
	}, logger)
	if err := certMgr.LoadOrGenerate(); err != nil {
		logger.Error("failed to initialize TLS certificate manager", slog.String("error", err.Error()))
		os.Exit(1)
	}
	certMgr.StartWatching(context.Background())

	// Set up SIP User Agent Server (accepts incoming SIP INVITEs from providers).
	sipUAS := sip.NewUAS(sip.UASConfig{
		Port:        cfg.SIP.Port,
		TLSPort:     cfg.SIP.TLS.Port,
		MediaPort:   cfg.SIP.MediaPort,
		PublicIP:    cfg.Network.PublicIP,
		AllowedIPs:  cfg.SIP.AllowedIPs,
		CertManager: certMgr,
	}, func(sessionID string) bool {
		return store.Get(sessionID) != nil
	}, func(event sip.UASEvent) {
		switch event.Type {
		case sip.EventProviderConnected:
			// Store the provider's RTP info on the session.
			sess := store.Get(event.SessionID)
			if sess != nil {
				sess.SetProviderRTP(&session.ProviderRTPInfo{
					RemoteIP:       event.RemoteIP,
					RemotePort:     event.RemotePort,
					Codec:          event.Codec.Name,
					CodecClockRate: event.Codec.ClockRate,
					PayloadType:    uint8(event.Codec.PayloadType),
				})

				// Start ringback tone if the session has ringback enabled and the
				// client has not connected yet (caller is waiting for the user to answer).
				if sess.Options.Ringback && !sess.ClientConnected {
					// Register an RTP transport so we can send packets to the provider.
					rtpTransport, err := rtpListener.RegisterSession(
						event.RemoteIP, event.RemotePort, nil,
					)
					if err == nil {
						sender := ringback.NewSender(ringback.SenderConfig{
							Cadence:     ringback.CadenceType(cfg.Audio.RingbackCadence),
							Writer:      rtpTransport,
							PayloadType: uint8(event.Codec.PayloadType),
							Logger:      logger,
						})

						ringbackSenders.mu.Lock()
						ringbackSenders.senders[event.SessionID] = sender
						ringbackSenders.mu.Unlock()

						sender.Start()
						logger.Info("ringback tone started for waiting caller",
							slog.String("sessionId", event.SessionID),
							slog.String("cadence", cfg.Audio.RingbackCadence),
						)
					} else {
						logger.Warn("failed to register RTP for ringback",
							slog.String("sessionId", event.SessionID),
							slog.String("error", err.Error()),
						)
					}
				}
			}
			eventServer.EmitSessionEvent(event.SessionID, "provider_connected", "")
			// Try to start media session if both legs are ready.
			tryStartMediaSession(event.SessionID)

		case sip.EventProviderDisconnected:
			stopMediaSession(event.SessionID)
			eventServer.EmitSessionEvent(event.SessionID, "provider_disconnected", event.Reason)
		}
	}, logger)

	if err := sipUAS.Start(); err != nil {
		logger.Error("failed to start SIP UAS", slog.String("error", err.Error()))
		os.Exit(1)
	}

	// Set up audio WebSocket server for providers that stream audio over WebSocket.
	audioWsHandler := audiows.NewHandler(audiows.Config{
		Port: cfg.AudioWS.Port,
	}, store, eventServer, logger)

	// Set up 46elks Realtime Voice API handler on the same audio WS server.
	elks46Handler := audiows.NewElks46Handler(store, eventServer, logger)

	// Wire audio callbacks for both generic and 46elks handlers.
	audioWsHandler.SetOnAudio(func(sessionID string, pcmData []byte) {
		mediaSessions.mu.RLock()
		ms := mediaSessions.sessions[sessionID]
		mediaSessions.mu.RUnlock()
		if ms != nil {
			ms.Bridge().HandleProviderPCM16k(pcmData)
		}
	})

	elks46Handler.SetOnAudio(func(sessionID string, pcmData []byte) {
		mediaSessions.mu.RLock()
		ms := mediaSessions.sessions[sessionID]
		mediaSessions.mu.RUnlock()
		if ms != nil {
			ms.Bridge().HandleProviderPCM16k(pcmData)
		}
	})

	// Start audio WebSocket server with both generic and 46elks endpoints.
	go func() {
		mux := http.NewServeMux()
		mux.Handle("/audio/46elks", elks46Handler)
		if err := audioWsHandler.ListenAndServeWithMux(mux); err != nil {
			logger.Error("audio ws server error", slog.String("error", err.Error()))
		}
	}()

	// tryStartWsMediaSession starts a media session using the PCM/WebSocket bridge path.
	tryStartWsMediaSession := func(sessionID string) {
		sess := store.Get(sessionID)
		if sess == nil || !sess.ClientConnected {
			return
		}

		// Stop ringback tone if it was playing while waiting for the client.
		ringbackSenders.stopRingback(sessionID)

		// Check if media session already exists.
		mediaSessions.mu.Lock()
		if _, exists := mediaSessions.sessions[sessionID]; exists {
			mediaSessions.mu.Unlock()
			return
		}
		mediaSessions.sessions[sessionID] = nil
		mediaSessions.mu.Unlock()

		peerSession, ok := webrtcEngine.GetSession(sessionID)
		if !ok {
			logger.Warn("peer session not found for WS media session start",
				slog.String("sessionId", sessionID))
			mediaSessions.mu.Lock()
			delete(mediaSessions.sessions, sessionID)
			mediaSessions.mu.Unlock()
			return
		}

		// Create a media session configured for WebSocket audio (PCM, not SIP RTP).
		// Use G.711 µ-law settings since the bridge uses PCMU internally for WebRTC.
		ms, err := mediasession.New(mediasession.Config{
			SessionID:      sessionID,
			SIPCodec:       "PCMU",
			SIPClockRate:   8000,
			SIPPayloadType: 0,
			RemoteIP:       "127.0.0.1", // Not used for WS path
			RemotePort:     0,           // Not used for WS path
			RTPListener:    rtpListener,
			Logger:         logger,
		})
		if err != nil {
			logger.Error("failed to create WS media session",
				slog.String("sessionId", sessionID),
				slog.String("error", err.Error()),
			)
			mediaSessions.mu.Lock()
			delete(mediaSessions.sessions, sessionID)
			mediaSessions.mu.Unlock()
			return
		}

		// Wire the WebRTC local audio track (bridge → client).
		ms.SetLocalTrack(peerSession.AudioTrack())

		// Set up PCM writer to send audio back to provider via audio WS.
		ms.Bridge().SetPCMWriter(bridge.PCMWriterFunc(func(data []byte) error {
			// Try 46elks handler first, then generic handler.
			if elks46Handler.IsConnected(sessionID) {
				return elks46Handler.SendAudioFrame(sessionID, data)
			}
			if audioWsHandler.IsConnected(sessionID) {
				return audioWsHandler.SendAudioFrame(sessionID, data)
			}
			return nil
		}))

		// Start the bridge (jitter playout loop — though for WS we write directly).
		ms.Bridge().SetWebRTCWriter(bridge.RTPWriterFunc(func(pkt *rtp.Packet) error {
			track := peerSession.AudioTrack()
			if track != nil {
				return track.WriteRTP(pkt)
			}
			return nil
		}))
		ms.Bridge().Start()

		// Wire the WebRTC OnTrack handler (client → provider via PCM).
		peerSession.SetOnTrackHandler(func(track *webrtcPkg.TrackRemote, receiver *webrtcPkg.RTPReceiver) {
			logger.Info("wiring client audio track to WS bridge",
				slog.String("sessionId", sessionID),
				slog.String("codec", track.Codec().MimeType),
			)
			go func() {
				buf := make([]byte, 1500)
				for {
					n, _, readErr := track.Read(buf)
					if readErr != nil {
						return
					}
					pkt := &rtp.Packet{}
					if err := pkt.Unmarshal(buf[:n]); err != nil {
						continue
					}
					ms.Bridge().HandleClientRTPForPCM(pkt)
				}
			}()
		})

		mediaSessions.mu.Lock()
		mediaSessions.sessions[sessionID] = ms
		mediaSessions.mu.Unlock()

		sess.SetStatus(session.StatusActive)

		logger.Info("WS media session started — audio bridging active",
			slog.String("sessionId", sessionID),
		)

		eventServer.EmitSessionEvent(sessionID, "bridging_active", "")
	}

	// Now that tryStartWsMediaSession is defined, wire the onConnect callback.
	audioWsHandler.SetOnConnect(func(sessionID string) {
		sess := store.Get(sessionID)
		if sess != nil {
			sess.SetProviderRTP(&session.ProviderRTPInfo{
				RemoteIP:       "127.0.0.1",
				RemotePort:     0,
				Codec:          "PCMU",
				CodecClockRate: 8000,
				PayloadType:    0,
			})

			// Start ringback tone if session has ringback enabled and client not yet connected.
			if sess.Options.Ringback && !sess.ClientConnected {
				sender := ringback.NewSender(ringback.SenderConfig{
					Cadence:   ringback.CadenceType(cfg.Audio.RingbackCadence),
					SessionID: sessionID,
					PCMWriter: ringback.PCMWriterFunc(func(sid string, data []byte) error {
						return audioWsHandler.SendAudioFrame(sid, data)
					}),
					Logger: logger,
				})

				ringbackSenders.mu.Lock()
				ringbackSenders.senders[sessionID] = sender
				ringbackSenders.mu.Unlock()

				sender.Start()
				logger.Info("ringback tone started for waiting caller (audio WS)",
					slog.String("sessionId", sessionID),
					slog.String("cadence", cfg.Audio.RingbackCadence),
				)
			}
		}
		tryStartWsMediaSession(sessionID)
	})

	elks46Handler.SetOnConnect(func(sessionID string) {
		sess := store.Get(sessionID)
		if sess != nil {
			sess.SetProviderRTP(&session.ProviderRTPInfo{
				RemoteIP:       "127.0.0.1",
				RemotePort:     0,
				Codec:          "PCMU",
				CodecClockRate: 8000,
				PayloadType:    0,
			})

			// Start ringback tone if session has ringback enabled and client not yet connected.
			if sess.Options.Ringback && !sess.ClientConnected {
				sender := ringback.NewSender(ringback.SenderConfig{
					Cadence:   ringback.CadenceType(cfg.Audio.RingbackCadence),
					SessionID: sessionID,
					PCMWriter: ringback.PCMWriterFunc(func(sid string, data []byte) error {
						return elks46Handler.SendAudioFrame(sid, data)
					}),
					Logger: logger,
				})

				ringbackSenders.mu.Lock()
				ringbackSenders.senders[sessionID] = sender
				ringbackSenders.mu.Unlock()

				sender.Start()
				logger.Info("ringback tone started for waiting caller (46elks)",
					slog.String("sessionId", sessionID),
					slog.String("cadence", cfg.Audio.RingbackCadence),
				)
			}
		}
		tryStartWsMediaSession(sessionID)
	})

	// Set up HTTP server for ControlAPI (localhost only).
	mux := http.NewServeMux()

	// Register ControlAPI handlers (session management + health).
	apiHandler := controlapi.NewHandler(store, cfg, startTime, logger)

	// Wire up session teardown: when the Server destroys a session via the
	// control API, close the WebRTC peer connection and SIP dialog so that the
	// remote client detects the disconnection immediately via ICE failure.
	apiHandler.SetSessionTeardown(func(sessionID string) {
		// Close WebRTC peer connection — causes ICE failure on the client side.
		if err := webrtcEngine.RemoveSession(sessionID); err != nil {
			logger.Debug("teardown: WebRTC session not found (may already be closed)",
				slog.String("sessionId", sessionID),
				slog.String("error", err.Error()),
			)
		}

		// Terminate SIP dialog (send BYE to provider).
		if err := sipUAS.SendBye(sessionID); err != nil {
			logger.Debug("teardown: SIP dialog not found (may already be terminated)",
				slog.String("sessionId", sessionID),
				slog.String("error", err.Error()),
			)
		}

		// Close 46elks audio WebSocket (sends bye to 46elks so they end the call).
		elks46Handler.CloseConnection(sessionID)

		// Stop the media session if still active.
		stopMediaSession(sessionID)
	})

	apiHandler.Register(mux)

	// Register the event WebSocket endpoint on the ControlAPI server.
	// The Server (svarla) connects here to receive real-time session events.
	mux.Handle("/events", eventServer)

	// Set WebRTC engine event handler.
	webrtcEngine.SetEventHandler(func(event webrtc.SessionEvent) {
		eventServer.EmitSessionEvent(event.SessionID, string(event.Type), event.Reason)

		switch event.Type {
		case webrtc.EventClientConnected:
			// Mark client as connected on the session.
			sess := store.Get(event.SessionID)
			if sess != nil {
				sess.SetClientConnected(true)
			}
			// Try to start media session if both legs are ready (SIP path).
			tryStartMediaSession(event.SessionID)
			// Also try WS media session if audio WS provider is connected.
			if audioWsHandler.IsConnected(event.SessionID) || elks46Handler.IsConnected(event.SessionID) {
				tryStartWsMediaSession(event.SessionID)
			}

		case webrtc.EventClientDisconnected:
			stopMediaSession(event.SessionID)
		}
	})
	webrtcHandler := webrtc.NewHandler(webrtcEngine, logger)
	webrtcHandler.RegisterRoutes(mux)

	controlAddr := fmt.Sprintf("0.0.0.0:%d", cfg.Server.ControlPort)
	server := &http.Server{
		Addr:              controlAddr,
		Handler:           mux,
		ReadHeaderTimeout: readHeaderTimeout,
		BaseContext: func(_ net.Listener) context.Context {
			return context.Background()
		},
	}

	// Start HTTP server in a goroutine.
	go func() {
		logger.Info("controlAPI listening", slog.String("addr", controlAddr))
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("controlAPI server error", slog.String("error", err.Error()))
			os.Exit(1)
		}
	}()

	// Wait for shutdown signal.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	sig := <-sigCh
	logger.Info("shutdown signal received", slog.String("signal", sig.String()))

	// Graceful shutdown with timeout.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	var wg sync.WaitGroup

	// Stop all active media sessions.
	wg.Add(1)
	go func() {
		defer wg.Done()
		// Stop all active ringback senders.
		ringbackSenders.mu.Lock()
		for id, sender := range ringbackSenders.senders {
			if sender != nil {
				sender.Stop()
				logger.Info("ringback sender stopped during shutdown", slog.String("sessionId", id))
			}
		}
		ringbackSenders.senders = make(map[string]*ringback.Sender)
		ringbackSenders.mu.Unlock()

		mediaSessions.mu.Lock()
		for id, ms := range mediaSessions.sessions {
			if ms != nil {
				ms.Stop()
				logger.Info("media session stopped during shutdown", slog.String("sessionId", id))
			}
		}
		mediaSessions.sessions = make(map[string]*mediasession.MediaSession)
		mediaSessions.mu.Unlock()
	}()

	// Stop the shared RTP listener.
	wg.Add(1)
	go func() {
		defer wg.Done()
		rtpListener.Stop()
	}()

	// Shutdown ControlAPI HTTP server.
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := server.Shutdown(shutdownCtx); err != nil {
			logger.Error("controlAPI shutdown error", slog.String("error", err.Error()))
		}
	}()

	// Shutdown WebRTC engine.
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := webrtcEngine.Close(); err != nil {
			logger.Error("webrtc engine shutdown error", slog.String("error", err.Error()))
		}
	}()

	// Shutdown SIP UAS (sends BYE on active dialogs).
	wg.Add(1)
	go func() {
		defer wg.Done()
		sipUAS.Shutdown(shutdownCtx)
	}()

	// Shutdown audio WebSocket server.
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := audioWsHandler.Shutdown(shutdownCtx); err != nil {
			logger.Error("audio ws shutdown error", slog.String("error", err.Error()))
		}
	}()

	// Shutdown event WebSocket client.
	wg.Add(1)
	go func() {
		defer wg.Done()
		eventServer.Shutdown()
		logger.Info("event websocket server shut down")
	}()

	// Wait for all shutdown tasks to complete or timeout.
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		logger.Info("graceful shutdown completed")
	case <-shutdownCtx.Done():
		logger.Warn("shutdown timed out, forcing exit")
	}
}

