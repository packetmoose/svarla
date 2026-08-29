package main

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/packetmoose/svarla/modem-gateway/internal/audio"
	"github.com/packetmoose/svarla/modem-gateway/internal/bridge"
	"github.com/packetmoose/svarla/modem-gateway/internal/buffer"
	"github.com/packetmoose/svarla/modem-gateway/internal/config"
	"github.com/packetmoose/svarla/modem-gateway/internal/modem"
	"github.com/packetmoose/svarla/modem-gateway/internal/signaling"
	"github.com/packetmoose/svarla/modem-gateway/internal/sms"
	"github.com/packetmoose/svarla/modem-gateway/internal/ussd"
)

// pcmReadTimeout bounds each blocking Read() on the PCM audio port so the
// capture goroutine can observe the stop signal and exit promptly when a call
// ends. A short timeout is transparent to streaming (the loop simply reads
// whatever is available or loops on timeout).
const pcmReadTimeout = 100 * time.Millisecond

// ModemLifecycle manages the modem connection lifecycle using ReconnectManager.
// It sets up subsystems when the modem connects and tears them down on disconnect.
// The modem is retried forever with exponential backoff (2s–30s).
type ModemLifecycle struct {
	cfg           *config.Config
	sigClient     *signaling.ReconnectingClient
	smsBuffer     *buffer.PersistentBuffer[sms.IncomingSMS]
	bridgeFactory func() *bridge.AudioBridge
	ctx           context.Context

	rm *modem.ReconnectManager

	// Mutable subsystem pointers — accessed by signaling handlers via getters.
	mu             sync.RWMutex
	smsMgr         *sms.Manager
	ussdMgr        *ussd.Manager
	callManager    *signaling.CallManager
	numberReporter *signaling.NumberReporter
	statusReporter *signaling.StatusReporter

	// Cleanup handles for the current modem session.
	deliveryPollCancel context.CancelFunc
}

// ModemLifecycleConfig holds dependencies for ModemLifecycle.
type ModemLifecycleConfig struct {
	Cfg           *config.Config
	SigClient     *signaling.ReconnectingClient
	SmsBuffer     *buffer.PersistentBuffer[sms.IncomingSMS]
	BridgeFactory func() *bridge.AudioBridge
}

// NewModemLifecycle creates a new ModemLifecycle. Call Start to begin.
func NewModemLifecycle(cfg ModemLifecycleConfig) *ModemLifecycle {
	return &ModemLifecycle{
		cfg:           cfg.Cfg,
		sigClient:     cfg.SigClient,
		smsBuffer:     cfg.SmsBuffer,
		bridgeFactory: cfg.BridgeFactory,
	}
}

// Start begins the modem connection lifecycle in a goroutine.
// The ReconnectManager retries forever with exponential backoff and monitors
// health every 10 seconds once connected.
func (ml *ModemLifecycle) Start(ctx context.Context) {
	ml.ctx = ctx

	callbacks := modem.ReconnectCallbacks{
		OnConnected:    ml.onModemConnected,
		OnDisconnected: ml.onModemDisconnected,
		OnCallLost:     ml.onCallLost,
	}

	ml.rm = modem.NewReconnectManager(
		ml.cfg.Modem.SerialPort,
		ml.cfg.Modem.PcmAudioPort,
		0, // use default baud rate
		callbacks,
	)

	go ml.rm.Start(ctx)
}

// Stop halts the reconnect manager and cleans up subsystems.
func (ml *ModemLifecycle) Stop() {
	if ml.rm != nil {
		ml.rm.Stop()
	}
	ml.teardownSubsystems()
}

// SMSManager returns the current SMS manager (nil if modem not connected).
func (ml *ModemLifecycle) SMSManager() *sms.Manager {
	ml.mu.RLock()
	defer ml.mu.RUnlock()
	return ml.smsMgr
}

// USSDManager returns the current USSD manager (nil if modem not connected).
func (ml *ModemLifecycle) USSDManager() *ussd.Manager {
	ml.mu.RLock()
	defer ml.mu.RUnlock()
	return ml.ussdMgr
}

// CallManager returns the current call manager (nil if modem not connected or voice disabled).
func (ml *ModemLifecycle) CallManager() *signaling.CallManager {
	ml.mu.RLock()
	defer ml.mu.RUnlock()
	return ml.callManager
}

// NumberReporter returns the current number reporter (nil if modem not connected).
func (ml *ModemLifecycle) NumberReporter() *signaling.NumberReporter {
	ml.mu.RLock()
	defer ml.mu.RUnlock()
	return ml.numberReporter
}

