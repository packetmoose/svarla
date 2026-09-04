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
	smsDelivery   *SMSDelivery
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
}

// ModemLifecycleConfig holds dependencies for ModemLifecycle.
type ModemLifecycleConfig struct {
	Cfg           *config.Config
	SigClient     *signaling.ReconnectingClient
	SmsBuffer     *buffer.PersistentBuffer[sms.IncomingSMS]
	SmsDelivery   *SMSDelivery
	BridgeFactory func() *bridge.AudioBridge
}

// NewModemLifecycle creates a new ModemLifecycle. Call Start to begin.
func NewModemLifecycle(cfg ModemLifecycleConfig) *ModemLifecycle {
	return &ModemLifecycle{
		cfg:           cfg.Cfg,
		sigClient:     cfg.SigClient,
		smsBuffer:     cfg.SmsBuffer,
		smsDelivery:   cfg.SmsDelivery,
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

	// Number reporter — created early so its Number() getter is available to
	// the SMS manager for populating the "to" field on received messages. An
	// initial Discover() caches the number before any SMS processing begins.
	numberReporter := signaling.NewNumberReporter(m, ml.sigClient, ml.cfg)
	if _, err := numberReporter.Discover(); err != nil {
		log.Printf("Initial number discovery failed: %v", err)
	}

	// SMS manager.
	smsMgr := sms.New(m, numberReporter.Number)
	smsMgr.RegisterURCHandlers()

	// Delivery/status reports are not used on this hardware (see internal/sms),
	// so there is nothing to configure or poll for them here.

	// Wire SMS forwarding.
	wireSMSForwarding(smsMgr, ml.smsDelivery)

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
	statusReporter := ml.statusReporter

	ml.smsMgr = nil
	ml.ussdMgr = nil
	ml.callManager = nil
	ml.numberReporter = nil
	ml.statusReporter = nil
	ml.mu.Unlock()

	if statusReporter != nil {
		statusReporter.Stop()
	}
}

// wireSMSForwarding registers the received-SMS handler. The handler durably
// persists every incoming message to the buffer (buffer-first). Returning an
// error signals the SMS manager to keep the message in modem storage for a
// later retry rather than deleting it. Actual delivery to the server and
// removal-on-ack are handled by the SMSDelivery pump.
func wireSMSForwarding(smsMgr *sms.Manager, delivery *SMSDelivery) {
	smsMgr.OnReceived(func(incoming sms.IncomingSMS) error {
		log.Printf("OnReceived: incoming SMS from=%s bodyLen=%d messageId=%s",
			incoming.From, len(incoming.Body), incoming.MessageID)
		if delivery == nil {
			// Without a delivery pump we cannot guarantee durability; signal
			// failure so the message stays in modem storage.
			return errNoDelivery
		}
		if err := delivery.Persist(incoming); err != nil {
			log.Printf("Failed to persist incoming SMS %s: %v", incoming.MessageID, err)
			return err
		}
		return nil
	})
}

// errNoDelivery is returned when no delivery pump is configured, so the SMS
// manager keeps the message in modem storage instead of deleting it.
var errNoDelivery = errDelivery("sms delivery not configured")

type errDelivery string

func (e errDelivery) Error() string { return string(e) }
