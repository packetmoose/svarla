# Design Document: Telecom Integration

## Overview

This design integrates Android's TelecomManager (`ConnectionService` API) into the softphone app using self-managed mode (`PROPERTY_SELF_MANAGED`). The integration provides reliable incoming call display on Android 14+ by leveraging the Telecom framework's background activity start privileges, while retaining a full fallback to the existing `IncomingCallActivity`/`IncomingCallRinger` path for OEM ROMs that block PhoneAccount registration.

The app owns the call UI at all times (self-managed). Audio focus is delegated to the Telecom framework on the Telecom_Path, while `AudioRouter` retains speaker/mute control on both paths.

## Architecture

### Component Diagram

```
┌───────────────────────────────────────────────────────────────┐
│                        Softphone App                          │
│                                                               │
│  ┌──────────────────┐       ┌───────────────────────────┐    │
│  │ SoftphoneApp     │       │ PhoneAccountRegistrar      │    │
│  │ (Application)    │──────▶│ - register on startup      │    │
│  │                  │       │ - persist status            │    │
│  └──────────────────┘       │ - verify on re-launch      │    │
│                             └────────────┬──────────────-─┘    │
│                                          │                    │
│                                          ▼                    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              CallServiceController                    │    │
│  │  (routes calls to Telecom_Path or Legacy_Path)        │    │
│  │                                                       │    │
│  │  if registered → TelecomManager.addNewIncomingCall()   │    │
│  │  if failed     → CallForegroundService.startRinging()  │    │
│  └───────────┬─────────────────────────┬────────────────┘    │
│              │                         │                      │
│     Telecom_Path                Legacy_Path                   │
│              │                         │                      │
│              ▼                         ▼                      │
│  ┌────────────────────┐   ┌─────────────────────────┐       │
│  │ SoftphoneConnection│   │ CallForegroundService    │       │
│  │ Service            │   │ + IncomingCallActivity   │       │
│  │                    │   │ + IncomingCallRinger     │       │
│  └────────┬───────────┘   └─────────────────────────┘       │
│           │                                                   │
│           ▼                                                   │
│  ┌────────────────────┐                                      │
│  │ SoftphoneConnection│◀────────▶┌───────────────────┐      │
│  │ (per-call)         │          │ VoiceCallManager   │      │
│  │ STATE_RINGING      │  sync    │ (call state machine│      │
│  │ STATE_DIALING      │◀────────▶│  IDLE/RINGING/     │      │
│  │ STATE_ACTIVE       │          │  DIALING/CONNECTED/│      │
│  │ STATE_DISCONNECTED │          │  ENDED)            │      │
│  └────────────────────┘          └───────────────────┘      │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐     │
│  │                   AudioRouter                        │     │
│  │  Telecom_Path: speaker/mute only (no focus/mode)     │     │
│  │  Legacy_Path:  full audio routing (focus + mode)     │     │
│  └─────────────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Self-Managed Mode**: The app uses `CAPABILITY_SELF_MANAGED` / `PROPERTY_SELF_MANAGED` exclusively. It never integrates with the native dialer, never writes to the system call log, and always owns the call UI.

2. **Dual-Path Architecture**: `CallServiceController` acts as a router. It checks `PhoneAccountRegistrar.registrationStatus` and decides whether to use Telecom_Path (TelecomManager APIs) or Legacy_Path (existing foreground service + fullScreenIntent).

3. **Graceful Fallback**: If `addNewIncomingCall()` throws `SecurityException` (common on some OEM ROMs) or the PhoneAccount isn't registered, the controller immediately falls back to Legacy_Path. This ensures zero downtime for call handling.

4. **Audio Focus Delegation**: On Telecom_Path, the Telecom framework manages audio focus and `MODE_IN_COMMUNICATION`. `AudioRouter` skips its `requestAudioFocus()` and mode-setting logic. On Legacy_Path, `AudioRouter` continues its current behavior unchanged.

5. **Bidirectional State Sync**: `SoftphoneConnection` and `VoiceCallManager` are kept in sync. Framework-initiated events (onAnswer, onReject, onDisconnect) propagate to VoiceCallManager. VoiceCallManager state changes (CONNECTED, ENDED) propagate back to update the Connection state.

## Components and Interfaces

### PhoneAccountRegistrar

**Location:** `com.softphone.domain.call.PhoneAccountRegistrar`

Singleton injected via Hilt. Runs at app startup (called from `SoftphoneApplication.onCreate()`).

```kotlin
@Singleton
class PhoneAccountRegistrar @Inject constructor(
    @ApplicationContext private val context: Context,
    private val sharedPreferences: SharedPreferences
) {
    companion object {
        private const val PREF_KEY_REGISTRATION_STATUS = "phone_account_registered"
        private const val PHONE_ACCOUNT_ID = "softphone_self_managed"
    }

    private val telecomManager: TelecomManager =
        context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager

    private val _registrationStatus = MutableStateFlow(RegistrationStatus.UNKNOWN)
    val registrationStatus: StateFlow<RegistrationStatus> = _registrationStatus.asStateFlow()

    val phoneAccountHandle: PhoneAccountHandle by lazy {
        PhoneAccountHandle(
            ComponentName(context, SoftphoneConnectionService::class.java),
            PHONE_ACCOUNT_ID
        )
    }

    fun register() {
        try {
            val account = PhoneAccount.builder(phoneAccountHandle, context.getString(R.string.app_name))
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .setIcon(Icon.createWithResource(context, R.drawable.ic_notification))
                .build()

            telecomManager.registerPhoneAccount(account)

            // Verify registration
            val registered = telecomManager.getPhoneAccount(phoneAccountHandle) != null
            if (registered) {
                _registrationStatus.value = RegistrationStatus.REGISTERED
                sharedPreferences.edit().putBoolean(PREF_KEY_REGISTRATION_STATUS, true).apply()
            } else {
                _registrationStatus.value = RegistrationStatus.FAILED
                sharedPreferences.edit().putBoolean(PREF_KEY_REGISTRATION_STATUS, false).apply()
            }
        } catch (e: Exception) {
            Log.e("PhoneAccountRegistrar", "Registration failed", e)
            _registrationStatus.value = RegistrationStatus.FAILED
            sharedPreferences.edit().putBoolean(PREF_KEY_REGISTRATION_STATUS, false).apply()
        }
    }

    fun verifyRegistration() {
        val existing = telecomManager.getPhoneAccount(phoneAccountHandle)
        if (existing != null) {
            _registrationStatus.value = RegistrationStatus.REGISTERED
        } else {
            _registrationStatus.value = RegistrationStatus.FAILED
            register() // Re-attempt
        }
    }
}

