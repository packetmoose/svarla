package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/packetmoose/svarla/modem-gateway/internal/audio"
	"github.com/packetmoose/svarla/modem-gateway/internal/bridge"
	"github.com/packetmoose/svarla/modem-gateway/internal/buffer"
	"github.com/packetmoose/svarla/modem-gateway/internal/config"
	"github.com/packetmoose/svarla/modem-gateway/internal/identity"
	"github.com/packetmoose/svarla/modem-gateway/internal/modem"
	"github.com/packetmoose/svarla/modem-gateway/internal/shutdown"
	"github.com/packetmoose/svarla/modem-gateway/internal/signaling"
	"github.com/packetmoose/svarla/modem-gateway/internal/sms"
	"github.com/packetmoose/svarla/modem-gateway/internal/ussd"
)

// Build-time variables set via ldflags.
var (
	version   = "dev"
	commit    = "unknown"
	buildDate = "unknown"
)

func main() {
	showVersion := flag.Bool("version", false, "Print version information and exit")
	generateConfig := flag.Bool("generate-config", false, "Generate a default configuration file and exit")
	configPath := flag.String("config", "./modem-gateway.yaml", "Path to configuration file")
	flag.Parse()

	if *showVersion {
		fmt.Printf("modem-gateway %s (commit: %s, built: %s)\n", version, commit, buildDate)
		os.Exit(0)
	}

	if *generateConfig {
		if err := config.GenerateDefault(*configPath); err != nil {
			fmt.Fprintf(os.Stderr, "Error generating config: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Default configuration written to %s\n", *configPath)
		fmt.Println("Edit the file to set your connection endpoint and modem serial port, then start the binary.")
		os.Exit(0)
	}

	// Set up signal handling for graceful shutdown (SIGTERM, SIGINT).
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		sig := <-sigCh
		fmt.Printf("Received signal %s, initiating graceful shutdown...\n", sig)
		cancel()

		// Force-exit after 10 seconds if graceful shutdown does not complete.
		time.AfterFunc(10*time.Second, func() {
			fmt.Fprintln(os.Stderr, "Graceful shutdown timed out after 10s, forcing exit")
			os.Exit(1)
		})
	}()

	if err := run(ctx, *configPath); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

// run is the main application entrypoint. It loads configuration, initializes
// subsystems in dependency order, and blocks until the context is cancelled (via signal).
func run(ctx context.Context, configPath string) error {
	// ─── 1. Load configuration ───────────────────────────────────────────
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}

	// ─── 2. Set up logging ───────────────────────────────────────────────
	logFile, err := config.SetupLogging(cfg.Log)
	if err != nil {
		return fmt.Errorf("logging setup: %w", err)
	}
	if logFile != nil {
		defer logFile.Close()
	}

	log.Printf("modem-gateway %s (commit: %s, built: %s)", version, commit, buildDate)

	// ─── 3. Identity (Ed25519 keypair) ───────────────────────────────────
	// The key file lives next to the config file by convention.
	configDir := filepath.Dir(configPath)
	keyPath := filepath.Join(configDir, "modem-gateway.key")

	id := identity.New(keyPath)
	if id.Exists() {
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

	// ─── 4. TLS configuration ────────────────────────────────────────────
	tlsConfig, err := signaling.BuildTLSConfig(cfg.TLS)
	if err != nil {
		return fmt.Errorf("TLS config: %w", err)
	}

	// ─── 5. Open modem serial port ───────────────────────────────────────
	port, err := modem.OpenSerialPortWithTimeout(cfg.Modem.SerialPort, 0, 5*time.Second)
	if err != nil {
		return fmt.Errorf("modem serial port: %w", err)
	}
	log.Printf("Opened modem serial port: %s", cfg.Modem.SerialPort)

	// ─── 6. Create modem and start reader/dispatcher ─────────────────────
	mdm := modem.New(port)
	mdm.Open()

	// ─── 7. State machine ────────────────────────────────────────────────
	sm := modem.NewStateMachine()
	sm.RegisterURCHandler(mdm)
	if err := sm.TransitionToInitializing(); err != nil {
		mdm.Close()
		return fmt.Errorf("state machine: %w", err)
	}

	// ─── 8. Modem initialization sequence ────────────────────────────────
	initResult, err := modem.RunInitSequence(ctx, mdm)
	if err != nil {
		mdm.Close()
		return fmt.Errorf("modem init: %w", err)
	}
	log.Printf("Modem ready: %s %s (firmware: %s)",
		initResult.Info.Manufacturer, initResult.Info.Model, initResult.Info.Firmware)
	if initResult.Info.UnsupportedWarning != "" {
		log.Printf("WARNING: %s", initResult.Info.UnsupportedWarning)
	}

	// ─── 9. Audio pipeline (if voice enabled) ────────────────────────────
	var audioPipeline *audio.Pipeline
	voiceEnabled := cfg.IsVoiceEnabled()

	if voiceEnabled {
		sampleRate, err := audio.NegotiateSampleRate(mdm)
		if err != nil {
			log.Printf("Audio sample rate negotiation failed (voice disabled): %v", err)
			voiceEnabled = false
		} else {
			log.Printf("Audio sample rate: %d Hz", sampleRate)

			pcmPortPath := cfg.Modem.PcmAudioPort
			if pcmPortPath == "" {
				log.Println("WARNING: voiceEnabled but no pcmAudioPort configured, voice calls will fail")
			} else {
				pcmPort, err := modem.OpenSerialPort(pcmPortPath, 0)
				if err != nil {
					log.Printf("WARNING: failed to open PCM audio port %s: %v (voice disabled)", pcmPortPath, err)
					voiceEnabled = false
				} else {
					audioPipeline = audio.New(pcmPort, mdm, sampleRate)
					log.Printf("Audio pipeline initialized on %s", pcmPortPath)
				}
			}
		}
	}

	// ─── 10. Signaling authenticator ─────────────────────────────────────
	authenticator := signaling.NewPairingAuthenticator(id, cfg.Connection.PairingSecret)

	// ─── 11. Signaling client (reconnecting) ─────────────────────────────
	sigClient := signaling.NewReconnectingClient(cfg.Connection.Endpoint, tlsConfig, authenticator)
	if err := sigClient.Start(ctx); err != nil {
		mdm.Close()
		return fmt.Errorf("signaling connect: %w", err)
	}
	log.Println("Signaling WebSocket connected and authenticated")

	// ─── 12. Missed call buffer ──────────────────────────────────────────
	missedCallBufPath := filepath.Join(configDir, "missed-calls.jsonl")
	missedCallBuf, err := signaling.NewMissedCallBuffer(missedCallBufPath)
	if err != nil {
		log.Printf("WARNING: failed to create missed call buffer: %v", err)
	}

	// ─── 13. SMS buffer (for offline buffering) ──────────────────────────
	smsBufPath := filepath.Join(configDir, "sms-buffer.jsonl")
	smsBuffer, err := buffer.New[sms.IncomingSMS](smsBufPath, buffer.DefaultCapacity)
	if err != nil {
		log.Printf("WARNING: failed to create SMS buffer: %v", err)
	}

	// ─── 14. SMS manager ─────────────────────────────────────────────────
	smsMgr := sms.New(mdm, initResult.TextMode)
	smsMgr.RegisterURCHandlers()
	if err := smsMgr.ConfigureDeliveryReports(); err != nil {
		log.Printf("WARNING: delivery report configuration failed: %v", err)
	}

	// If CNMI <ds>=0 or CNMI failed entirely, delivery reports won't be pushed.
	// Start a periodic poll to check for stored delivery reports.
	var deliveryPollCancel context.CancelFunc
	if initResult.CNMIDeliveryStatus <= 0 {
		var deliveryPollCtx context.Context
		deliveryPollCtx, deliveryPollCancel = context.WithCancel(ctx)
		go func() {
			ticker := time.NewTicker(60 * time.Second)
			defer ticker.Stop()
			// Do an initial poll after a short delay.
			time.Sleep(5 * time.Second)
			smsMgr.PollDeliveryReports()
			for {
				select {
				case <-deliveryPollCtx.Done():
					return
				case <-ticker.C:
					smsMgr.PollDeliveryReports()
				}
			}
		}()
		log.Printf("Delivery report polling enabled (CNMI ds=%d)", initResult.CNMIDeliveryStatus)
	}

	// Forward received SMS to Svarla or buffer when disconnected.
	smsMgr.OnReceived(func(incoming sms.IncomingSMS) {
		if sigClient.IsConnected() {
			payload := struct {
				Type      string `json:"type"`
				MessageID string `json:"messageId"`
				From      string `json:"from"`
				Body      string `json:"body"`
				Timestamp int64  `json:"timestamp"`
			}{
				Type:      signaling.TypeIncomingSMS,
				MessageID: incoming.MessageID,
				From:      incoming.From,
				Body:      incoming.Body,
				Timestamp: incoming.Timestamp.Unix(),
			}
			msg, err := signaling.NewMessage(signaling.TypeIncomingSMS, payload)
			if err != nil {
				log.Printf("Failed to create incoming_sms message: %v", err)
				return
			}
			if err := sigClient.Send(msg); err != nil {
				log.Printf("Failed to send incoming_sms, buffering: %v", err)
				if smsBuffer != nil {
					_ = smsBuffer.Push(incoming)
				}
			}
		} else {
			// Offline — buffer for later delivery.
			if smsBuffer != nil {
				if err := smsBuffer.Push(incoming); err != nil {
					log.Printf("Failed to buffer SMS: %v", err)
				}
			}
		}
	})

	// Forward delivery reports to Svarla.
	smsMgr.OnDeliveryReport(func(report sms.DeliveryReport) {
		if !sigClient.IsConnected() {
			return
		}
		payload := struct {
			Type       string `json:"type"`
			MessageRef int    `json:"messageRef"`
			Status     string `json:"status"`
		}{
			Type:       signaling.TypeDeliveryReport,
			MessageRef: report.MessageRef,
			Status:     report.Status,
		}
		msg, err := signaling.NewMessage(signaling.TypeDeliveryReport, payload)
		if err != nil {
			log.Printf("Failed to create delivery_report message: %v", err)
			return
		}
		if err := sigClient.Send(msg); err != nil {
			log.Printf("Failed to send delivery_report: %v", err)
		}
	})

	// ─── 15. Bridge factory ──────────────────────────────────────────────
	bridgeFactory := func() *bridge.AudioBridge {
		return bridge.New(tlsConfig)
	}

	// ─── 16. Call manager ────────────────────────────────────────────────
	var callManager *signaling.CallManager
	if voiceEnabled && audioPipeline != nil {
		callManager = signaling.NewCallManager(signaling.CallManagerConfig{
			Modem:         mdm,
			StateMachine:  sm,
			SigClient:     sigClient,
			BridgeFactory: bridgeFactory,
			Audio:         audioPipeline,
		})
		log.Println("Call manager initialized (voice enabled)")
	} else {
		log.Println("Voice calls disabled (no audio pipeline)")
	}

	// ─── 17. DTMF handler ────────────────────────────────────────────────
	if callManager != nil {
		_ = signaling.NewDTMFHandler(mdm, sigClient, callManager)
		log.Println("DTMF handler registered")
	}

	// ─── 18. USSD manager ────────────────────────────────────────────────
	ussdMgr := ussd.New(mdm)
	_ = ussdMgr // Used below in message dispatch

	// ─── 19. Number reporter ─────────────────────────────────────────────
	numberReporter := signaling.NewNumberReporter(mdm, sigClient, cfg)
	numberReporter.ReportOnConnect()

	// ─── 20. Status reporter ─────────────────────────────────────────────
	modemInfo := signaling.ModemInfo{
		Model:              initResult.Info.Model,
		Manufacturer:       initResult.Info.Manufacturer,
		Firmware:           initResult.Info.Firmware,
		UnsupportedWarning: initResult.Info.UnsupportedWarning,
	}
	statusReporter := signaling.NewStatusReporter(mdm, sigClient, modemInfo)
	statusReporter.Start(ctx)

	// ─── 21. Message dispatch (signaling → handlers) ─────────────────────
	// Call manager handles its own messages via URC handlers registered in NewCallManager.
	// Register additional signaling message handlers for SMS and USSD.
	sigClient.OnMessage(func(msg signaling.Message) {
		switch msg.Type {
		case signaling.TypeSendSMS:
			handleSendSMS(msg, smsMgr, sigClient)
		case signaling.TypeUSSDRequest:
			handleUSSDRequest(msg, ussdMgr, sigClient)
		}
	})

	// Call manager also needs to handle incoming signaling messages for calls.
	if callManager != nil {
		sigClient.OnMessage(callManager.HandleMessage)
	}

	// ─── 22. Reconnection hooks ──────────────────────────────────────────
	sigClient.OnReconnect(func() {
		log.Println("Signaling reconnected — delivering buffered data")

		// Re-report number on reconnection.
		numberReporter.ReportOnConnect()

		// Deliver buffered missed calls.
		if missedCallBuf != nil {
			if err := missedCallBuf.DeliverAll(sigClient); err != nil {
				log.Printf("Failed to deliver buffered missed calls: %v", err)
			}
		}

		// Deliver buffered SMS.
		if smsBuffer != nil {
			buffered, err := smsBuffer.DrainAll()
			if err != nil {
				log.Printf("Failed to drain SMS buffer: %v", err)
			}
			for _, incoming := range buffered {
				payload := struct {
					Type      string `json:"type"`
					MessageID string `json:"messageId"`
					From      string `json:"from"`
					Body      string `json:"body"`
					Timestamp int64  `json:"timestamp"`
				}{
					Type:      signaling.TypeBufferedSMS,
					MessageID: incoming.MessageID,
					From:      incoming.From,
					Body:      incoming.Body,
					Timestamp: incoming.Timestamp.Unix(),
				}
				msg, err := signaling.NewMessage(signaling.TypeBufferedSMS, payload)
				if err != nil {
					log.Printf("Failed to create buffered_sms message: %v", err)
					continue
				}
				if err := sigClient.Send(msg); err != nil {
					log.Printf("Failed to send buffered_sms: %v", err)
					// Re-buffer on failure — push remaining back.
					_ = smsBuffer.Push(incoming)
				}
			}
		}
	})

	sigClient.OnDisconnect(func() {
		log.Println("Signaling disconnected")
		// If there's a ringing inbound call, reject it since we can't signal.
		if callManager != nil {
			callManager.HandleDisconnect()
		}
	})

	// ─── 23. Shutdown coordinator ────────────────────────────────────────
	shutdownCoord := shutdown.NewCoordinator(shutdown.CoordinatorConfig{
		CallTerminator:   callManager,
		SMSBuffer:        smsBuffer,
		MissedCallBuffer: missedCallBuf,
		SignalingClient:   sigClient,
		Modem:            mdm,
	})

	// ─── Block until shutdown signal ─────────────────────────────────────
	log.Println("modem-gateway is running")
	<-ctx.Done()

	// Perform graceful shutdown with the remaining time before force-exit.
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 9*time.Second)
	defer shutdownCancel()

	// Stop delivery report polling if active.
	if deliveryPollCancel != nil {
		deliveryPollCancel()
	}

	statusReporter.Stop()

	if err := shutdownCoord.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}

	return nil
}

