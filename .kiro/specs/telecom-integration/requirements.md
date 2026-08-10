# Requirements Document

## Introduction

This feature integrates Android's TelecomManager framework (ConnectionService API) into the softphone app to improve incoming call reliability on Android 14+. The app will use a self-managed ConnectionService (`PROPERTY_SELF_MANAGED`) as the primary call path, with the existing `IncomingCallActivity` and `IncomingCallRinger` retained as a fallback for OEM ROMs that block PhoneAccount registration. Audio focus management is delegated to the Telecom framework, while the app retains control of speaker/mute toggling via `AudioRouter`.

## Glossary

- **Softphone_App**: The com.softphone Android application
- **TelecomManager**: Android's `android.telecom.TelecomManager` system service that manages call routing and PhoneAccount registration
- **ConnectionService**: The `SoftphoneConnectionService` subclass of `android.telecom.ConnectionService` that creates Connection instances for the Softphone_App
- **SoftphoneConnection**: The `android.telecom.Connection` subclass with `PROPERTY_SELF_MANAGED` that represents a single call within the Telecom framework
- **PhoneAccountRegistrar**: A component that registers and verifies the app's PhoneAccount with TelecomManager on startup
- **PhoneAccount**: The `android.telecom.PhoneAccount` registered with TelecomManager that identifies the Softphone_App as a self-managed calling app
- **AudioRouter**: The existing `AudioRouter` component responsible for speaker/mute toggling during active calls
- **VoiceCallManager**: The existing call state machine that orchestrates call lifecycle
- **CallServiceController**: The abstraction layer that bridges VoiceCallManager to the foreground service and now also to the ConnectionService path
- **Legacy_Path**: The fallback call handling path using `IncomingCallActivity`, `IncomingCallRinger`, and custom foreground service notification with `fullScreenIntent`
- **Telecom_Path**: The primary call handling path using TelecomManager, ConnectionService, and SoftphoneConnection

## Requirements

### Requirement 1: PhoneAccount Registration

**User Story:** As a softphone user, I want the app to register with Android's Telecom framework on startup, so that incoming calls are reliably displayed by the system even when the app is in the background.

#### Acceptance Criteria

1. WHEN the Softphone_App starts, THE PhoneAccountRegistrar SHALL register a PhoneAccount with TelecomManager using `CAPABILITY_SELF_MANAGED` and a unique component name for the ConnectionService.
2. WHEN the PhoneAccount registration succeeds, THE PhoneAccountRegistrar SHALL persist the registration status as successful.
3. IF the PhoneAccount registration fails, THEN THE PhoneAccountRegistrar SHALL log the failure reason and set the registration status to failed.
4. WHEN the Softphone_App starts and the PhoneAccount is already registered, THE PhoneAccountRegistrar SHALL verify the existing registration is still valid with TelecomManager.
5. THE PhoneAccountRegistrar SHALL use the app label and icon as the PhoneAccount display metadata.

### Requirement 2: ConnectionService Binding

**User Story:** As a softphone user, I want the system to bind to my app's ConnectionService when a call arrives, so that the Telecom framework can manage call display and lifecycle.

#### Acceptance Criteria

1. THE ConnectionService SHALL be declared in the AndroidManifest with the `android.telecom.ConnectionService` intent filter and `BIND_TELECOM_CONNECTION_SERVICE` permission.
2. WHEN TelecomManager binds to the ConnectionService for an incoming call, THE ConnectionService SHALL create a SoftphoneConnection instance and return it via `onCreateIncomingConnection()`.
3. WHEN TelecomManager binds to the ConnectionService for an outgoing call, THE ConnectionService SHALL create a SoftphoneConnection instance and return it via `onCreateOutgoingConnection()`.
4. IF the ConnectionService cannot create a valid connection, THEN THE ConnectionService SHALL return a failed connection via `onCreateIncomingConnectionFailed()` or `onCreateOutgoingConnectionFailed()` and trigger the Legacy_Path.