enum class RegistrationStatus { UNKNOWN, REGISTERED, FAILED }
```

### SoftphoneConnectionService

**Location:** `com.softphone.domain.call.SoftphoneConnectionService`

Android `ConnectionService` subclass bound by TelecomManager.

```kotlin
@AndroidEntryPoint
class SoftphoneConnectionService : ConnectionService() {

    @Inject lateinit var voiceCallManager: VoiceCallManager
    @Inject lateinit var callServiceController: CallServiceController

    override fun onCreateIncomingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ): Connection {
        val extras = request?.extras ?: Bundle()
        val callId = extras.getString(EXTRA_CALL_ID) ?: ""
        val callerNumber = extras.getString(EXTRA_CALLER_NUMBER) ?: ""

        val connection = SoftphoneConnection(voiceCallManager, callId).apply {
            setInitializing()
            connectionProperties = Connection.PROPERTY_SELF_MANAGED
            setCallerDisplayName(callerNumber, TelecomManager.PRESENTATION_ALLOWED)
            setAddress(
                Uri.fromParts(PhoneAccount.SCHEME_TEL, callerNumber, null),
                TelecomManager.PRESENTATION_ALLOWED
            )
            setRinging()
        }

        // Launch IncomingCallActivity using background activity start privilege
        launchIncomingCallActivity(callId, callerNumber)

        return connection
    }

    override fun onCreateOutgoingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ): Connection {
        val extras = request?.extras ?: Bundle()
        val destinationNumber = request?.address?.schemeSpecificPart ?: ""
        val callId = extras.getString(EXTRA_CALL_ID) ?: ""

        val connection = SoftphoneConnection(voiceCallManager, callId).apply {
            connectionProperties = Connection.PROPERTY_SELF_MANAGED
            setAddress(request?.address, TelecomManager.PRESENTATION_ALLOWED)
            setDialing()
        }

        return connection
    }

    override fun onCreateIncomingConnectionFailed(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ) {
        val extras = request?.extras ?: Bundle()
        val callId = extras.getString(EXTRA_CALL_ID) ?: ""
        val callerNumber = extras.getString(EXTRA_CALLER_NUMBER) ?: ""
        // Fallback to legacy path
        callServiceController.startForIncomingCall(callId, callerNumber)
    }

    override fun onCreateOutgoingConnectionFailed(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ) {
        // Outgoing call already initiated via VonageClientManager;
        // just let the existing foreground service handle it
        val remoteNumber = request?.address?.schemeSpecificPart ?: ""
        callServiceController.startForOutboundCall(remoteNumber)
    }

    private fun launchIncomingCallActivity(callId: String, callerNumber: String) {
        val intent = IncomingCallActivity.createIntent(this, callId, callerNumber)
        startActivity(intent)
    }

    companion object {
        const val EXTRA_CALL_ID = "telecom_call_id"
        const val EXTRA_CALLER_NUMBER = "telecom_caller_number"
    }
}
```

### SoftphoneConnection

**Location:** `com.softphone.domain.call.SoftphoneConnection`

Per-call `Connection` subclass with bidirectional state sync.

```kotlin
class SoftphoneConnection(
    private val voiceCallManager: VoiceCallManager,
    private val callId: String
) : Connection() {

    init {
        connectionProperties = PROPERTY_SELF_MANAGED
        // Do NOT add CAPABILITY_HOLD, CAPABILITY_SUPPORT_HOLD, etc.
        // Self-managed connections own all UI.
    }

    // ====== Framework → App (user actions via system UI, if any) ======

    override fun onAnswer() {
        setActive()
        voiceCallManager.answerCall(callId)
    }

    override fun onReject() {
        setDisconnected(DisconnectCause(DisconnectCause.REJECTED))
        voiceCallManager.declineCall(callId)
        destroy()
    }

    override fun onDisconnect() {
        setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
        voiceCallManager.endCall()
        destroy()
    }

    override fun onCallAudioStateChanged(state: CallAudioState?) {
        // Audio focus managed by Telecom framework.
        // Speaker/mute handled by AudioRouter directly.
    }

    // ====== App → Framework (VoiceCallManager state changes) ======

    fun onCallConnected() {
        setActive()
    }

    fun onCallEnded(cause: DisconnectCause) {
        setDisconnected(cause)
        destroy()
    }
}
```

### CallServiceController (Updated)

**Location:** `com.softphone.domain.call.CallServiceController`

Extended interface with Telecom_Path routing logic.

```kotlin
interface CallServiceController {
    fun startForIncomingCall(callId: String, remoteNumber: String)
    fun startForOutboundCall(remoteNumber: String)
    fun updateConnected(remoteNumber: String)
    fun stop()
    // New: Telecom path
    fun handleIncomingCallViaTelecom(callId: String, remoteNumber: String)
    fun handleOutgoingCallViaTelecom(destinationNumber: String)
}
```


```kotlin
@Singleton
class CallServiceControllerImpl @Inject constructor(
    @ApplicationContext private val context: Context,
    private val phoneAccountRegistrar: PhoneAccountRegistrar
) : CallServiceController {

    private val telecomManager: TelecomManager =
        context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager

    override fun handleIncomingCallViaTelecom(callId: String, remoteNumber: String) {
        if (phoneAccountRegistrar.registrationStatus.value != RegistrationStatus.REGISTERED) {
            // Fallback to legacy
            startForIncomingCall(callId, remoteNumber)
            return
        }

        try {
            val extras = Bundle().apply {
                putString(SoftphoneConnectionService.EXTRA_CALL_ID, callId)
                putString(SoftphoneConnectionService.EXTRA_CALLER_NUMBER, remoteNumber)
                putParcelable(
                    TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE,
                    phoneAccountRegistrar.phoneAccountHandle
                )
            }
            telecomManager.addNewIncomingCall(
                phoneAccountRegistrar.phoneAccountHandle,
                extras
            )
        } catch (e: SecurityException) {
            Log.w("CallServiceController", "addNewIncomingCall failed, falling back", e)
            startForIncomingCall(callId, remoteNumber)
        }
    }

    override fun handleOutgoingCallViaTelecom(destinationNumber: String) {
        if (phoneAccountRegistrar.registrationStatus.value != RegistrationStatus.REGISTERED) {
            startForOutboundCall(destinationNumber)
            return
        }

        try {
            val uri = Uri.fromParts(PhoneAccount.SCHEME_TEL, destinationNumber, null)
            val extras = Bundle().apply {
                putParcelable(
                    TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE,
                    phoneAccountRegistrar.phoneAccountHandle
                )
            }
            telecomManager.placeCall(uri, extras)
        } catch (e: SecurityException) {
            Log.w("CallServiceController", "placeCall failed, falling back", e)
            startForOutboundCall(destinationNumber)
        }
    }

    // Legacy path methods (unchanged)
    override fun startForIncomingCall(callId: String, remoteNumber: String) {
        CallForegroundService.startRinging(context, callId, remoteNumber)
    }

    override fun startForOutboundCall(remoteNumber: String) {
        CallForegroundService.startDialing(context, remoteNumber)
    }

    override fun updateConnected(remoteNumber: String) {
        CallForegroundService.updateConnected(context, remoteNumber)
    }

    override fun stop() {
        CallForegroundService.stop(context)
    }
}
```

### AudioRouter (Modified)

The existing `AudioRouter` is extended with an `activePath` awareness flag.

```kotlin
@Singleton
class AudioRouter @Inject constructor(
    @ApplicationContext private val context: Context,
    private val audioManager: AudioManager
) {
    // ... existing fields ...

    /** Indicates whether the current call is using the Telecom path (audio focus delegated). */
    private var isTelecomPathActive = false

    fun startCallAudioRouting(telecomManaged: Boolean = false) {
        if (isCallActive) {
            if (!telecomManaged) {
                audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
                requestAudioFocus()
            }
            return
        }

        isCallActive = true
        isTelecomPathActive = telecomManaged
        _isSpeakerOn.value = false
        _isMuted.value = false

        if (!telecomManaged) {
            // Legacy path: app manages audio focus and mode
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            requestAudioFocus()
        }
        // Both paths: register device receivers, detect devices, route to highest priority
        registerAudioDeviceReceivers()
        detectAvailableDevices()
        routeToHighestPriority()
    }

    fun stopCallAudioRouting() {
        isCallActive = false
        unregisterAudioDeviceReceivers()

        if (!isTelecomPathActive) {
            abandonAudioFocus()
            audioManager.mode = AudioManager.MODE_NORMAL
        }

        isTelecomPathActive = false
        audioManager.isSpeakerphoneOn = false
        audioManager.isMicrophoneMute = false
        _isSpeakerOn.value = false
        _isMuted.value = false
        _currentAudioDevice.value = AudioDevice.EARPIECE
        _availableDevices.value = setOf(AudioDevice.EARPIECE)
    }

    // toggleSpeaker() and toggleMute() remain unchanged — work on both paths
}
```

## Data Models

### RegistrationStatus

```kotlin
enum class RegistrationStatus {
    /** Initial state before registration attempt */
    UNKNOWN,
    /** PhoneAccount successfully registered and verified */
    REGISTERED,
    /** Registration failed (OEM block, missing permission, etc.) */
    FAILED
}
```

### SoftphoneConnectionService Extras

| Key | Type | Description |
|-----|------|-------------|
| `EXTRA_CALL_ID` | String | Backend call identifier |
| `EXTRA_CALLER_NUMBER` | String | Remote party number (E.164) |

### Connection State Mapping

| VoiceCallManager State | SoftphoneConnection State | Direction |
|------------------------|---------------------------|-----------|
| `RINGING` | `STATE_RINGING` | Service → Connection |
| `DIALING` | `STATE_DIALING` | Service → Connection |
| `CONNECTED` | `STATE_ACTIVE` | VoiceCallManager → Connection |
| `ENDED` | `STATE_DISCONNECTED` | VoiceCallManager → Connection |
| — | `onAnswer()` callback | Connection → VoiceCallManager |
| — | `onReject()` callback | Connection → VoiceCallManager |
| — | `onDisconnect()` callback | Connection → VoiceCallManager |

### Interfaces

#### PhoneAccountRegistrar

```kotlin
interface PhoneAccountRegistrar {
    val registrationStatus: StateFlow<RegistrationStatus>
    val phoneAccountHandle: PhoneAccountHandle
    fun register()
    fun verifyRegistration()
}
```

#### CallServiceController (Extended)

```kotlin
interface CallServiceController {
    // Existing legacy methods
    fun startForIncomingCall(callId: String, remoteNumber: String)
    fun startForOutboundCall(remoteNumber: String)
    fun updateConnected(remoteNumber: String)
    fun stop()
    // New telecom-path methods
    fun handleIncomingCallViaTelecom(callId: String, remoteNumber: String)
    fun handleOutgoingCallViaTelecom(destinationNumber: String)
}
```

## Error Handling

### Registration Failures

| Scenario | Handling |
|----------|----------|
| `SecurityException` from `registerPhoneAccount()` | Set status FAILED, persist, log reason |
| `getPhoneAccount()` returns null after register | Set status FAILED, persist, re-attempt on next launch |
| OEM blocks `CAPABILITY_SELF_MANAGED` | Status stays FAILED; all calls use Legacy_Path |

### Telecom Path Failures

| Scenario | Handling |
|----------|----------|
| `addNewIncomingCall()` throws `SecurityException` | Immediately fall back to `CallForegroundService.startRinging()` |
| `onCreateIncomingConnectionFailed()` called by system | Invoke legacy `startForIncomingCall()` |
| `placeCall()` throws `SecurityException` | Fall back to `CallForegroundService.startDialing()` |
| `onCreateOutgoingConnectionFailed()` called by system | Invoke legacy `startForOutboundCall()` |

### State Sync Failures

| Scenario | Handling |
|----------|----------|
| Connection destroyed but VoiceCallManager not ENDED | VoiceCallManager detects orphan and transitions to ENDED |
| VoiceCallManager ENDED but Connection not destroyed | Connection observer triggers `setDisconnected()` + `destroy()` |
| Framework calls `onDisconnect()` during RINGING | Treat as decline; VoiceCallManager transitions to ENDED |

## Manifest Changes

```xml
<!-- Add to AndroidManifest.xml -->
<service
    android:name=".domain.call.SoftphoneConnectionService"
    android:exported="true"
    android:permission="android.permission.BIND_TELECOM_CONNECTION_SERVICE"
    android:foregroundServiceType="phoneCall|microphone">
    <intent-filter>
        <action android:name="android.telecom.ConnectionService" />
    </intent-filter>