// StatusReporter returns the current status reporter (nil if modem not connected).
func (ml *ModemLifecycle) StatusReporter() *signaling.StatusReporter {
	ml.mu.RLock()
	defer ml.mu.RUnlock()
	return ml.statusReporter
}

// Modem returns the current modem instance via the ReconnectManager.
func (ml *ModemLifecycle) Modem() *modem.Modem {
	if ml.rm == nil {
		return nil
	}
	return ml.rm.Modem()
}

// HasActiveCall returns true if the current call manager has an active call.
// Satisfies the shutdown.CallTerminator interface.
func (ml *ModemLifecycle) HasActiveCall() bool {
	ml.mu.RLock()
	cm := ml.callManager
	ml.mu.RUnlock()
	return cm != nil && cm.HasActiveCall()
}

// Shutdown terminates the active call if one exists.
// Satisfies the shutdown.CallTerminator interface.
func (ml *ModemLifecycle) Shutdown() {
	ml.mu.RLock()
	cm := ml.callManager
	ml.mu.RUnlock()
	if cm != nil {
		cm.Shutdown()
	}
}

// onModemConnected is called by ReconnectManager when the modem is detected
// and initialized. It sets up all telephony subsystems.
func (ml *ModemLifecycle) onModemConnected(initResult *modem.InitResult) {
	m := ml.rm.Modem()
	if m == nil {
		return
	}

	log.Println("Modem connected — initializing subsystems")

	log.Printf("Modem ready: %s %s (firmware: %s)",
		initResult.Info.Manufacturer, initResult.Info.Model, initResult.Info.Firmware)
	if initResult.Info.UnsupportedWarning != "" {
		log.Printf("WARNING: %s", initResult.Info.UnsupportedWarning)
	}

	voiceEnabled := ml.cfg.IsVoiceEnabled()

	// Audio pipeline.
	var audioPipeline *audio.Pipeline
	if voiceEnabled {
		sampleRate, err := audio.NegotiateSampleRate(m)
		if err != nil {
			log.Printf("Audio sample rate negotiation failed (voice disabled): %v", err)
			voiceEnabled = false
		} else {
			log.Printf("Audio sample rate: %d Hz", sampleRate)
			pcmPortPath := ml.cfg.Modem.PcmAudioPort
			if pcmPortPath == "" {
				log.Println("WARNING: voiceEnabled but no pcmAudioPort configured, voice calls will fail")
			} else {
				// Verify the PCM port can be opened up front, then use a
				// reopenable pipeline. The pipeline closes the port on Stop()
				// (to unblock its blocking Read()) and reopens it on the next
				// Start(), which is required to support multiple sequential calls.
				probePort, err := modem.OpenSerialPort(pcmPortPath, 0)
				if err != nil {
					log.Printf("WARNING: failed to open PCM audio port %s: %v (voice disabled)", pcmPortPath, err)
					voiceEnabled = false
				} else {
					_ = probePort.Close()
					// Open the PCM port with a short read timeout so the
					// capture goroutine's Read() returns periodically and can
					// observe the stop signal. Without a timeout, a blocking
					// Read() may not unblock when the port is closed, hanging
					// pipeline teardown between calls.
					opener := func() (modem.SerialPort, error) {
						return modem.OpenSerialPortWithTimeout(pcmPortPath, 0, pcmReadTimeout)
					}
					audioPipeline = audio.NewReopenable(opener, m, sampleRate)
					log.Printf("Audio pipeline initialized on %s", pcmPortPath)
				}
			}
		}
	}

	// SMS manager.
	smsMgr := sms.New(m, initResult.TextMode)
	smsMgr.RegisterURCHandlers()
	if err := smsMgr.ConfigureDeliveryReports(); err != nil {
		log.Printf("WARNING: delivery report configuration failed: %v", err)
	}

	// Delivery report polling.
	var deliveryPollCancel context.CancelFunc
	if initResult.CNMIDeliveryStatus <= 0 {
		var deliveryPollCtx context.Context
		deliveryPollCtx, deliveryPollCancel = context.WithCancel(ml.ctx)
		go pollDeliveryReports(deliveryPollCtx, smsMgr)
		log.Printf("Delivery report polling enabled (CNMI ds=%d)", initResult.CNMIDeliveryStatus)
	}

	// Wire SMS forwarding.
	wireSMSForwarding(smsMgr, ml.sigClient, ml.smsBuffer)

	// Drain any messages stored on the SIM/modem from previous sessions.
	// This must be called after wireSMSForwarding so handlers are registered.
	go smsMgr.DrainStoredMessages()

	// Call manager.
	var callManager *signaling.CallManager
	if voiceEnabled && audioPipeline != nil {
		callManager = signaling.NewCallManager(signaling.CallManagerConfig{
			Modem:         m,
			StateMachine:  ml.rm.StateMachine(),
			SigClient:     ml.sigClient,
			BridgeFactory: ml.bridgeFactory,
			Audio:         audioPipeline,
		})
		_ = signaling.NewDTMFHandler(m, ml.sigClient, callManager)
		log.Println("Call manager initialized (voice enabled)")
	} else {
		log.Println("Voice calls disabled (no audio pipeline)")
	}

	// USSD manager.
	ussdMgr := ussd.New(m)

	// Number reporter.
	numberReporter := signaling.NewNumberReporter(m, ml.sigClient, ml.cfg)

	// Status reporter.
	statusReporter := signaling.NewStatusReporter(m, ml.sigClient, signaling.ModemInfo{
		Model:              initResult.Info.Model,
		Manufacturer:       initResult.Info.Manufacturer,
		Firmware:           initResult.Info.Firmware,
		UnsupportedWarning: initResult.Info.UnsupportedWarning,
	})
	statusReporter.Start(ml.ctx)

	// Store subsystem references.
	ml.mu.Lock()
	ml.smsMgr = smsMgr
	ml.ussdMgr = ussdMgr
	ml.callManager = callManager
	ml.numberReporter = numberReporter
	ml.statusReporter = statusReporter
	ml.deliveryPollCancel = deliveryPollCancel
	ml.mu.Unlock()

	// Report number on connect if signaling is already up.
	if ml.sigClient.IsConnected() {
		numberReporter.ReportOnConnect()
	}

	log.Println("Modem subsystems initialized")
}

