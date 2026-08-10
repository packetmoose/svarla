# Implementation Plan: Telecom Integration

## Overview

Integrate Android's TelecomManager (ConnectionService API) into the softphone app using self-managed mode. The implementation follows a dual-path architecture: Telecom_Path as the primary path (for Android 14+ reliable incoming call display) with automatic fallback to the existing Legacy_Path when PhoneAccount registration fails. Components are built incrementally: registration → connection service → routing logic → audio delegation → state sync → wiring.

## Tasks

- [x] 1. PhoneAccount Registration
  - [x] 1.1 Create `PhoneAccountRegistrar` class
    - Create `com/softphone/domain/call/PhoneAccountRegistrar.kt`
    - Implement `RegistrationStatus` enum (`UNKNOWN`, `REGISTERED`, `FAILED`)
    - Implement singleton with `@Inject constructor` taking `Context` and `SharedPreferences`
    - Register `PhoneAccount` with `CAPABILITY_SELF_MANAGED`, app label, and icon
    - Expose `registrationStatus: StateFlow<RegistrationStatus>` and `phoneAccountHandle`
    - Implement `register()` and `verifyRegistration()` methods
    - Persist registration status to SharedPreferences
    - Handle `SecurityException` by setting status to `FAILED`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 10.1_

  - [ ]* 1.2 Write property test for path routing (Property 4)
    - **Property 4: Path routing is determined by registration status**
    - Generate random `RegistrationStatus` values, call IDs, and phone numbers
    - Verify that `CallServiceController` routes to Telecom_Path iff status is `REGISTERED`
    - Verify fallback to Legacy_Path when status is `FAILED` or `SecurityException` occurs
    - **Validates: Requirements 4.5, 5.1, 5.3, 7.4**