### Requirement 3: SoftphoneConnection Lifecycle

**User Story:** As a softphone user, I want each call to be represented as a self-managed Connection, so that the system grants background activity start privileges and displays the incoming call notification.

#### Acceptance Criteria

1. THE SoftphoneConnection SHALL set `PROPERTY_SELF_MANAGED` on creation.
2. WHEN a SoftphoneConnection is created for an incoming call, THE SoftphoneConnection SHALL set the connection state to `STATE_RINGING` and call `setAddress()` with the caller's phone number.
3. WHEN the user answers a ringing SoftphoneConnection, THE SoftphoneConnection SHALL transition the connection state to `STATE_ACTIVE` and notify VoiceCallManager to answer the call.
4. WHEN the user rejects a ringing SoftphoneConnection, THE SoftphoneConnection SHALL transition the connection state to `STATE_DISCONNECTED` with `DisconnectCause.REJECTED` and notify VoiceCallManager to decline the call.
5. WHEN the remote party or VoiceCallManager ends an active SoftphoneConnection, THE SoftphoneConnection SHALL transition the connection state to `STATE_DISCONNECTED` with the appropriate `DisconnectCause` and call `destroy()`.
6. WHEN a SoftphoneConnection is created for an outgoing call, THE SoftphoneConnection SHALL set the connection state to `STATE_DIALING` and call `setAddress()` with the destination phone number.
7. WHEN an outgoing call connects, THE SoftphoneConnection SHALL transition the connection state to `STATE_ACTIVE`.

### Requirement 4: Incoming Call via Telecom Path

**User Story:** As a softphone user, I want incoming calls to go through TelecomManager so that the system reliably wakes the screen, displays the notification, and grants background activity start privileges on Android 14+.

#### Acceptance Criteria

1. WHEN UnifiedPushReceiver receives an incoming call push signal and the PhoneAccount is registered, THE CallServiceController SHALL call `TelecomManager.addNewIncomingCallExtras()` with the call metadata and invoke `addNewIncomingCall()`.
2. WHEN `addNewIncomingCall()` succeeds, THE ConnectionService SHALL receive `onCreateIncomingConnection()` and create a SoftphoneConnection in `STATE_RINGING`.
3. WHILE the SoftphoneConnection is in `STATE_RINGING`, THE Softphone_App SHALL have background activity start privileges granted by the Telecom framework.
4. WHEN the SoftphoneConnection is in `STATE_RINGING`, THE Softphone_App SHALL launch `IncomingCallActivity` using the background activity start privilege.
5. IF `addNewIncomingCall()` throws a SecurityException or the PhoneAccount is not registered, THEN THE CallServiceController SHALL fall back to the Legacy_Path by starting CallForegroundService directly.

### Requirement 5: Fallback to Legacy Path

**User Story:** As a softphone user on a device where TelecomManager registration is blocked by the OEM, I want calls to still work using the existing notification and activity approach.

#### Acceptance Criteria

1. WHEN the PhoneAccountRegistrar reports registration status as failed, THE CallServiceController SHALL route all incoming calls through the Legacy_Path.
2. WHILE the Legacy_Path is active, THE Softphone_App SHALL use `IncomingCallActivity`, `IncomingCallRinger`, and `CallForegroundService` with `fullScreenIntent` for incoming call display.
3. WHEN the PhoneAccount registration status changes from failed to successful, THE CallServiceController SHALL switch to the Telecom_Path for subsequent calls.
4. THE Legacy_Path SHALL remain functionally identical to the current implementation with no behavioral regressions.

### Requirement 6: Audio Focus Delegation to Telecom Framework

**User Story:** As a softphone user, I want audio focus to be managed by the system Telecom framework during calls, so that audio conflicts with other apps are resolved consistently.

#### Acceptance Criteria

