package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
	"path/filepath"
	"time"

	"github.com/packetmoose/svarla/modem-gateway/internal/bridge"
	"github.com/packetmoose/svarla/modem-gateway/internal/buffer"
	"github.com/packetmoose/svarla/modem-gateway/internal/config"
	"github.com/packetmoose/svarla/modem-gateway/internal/identity"
	"github.com/packetmoose/svarla/modem-gateway/internal/shutdown"
	"github.com/packetmoose/svarla/modem-gateway/internal/signaling"
	"github.com/packetmoose/svarla/modem-gateway/internal/sms"
)

// run is the application entrypoint. It initializes subsystems, starts signaling
// and modem lifecycle in parallel, then blocks until the context is cancelled.
func run(ctx context.Context, configPath string) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}

	logFile, err := config.SetupLogging(cfg.Log)
	if err != nil {
		return fmt.Errorf("logging setup: %w", err)
	}
	if logFile != nil {
		defer logFile.Close()
	}

	log.Printf("modem-gateway %s (commit: %s, built: %s)", version, commit, buildDate)

	// Identity (Ed25519 keypair).
	configDir := filepath.Dir(configPath)
	keyPath := filepath.Join(configDir, "modem-gateway.key")

	id := identity.New(keyPath)
	keyExisted := id.Exists()
	if keyExisted {
		if err := id.Load(); err != nil {
			return fmt.Errorf("identity load: %w", err)
		}
		log.Println("Identity loaded from", keyPath)
	} else {
		if err := id.Generate(); err != nil {
			return fmt.Errorf("identity generate: %w", err)
		}
		log.Println("New identity generated and saved to", keyPath)
		log.Println("Public key (base64):", id.PublicKeyBase64())
	}

	// TLS.
	tlsConfig, err := signaling.BuildTLSConfig(cfg.TLS)
	if err != nil {
		return fmt.Errorf("TLS config: %w", err)
	}

	// Signaling client.
	// If the key file pre-existed, pairing already succeeded — use challenge-response auth
	// regardless of whether pairingSecret is still in the config.
	pairingSecret := cfg.Connection.PairingSecret
	if keyExisted && pairingSecret != "" {
		log.Println("[signaling] key file exists; ignoring pairingSecret (already paired)")
		pairingSecret = ""
	}
	authenticator := signaling.NewPairingAuthenticator(id, pairingSecret)
	sigClient := signaling.NewReconnectingClient(cfg.Connection.Endpoint, tlsConfig, authenticator)

	// Buffers.
	missedCallBuf, err := signaling.NewMissedCallBuffer(filepath.Join(configDir, "missed-calls.jsonl"))
	if err != nil {
		log.Printf("WARNING: failed to create missed call buffer: %v", err)
	}

	smsBuffer, err := buffer.NewKeyed[sms.IncomingSMS](
		filepath.Join(configDir, "sms-buffer.jsonl"),
		buffer.DefaultCapacity,
		func(m sms.IncomingSMS) string { return m.MessageID },
	)
	if err != nil {
		log.Printf("WARNING: failed to create SMS buffer: %v", err)
	}

	bridgeFactory := func() *bridge.AudioBridge {
		return bridge.New(tlsConfig)
	}

	// SMS delivery pump: durable, buffer-first, ack-to-remove delivery of
	// inbound SMS. Persists received messages, sends them to the server, and
	// removes them from the buffer only on server ack.
	smsDelivery := NewSMSDelivery(smsBuffer, sigClient)
	smsDelivery.Start(ctx)

	// Modem lifecycle — retries forever, monitors health, manages subsystems.
	modemLife := NewModemLifecycle(ModemLifecycleConfig{
		Cfg:           cfg,
		SigClient:     sigClient,
		SmsBuffer:     smsBuffer,
		SmsDelivery:   smsDelivery,
		BridgeFactory: bridgeFactory,
	})
	modemLife.Start(ctx)

	// Register signaling handlers before Start() so no messages are missed.
	// Subsystem pointers are accessed via ModemLifecycle getters (thread-safe, nil when modem absent).
	sigClient.OnMessage(func(msg signaling.Message) {
		dispatchSignalingMessage(msg, modemLife.SMSManager(), modemLife.USSDManager(), modemLife.CallManager(), sigClient, smsDelivery)
	})

	sigClient.OnReconnect(func() {
		handleReconnect(sigClient, modemLife.NumberReporter(), missedCallBuf, smsDelivery)
	})

	sigClient.OnDisconnect(func() {
		log.Println("Signaling disconnected")
		if cm := modemLife.CallManager(); cm != nil {
			cm.HandleDisconnect()
		}
	})

	// Start signaling (non-blocking, retries in background).
	if err := sigClient.Start(ctx); err != nil {
		return fmt.Errorf("signaling start: %w", err)
	}

	// Shutdown coordinator.
	shutdownCoord := shutdown.NewCoordinator(shutdown.CoordinatorConfig{
		CallTerminator:   modemLife,
		SMSBuffer:        smsBuffer,
		MissedCallBuffer: missedCallBuf,
		SignalingClient:   sigClient,
		Modem:            nil, // modem lifecycle is managed by ReconnectManager
	})

	log.Println("modem-gateway is running")
	<-ctx.Done()

	// Stop the SMS delivery pump first so it is not concurrently sending or
	// mutating the buffer while we flush it. Unacked messages remain buffered
	// on disk and are re-sent on the next run.
	smsDelivery.Stop()

	// Flush SMS and missed call buffers to disk immediately. This is fast
	// (local file I/O only) and must happen before the potentially slow modem
	// teardown to guarantee persistence even if the force-kill timer fires.
	shutdownCoord.FlushBuffers()

	// Stop modem lifecycle (halts reconnect loop, tears down subsystems).
	modemLife.Stop()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 9*time.Second)
	defer shutdownCancel()

	if err := shutdownCoord.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}

	return nil
}

// Ensure *tls.Config usage is clear (avoid unused import if tlsConfig is nil).
var _ = (*tls.Config)(nil)