- [x] 2. SoftphoneConnection and ConnectionService
  - [x] 2.1 Create `SoftphoneConnection` class
    - Create `com/softphone/domain/call/SoftphoneConnection.kt`
    - Extend `android.telecom.Connection` with `PROPERTY_SELF_MANAGED`
    - Accept `VoiceCallManager` and `callId` in constructor
    - Implement `onAnswer()` → `setActive()` + `voiceCallManager.answerCall(callId)`
    - Implement `onReject()` → `setDisconnected(REJECTED)` + `voiceCallManager.declineCall(callId)` + `destroy()`
    - Implement `onDisconnect()` → `setDisconnected(LOCAL)` + `voiceCallManager.endCall()` + `destroy()`
    - Implement `onCallConnected()` and `onCallEnded(cause)` for app-to-framework sync
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 10.2, 10.4_

  - [ ]* 2.2 Write property test for incoming connection creation (Property 1)
    - **Property 1: Incoming connection creation invariant**
    - Generate random caller phone numbers (E.164 format) and call IDs
    - Verify `onCreateIncomingConnection()` returns a connection with `PROPERTY_SELF_MANAGED`, `STATE_RINGING`, and correct address
    - **Validates: Requirements 2.2, 3.1, 3.2, 10.4**

  - [ ]* 2.3 Write property test for outgoing connection creation (Property 2)
    - **Property 2: Outgoing connection creation invariant**
    - Generate random destination phone numbers and call IDs
    - Verify `onCreateOutgoingConnection()` returns a connection with `PROPERTY_SELF_MANAGED`, `STATE_DIALING`, and correct address
    - **Validates: Requirements 2.3, 3.1, 3.6, 10.4**

  - [x] 2.4 Create `SoftphoneConnectionService` class
    - Create `com/softphone/domain/call/SoftphoneConnectionService.kt`
    - Extend `android.telecom.ConnectionService` with `@AndroidEntryPoint`
    - Inject `VoiceCallManager` and `CallServiceController`
    - Implement `onCreateIncomingConnection()` — create `SoftphoneConnection` in `STATE_RINGING`, set address, launch `IncomingCallActivity`
    - Implement `onCreateOutgoingConnection()` — create `SoftphoneConnection` in `STATE_DIALING`, set address
    - Implement `onCreateIncomingConnectionFailed()` — fallback to `callServiceController.startForIncomingCall()`
    - Implement `onCreateOutgoingConnectionFailed()` — fallback to `callServiceController.startForOutboundCall()`
    - Define companion constants `EXTRA_CALL_ID` and `EXTRA_CALLER_NUMBER`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 4.2, 4.4_

  - [ ]* 2.5 Write property test for connection failure fallback (Property 3)
    - **Property 3: Connection failure triggers legacy fallback**
    - Generate random call metadata (call IDs, phone numbers)
    - Verify that `onCreateIncomingConnectionFailed()` invokes `startForIncomingCall()` on Legacy_Path
    - Verify that `onCreateOutgoingConnectionFailed()` invokes `startForOutboundCall()` on Legacy_Path
    - **Validates: Requirements 2.4, 4.5**

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. CallServiceController Telecom Routing
  - [x] 4.1 Extend `CallServiceController` interface with Telecom_Path methods
    - Add `handleIncomingCallViaTelecom(callId: String, remoteNumber: String)` to the interface
    - Add `handleOutgoingCallViaTelecom(destinationNumber: String)` to the interface
    - Update `CallServiceControllerImpl` to inject `PhoneAccountRegistrar`
    - Implement `handleIncomingCallViaTelecom()` — check registration status, call `telecomManager.addNewIncomingCall()`, catch `SecurityException` and fall back
    - Implement `handleOutgoingCallViaTelecom()` — check registration status, call `telecomManager.placeCall()`, catch `SecurityException` and fall back
    - _Requirements: 4.1, 4.5, 5.1, 7.1, 7.4_

  - [ ]* 4.2 Write property test for outgoing call Telecom routing (Property 11)
    - **Property 11: Outgoing call placed via TelecomManager when registered**
    - Generate random destination phone numbers
    - Verify that when registration status is `REGISTERED`, `placeCall()` is invoked with correct `tel:` URI and `PhoneAccountHandle` extras
    - **Validates: Requirements 7.1**

  - [ ]* 4.3 Write property test for answer propagation (Property 5)
    - **Property 5: Answer propagation from Connection to VoiceCallManager**
    - Generate random call IDs
    - Verify that `onAnswer()` on a RINGING connection transitions to `STATE_ACTIVE` and calls `answerCall(callId)`
    - **Validates: Requirements 3.3, 9.4**

  - [ ]* 4.4 Write property test for reject propagation (Property 6)
    - **Property 6: Reject propagation from Connection to VoiceCallManager**
    - Generate random call IDs
    - Verify that `onReject()` on a RINGING connection transitions to `STATE_DISCONNECTED(REJECTED)` and calls `declineCall(callId)`
    - **Validates: Requirements 3.4, 9.5**

  - [ ]* 4.5 Write property test for disconnect propagation (Property 7)
    - **Property 7: Disconnect propagation from Connection to VoiceCallManager**
    - Generate random call IDs
    - Verify that `onDisconnect()` on an ACTIVE connection transitions to `STATE_DISCONNECTED(LOCAL)` and calls `endCall()`
    - **Validates: Requirements 3.5, 9.3**