// handleSendSMS processes a send_sms message from Svarla.
func handleSendSMS(msg signaling.Message, smsMgr *sms.Manager, client signaling.MessageSender) {
	var payload struct {
		Type      string `json:"type"`
		RequestID string `json:"requestId"`
		To        string `json:"to"`
		Body      string `json:"body"`
	}
	if err := msg.ParsePayload(&payload); err != nil {
		log.Printf("Failed to parse send_sms payload: %v", err)
		return
	}

	ref, err := smsMgr.Send(payload.To, payload.Body)

	result := struct {
		Type      string `json:"type"`
		RequestID string `json:"requestId"`
		Success   bool   `json:"success"`
		MessageRef int   `json:"messageRef,omitempty"`
		Error     string `json:"error,omitempty"`
	}{
		Type:      signaling.TypeSMSResult,
		RequestID: payload.RequestID,
	}

	if err != nil {
		result.Success = false
		result.Error = err.Error()
	} else {
		result.Success = true
		result.MessageRef = ref
	}

	respMsg, err := signaling.NewMessage(signaling.TypeSMSResult, result)
	if err != nil {
		log.Printf("Failed to create sms_result message: %v", err)
		return
	}
	if err := client.Send(respMsg); err != nil {
		log.Printf("Failed to send sms_result: %v", err)
	}
}