// onModemDisconnected is called by ReconnectManager when the modem is lost.
func (ml *ModemLifecycle) onModemDisconnected() {
	log.Println("Modem disconnected — tearing down subsystems")
	ml.teardownSubsystems()
}

// onCallLost is called by ReconnectManager when the modem is lost during a call.
func (ml *ModemLifecycle) onCallLost() {
	ml.mu.RLock()
	cm := ml.callManager
	ml.mu.RUnlock()

	if cm != nil {
		cm.HandleModemLost()
	}
}

// teardownSubsystems stops and clears all modem-dependent subsystems.
func (ml *ModemLifecycle) teardownSubsystems() {
	ml.mu.Lock()
	deliveryPollCancel := ml.deliveryPollCancel
	statusReporter := ml.statusReporter

	ml.smsMgr = nil
	ml.ussdMgr = nil
	ml.callManager = nil
	ml.numberReporter = nil
	ml.statusReporter = nil
	ml.deliveryPollCancel = nil
	ml.mu.Unlock()

	if deliveryPollCancel != nil {
		deliveryPollCancel()
	}
	if statusReporter != nil {
		statusReporter.Stop()
	}
}

// pollDeliveryReports runs a periodic delivery report poll loop.
func pollDeliveryReports(ctx context.Context, smsMgr *sms.Manager) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	time.Sleep(5 * time.Second)
	smsMgr.PollDeliveryReports()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			smsMgr.PollDeliveryReports()
		}
	}
}

// wireSMSForwarding registers callbacks on the SMS manager to forward
// received messages and delivery reports to Svarla (or buffer when offline).
func wireSMSForwarding(
	smsMgr *sms.Manager,
	sigClient *signaling.ReconnectingClient,
	smsBuffer *buffer.PersistentBuffer[sms.IncomingSMS],
) {
	smsMgr.OnReceived(func(incoming sms.IncomingSMS) {
		log.Printf("OnReceived: incoming SMS from=%s bodyLen=%d connected=%t",
			incoming.From, len(incoming.Body), sigClient.IsConnected())
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
				Timestamp: incoming.Timestamp.UnixMilli(),
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
			} else {
				log.Printf("Sent incoming_sms to server: from=%s messageId=%s", incoming.From, incoming.MessageID)
			}
		} else if smsBuffer != nil {
			if err := smsBuffer.Push(incoming); err != nil {
				log.Printf("Failed to buffer SMS: %v", err)
			} else {
				log.Printf("Buffered incoming_sms (offline): from=%s", incoming.From)
			}
		}
	})

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
}