1. WHILE the Telecom_Path is active, THE AudioRouter SHALL NOT request `AUDIOFOCUS_GAIN_TRANSIENT` or set `AudioManager.MODE_IN_COMMUNICATION` manually.
2. WHILE the Telecom_Path is active, THE SoftphoneConnection SHALL rely on `Connection.onCallAudioStateChanged()` for audio focus state changes managed by the Telecom framework.
3. WHILE the Legacy_Path is active, THE AudioRouter SHALL continue to request audio focus and set `MODE_IN_COMMUNICATION` as it does currently.
4. THE AudioRouter SHALL retain responsibility for speaker toggling via `AudioManager.setSpeakerphoneOn()` during active calls on both paths.
5. THE AudioRouter SHALL retain responsibility for microphone mute toggling via `AudioManager.setMicrophoneMute()` during active calls on both paths.

### Requirement 7: Outgoing Call via Telecom Path

**User Story:** As a softphone user, I want outgoing calls to be registered with TelecomManager, so that the system knows a call is active and manages audio focus accordingly.

#### Acceptance Criteria

1. WHEN VoiceCallManager initiates an outgoing call and the PhoneAccount is registered, THE CallServiceController SHALL call `TelecomManager.placeCall()` with the destination URI and call extras.
2. WHEN `placeCall()` succeeds, THE ConnectionService SHALL receive `onCreateOutgoingConnection()` and create a SoftphoneConnection in `STATE_DIALING`.
3. WHEN the outgoing call connects via VonageClientManager, THE SoftphoneConnection SHALL transition to `STATE_ACTIVE`.
4. IF `placeCall()` fails or the PhoneAccount is not registered, THEN THE CallServiceController SHALL proceed with the existing foreground service approach for the outgoing call.

### Requirement 8: Manifest and Permission Configuration

**User Story:** As a developer, I want the correct permissions and service declarations in the manifest, so that the Telecom integration functions correctly on Android 14+ (API 34).

#### Acceptance Criteria

1. THE AndroidManifest SHALL declare the `MANAGE_OWN_CALLS` permission.
2. THE AndroidManifest SHALL declare the ConnectionService with intent filter action `android.telecom.ConnectionService` and permission `android.permission.BIND_TELECOM_CONNECTION_SERVICE`.
3. THE ConnectionService manifest entry SHALL declare `foregroundServiceType` of `phoneCall|microphone`.
4. THE Softphone_App SHALL target API 34 with minSdk 26.

### Requirement 9: Call State Synchronization

**User Story:** As a softphone user, I want the TelecomManager Connection state and VoiceCallManager state to stay synchronized, so that call controls and UI reflect the actual call status.

#### Acceptance Criteria

1. WHEN VoiceCallManager transitions to `CallStatus.CONNECTED`, THE SoftphoneConnection SHALL transition to `STATE_ACTIVE`.
2. WHEN VoiceCallManager transitions to `CallStatus.ENDED`, THE SoftphoneConnection SHALL transition to `STATE_DISCONNECTED` and call `destroy()`.
3. WHEN SoftphoneConnection receives `onDisconnect()` from the Telecom framework, THE VoiceCallManager SHALL end the active call.
4. WHEN SoftphoneConnection receives `onAnswer()` from the Telecom framework, THE VoiceCallManager SHALL answer the ringing call.
5. WHEN SoftphoneConnection receives `onReject()` from the Telecom framework, THE VoiceCallManager SHALL decline the ringing call.

### Requirement 10: Self-Managed Mode Constraints

**User Story:** As a softphone user, I want the app to operate in self-managed mode without integrating into the native dialer, so that the app fully owns the call UI and user experience.

#### Acceptance Criteria

1. THE PhoneAccount SHALL be registered with `CAPABILITY_SELF_MANAGED` and no other call-related capabilities.
2. THE SoftphoneConnection SHALL NOT write entries to the system call log.
3. THE Softphone_App SHALL own and display the call UI for all call states (ringing, active, ended) without delegating to the native dialer.
4. THE SoftphoneConnection SHALL set `PROPERTY_SELF_MANAGED` to prevent the system from displaying its own call UI.