</service>
```

The `MANAGE_OWN_CALLS` permission is already declared in the current manifest.

## Sequence Diagrams

### Incoming Call (Telecom Path)

```
UnifiedPushReceiver                CallServiceController       TelecomManager       SoftphoneConnectionService    SoftphoneConnection    VoiceCallManager
       │                                   │                        │                         │                         │                      │
       │──onMessage(incoming_call)─────────▶│                        │                         │                         │                      │
       │                                   │──addNewIncomingCall()──▶│                         │                         │                      │
       │                                   │                        │──bind + onCreateIncoming─▶│                         │                      │
       │                                   │                        │                         │──create(RINGING)────────▶│                      │
       │                                   │                        │                         │──launch IncomingCallActivity                     │
       │                                   │                        │                         │                         │                      │
       │                                   │                        │                         │    [User taps Answer]    │                      │
       │                                   │                        │                         │◀──onAnswer()─────────────│                      │
       │                                   │                        │                         │                         │──answerCall()────────▶│
       │                                   │                        │                         │──setActive()────────────▶│                      │
```

### Incoming Call (Legacy Fallback)

```
UnifiedPushReceiver        CallServiceController       CallForegroundService     IncomingCallRinger
       │                          │                           │                        │
       │──onMessage()────────────▶│                           │                        │
       │                          │  (PhoneAccount FAILED     │                        │
       │                          │   or SecurityException)   │                        │
       │                          │──startRinging()──────────▶│                        │
       │                          │                           │──start()──────────────▶│
       │                          │                           │──postIncomingCallNotification()
       │                          │                           │  (fullScreenIntent → IncomingCallActivity)