// handleUSSDRequest processes a ussd_request message from Svarla.
func handleUSSDRequest(msg signaling.Message, ussdMgr *ussd.Manager, client signaling.MessageSender) {
	var payload struct {
		Type      string `json:"type"`
		RequestID string `json:"requestId"`
		Code      string `json:"code"`
		Input     string `json:"input"`
		Cancel    bool   `json:"cancel"`
	}
	if err := msg.ParsePayload(&payload); err != nil {
		log.Printf("Failed to parse ussd_request payload: %v", err)
		return
	}

	// Handle cancel request.
	if payload.Cancel {
		err := ussdMgr.Cancel()
		if err != nil {
			sendUSSDError(client, payload.RequestID, err.Error())
		}
		return
	}

	// Handle follow-up input in active session.
	var resp *ussd.Response
	var err error
	if payload.Input != "" {
		resp, err = ussdMgr.SendInput(payload.Input)
	} else {
		resp, err = ussdMgr.Execute(payload.Code)
	}

	if err != nil {
		sendUSSDError(client, payload.RequestID, err.Error())
		return
	}

	response := struct {
		Type          string `json:"type"`
		RequestID     string `json:"requestId"`
		Text          string `json:"text"`
		SessionActive bool   `json:"sessionActive"`
	}{
		Type:          signaling.TypeUSSDResponse,
		RequestID:     payload.RequestID,
		Text:          resp.Text,
		SessionActive: resp.SessionActive,
	}

	respMsg, err := signaling.NewMessage(signaling.TypeUSSDResponse, response)
	if err != nil {
		log.Printf("Failed to create ussd_response message: %v", err)
		return
	}
	if err := client.Send(respMsg); err != nil {
		log.Printf("Failed to send ussd_response: %v", err)
	}
}

// sendUSSDError sends a ussd_error message to Svarla.
func sendUSSDError(client signaling.MessageSender, requestID, reason string) {
	payload := struct {
		Type      string `json:"type"`
		RequestID string `json:"requestId"`
		Error     string `json:"error"`
	}{
		Type:      signaling.TypeUSSDError,
		RequestID: requestID,
		Error:     reason,
	}
	msg, err := signaling.NewMessage(signaling.TypeUSSDError, payload)
	if err != nil {
		log.Printf("Failed to create ussd_error message: %v", err)
		return
	}
	if err := client.Send(msg); err != nil {
		log.Printf("Failed to send ussd_error: %v", err)
	}
}

// Ensure *tls.Config usage is clear (avoid unused import if tlsConfig is nil).
var _ = (*tls.Config)(nil)