- [x] 5. Audio Focus Delegation
  - [x] 5.1 Modify `AudioRouter` for Telecom_Path awareness
    - Add `isTelecomPathActive` flag to `AudioRouter`
    - Modify `startCallAudioRouting()` to accept `telecomManaged: Boolean` parameter (default `false`)
    - When `telecomManaged=true`, skip `requestAudioFocus()` and `MODE_IN_COMMUNICATION` setting
    - When `telecomManaged=false`, retain current behavior (request audio focus + set mode)
    - Ensure `stopCallAudioRouting()` conditionally abandons audio focus based on path
    - Speaker/mute toggling remains unchanged on both paths
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 5.2 Write property test for audio focus delegation (Property 10)
    - **Property 10: Audio focus delegation depends on active path**
    - Generate boolean `telecomManaged` flags
    - Verify that `startCallAudioRouting(telecomManaged=true)` does NOT call `requestAudioFocus()` or set `MODE_IN_COMMUNICATION`
    - Verify that `startCallAudioRouting(telecomManaged=false)` DOES call `requestAudioFocus()` and sets `MODE_IN_COMMUNICATION`
    - **Validates: Requirements 6.1, 6.3**

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. State Synchronization and Wiring
  - [x] 7.1 Implement bidirectional state sync between `VoiceCallManager` and `SoftphoneConnection`
    - Add `SoftphoneConnection` tracking in `CallServiceControllerImpl` (store active connection reference)
    - When `VoiceCallManager` transitions to `CONNECTED` → call `connection.onCallConnected()`
    - When `VoiceCallManager` transitions to `ENDED` → call `connection.onCallEnded(cause)` with appropriate `DisconnectCause`
    - Pass `telecomManaged=true` to `audioRouter.startCallAudioRouting()` when on Telecom_Path
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [ ]* 7.2 Write property test for CONNECTED state sync (Property 8)
    - **Property 8: State sync — VoiceCallManager CONNECTED propagates to Connection**
    - Generate random call IDs
    - Verify that when `VoiceCallManager` transitions to `CONNECTED`, `onCallConnected()` is invoked on the active connection, transitioning it to `STATE_ACTIVE`
    - **Validates: Requirements 9.1, 3.7**

  - [ ]* 7.3 Write property test for ENDED state sync (Property 9)
    - **Property 9: State sync — VoiceCallManager ENDED propagates to Connection**
    - Generate random call IDs and `DisconnectCause` codes
    - Verify that when `VoiceCallManager` transitions to `ENDED`, `onCallEnded()` is invoked with the correct cause, transitioning to `STATE_DISCONNECTED`, and `destroy()` is called
    - **Validates: Requirements 9.2, 3.5**

  - [x] 7.4 Wire `PhoneAccountRegistrar` into `SoftphoneApplication.onCreate()`
    - Inject `PhoneAccountRegistrar` in `SoftphoneApplication`
    - Call `phoneAccountRegistrar.register()` during `onCreate()`
    - Call `phoneAccountRegistrar.verifyRegistration()` on subsequent launches (when already registered)
    - _Requirements: 1.1, 1.4_

  - [x] 7.5 Update `VoiceCallManager` to route calls via Telecom_Path
    - In `VoiceCallManager.makeCall()`, call `callServiceController.handleOutgoingCallViaTelecom()` instead of `callServiceController.startForOutboundCall()` when Telecom_Path is available
    - In `handleIncomingCall()`, call `callServiceController.handleIncomingCallViaTelecom()` instead of `callServiceController.startForIncomingCall()` when Telecom_Path is available
    - _Requirements: 4.1, 7.1, 5.1_

  - [x] 7.6 Update `UnifiedPushReceiver` to route incoming calls via Telecom_Path
    - When push signal arrives with incoming call, use `callServiceController.handleIncomingCallViaTelecom()` as the primary path
    - Ensure fallback to legacy `startForIncomingCall()` when Telecom_Path unavailable
    - _Requirements: 4.1, 4.5_

- [x] 8. Manifest and DI Configuration
  - [x] 8.1 Update `AndroidManifest.xml` with ConnectionService declaration
    - Add `SoftphoneConnectionService` service entry with `BIND_TELECOM_CONNECTION_SERVICE` permission
    - Add `android.telecom.ConnectionService` intent filter
    - Set `foregroundServiceType="phoneCall|microphone"`
    - Verify `MANAGE_OWN_CALLS` permission is already declared
    - _Requirements: 2.1, 8.1, 8.2, 8.3_

  - [x] 8.2 Update Hilt DI module to provide `PhoneAccountRegistrar` and updated `CallServiceController`
    - Add `PhoneAccountRegistrar` binding in the DI module
    - Update `CallServiceControllerImpl` binding to inject `PhoneAccountRegistrar`
    - Ensure `SoftphoneConnectionService` receives injected dependencies
    - _Requirements: 1.1_

- [x] 9. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using Kotest's property testing module
- Unit tests validate specific examples and edge cases
- The dual-path architecture ensures zero downtime: if TelecomManager fails, Legacy_Path handles calls seamlessly
- All Telecom_Path components gracefully fall back to Legacy_Path on SecurityException or registration failure

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4"] },
    { "id": 3, "tasks": ["2.5", "4.1", "5.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4", "4.5", "5.2"] },
    { "id": 5, "tasks": ["7.1", "8.1", "8.2"] },
    { "id": 6, "tasks": ["7.2", "7.3", "7.4", "7.5", "7.6"] }
  ]
}
```