```

### Outgoing Call (Telecom Path)

```
VoiceCallManager         CallServiceController       TelecomManager       SoftphoneConnectionService    SoftphoneConnection
       │                          │                        │                         │                         │
       │──makeCall(from, to)─────▶│                        │                         │                         │
       │                          │──placeCall(uri)────────▶│                         │                         │
       │                          │                        │──onCreateOutgoing───────▶│                         │
       │                          │                        │                         │──create(DIALING)────────▶│
       │                          │                        │                         │                         │
       │  [call connected event]  │                        │                         │                         │
       │──CONNECTED──────────────▶│                        │                         │                         │
       │                          │                        │                         │──onCallConnected()──────▶│
       │                          │                        │                         │  (setActive)             │
```


## Testing Strategy

### Property-Based Tests (Kotest)

Property-based tests validate universal invariants using Kotest's property testing module (already in `build.gradle.kts`). Each property test runs 100+ iterations with generated inputs.

**What to generate:**
- Phone numbers (E.164 format strings)
- Call IDs (UUID-like strings)
- `RegistrationStatus` values
- `DisconnectCause` codes
- `CallStatus` enum values
- `ConnectionRequest` extras bundles

**Mocking strategy:** Use mock implementations of `TelecomManager`, `VoiceCallManager`, and `AudioManager` to isolate the pure routing and state-sync logic from Android framework dependencies.

### Unit Tests (Example-Based)

Unit tests cover specific scenarios not suited to property-based testing:
- PhoneAccount metadata (label, icon, capabilities)
- Registration persistence behavior
- Manifest declaration correctness (smoke)
- Speaker/mute toggle behavior unchanged on both paths

### Integration Tests

Integration tests verify end-to-end flows on real devices:
- Background activity start privilege granted during `STATE_RINGING`
- `IncomingCallActivity` launches from `SoftphoneConnectionService`
- Audio focus properly delegated to Telecom framework
- Legacy path non-regression on OEM-blocked devices

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Incoming connection creation invariant

*For any* valid incoming call request with a caller phone number, `onCreateIncomingConnection()` SHALL return a `SoftphoneConnection` that has `PROPERTY_SELF_MANAGED` set, is in `STATE_RINGING`, and has its address set to the caller's phone number.

**Validates: Requirements 2.2, 3.1, 3.2, 10.4**

### Property 2: Outgoing connection creation invariant

*For any* valid outgoing call request with a destination phone number, `onCreateOutgoingConnection()` SHALL return a `SoftphoneConnection` that has `PROPERTY_SELF_MANAGED` set, is in `STATE_DIALING`, and has its address set to the destination phone number.

**Validates: Requirements 2.3, 3.1, 3.6, 10.4**

### Property 3: Connection failure triggers legacy fallback

*For any* connection creation failure (missing extras, invalid state, system rejection), the `ConnectionService` SHALL invoke the Legacy_Path via `CallServiceController.startForIncomingCall()` or `startForOutboundCall()` so that call handling is never dropped.

**Validates: Requirements 2.4, 4.5**

### Property 4: Path routing is determined by registration status

*For any* incoming or outgoing call, `CallServiceController` SHALL route through Telecom_Path if and only if `PhoneAccountRegistrar.registrationStatus` is `REGISTERED`. When status is `FAILED` or a `SecurityException` occurs during the Telecom_Path attempt, the controller SHALL fall back to Legacy_Path.

**Validates: Requirements 4.5, 5.1, 5.3, 7.4**

### Property 5: Answer propagation from Connection to VoiceCallManager

*For any* `SoftphoneConnection` in `STATE_RINGING`, when `onAnswer()` is invoked by the Telecom framework, the connection SHALL transition to `STATE_ACTIVE` AND `VoiceCallManager.answerCall(callId)` SHALL be invoked with the correct call identifier.

**Validates: Requirements 3.3, 9.4**

### Property 6: Reject propagation from Connection to VoiceCallManager

*For any* `SoftphoneConnection` in `STATE_RINGING`, when `onReject()` is invoked by the Telecom framework, the connection SHALL transition to `STATE_DISCONNECTED` with `DisconnectCause.REJECTED` AND `VoiceCallManager.declineCall(callId)` SHALL be invoked with the correct call identifier.

**Validates: Requirements 3.4, 9.5**

### Property 7: Disconnect propagation from Connection to VoiceCallManager

*For any* `SoftphoneConnection` in `STATE_ACTIVE`, when `onDisconnect()` is invoked by the Telecom framework, the connection SHALL transition to `STATE_DISCONNECTED` with `DisconnectCause.LOCAL` AND `VoiceCallManager.endCall()` SHALL be invoked.

**Validates: Requirements 3.5, 9.3**

### Property 8: State sync — VoiceCallManager CONNECTED propagates to Connection

*For any* active `SoftphoneConnection` associated with a call, when `VoiceCallManager` transitions to `CallStatus.CONNECTED`, the connection's `onCallConnected()` SHALL be invoked, transitioning it to `STATE_ACTIVE`.

**Validates: Requirements 9.1, 3.7**

### Property 9: State sync — VoiceCallManager ENDED propagates to Connection

*For any* active `SoftphoneConnection` associated with a call, when `VoiceCallManager` transitions to `CallStatus.ENDED`, the connection's `onCallEnded()` SHALL be invoked with the appropriate `DisconnectCause`, transitioning it to `STATE_DISCONNECTED`, and `destroy()` SHALL be called.

**Validates: Requirements 9.2, 3.5**

### Property 10: Audio focus delegation depends on active path

*For any* call routed via Telecom_Path, `AudioRouter.startCallAudioRouting(telecomManaged=true)` SHALL NOT call `requestAudioFocus()` or set `AudioManager.MODE_IN_COMMUNICATION`. Conversely, *for any* call routed via Legacy_Path, `AudioRouter.startCallAudioRouting(telecomManaged=false)` SHALL call `requestAudioFocus()` and set `MODE_IN_COMMUNICATION`.

**Validates: Requirements 6.1, 6.3**

### Property 11: Outgoing call placed via TelecomManager when registered

*For any* outgoing call destination number, when `PhoneAccountRegistrar.registrationStatus` is `REGISTERED`, `CallServiceController.handleOutgoingCallViaTelecom()` SHALL invoke `TelecomManager.placeCall()` with a `tel:` URI containing the destination number and extras containing the `PhoneAccountHandle`.

**Validates: Requirements 7.1**
