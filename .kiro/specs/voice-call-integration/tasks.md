# Implementation Plan: Voice Call Integration

## Overview

This plan implements the Vonage Client SDK voice call integration across the TypeScript/Fastify server and Android/Kotlin client. The server gets a VonageUserManager for user provisioning, a token endpoint for Client SDK JWTs, and corrected NCCO generation for both call legs. The Android client integrates the Vonage Client SDK for WebRTC audio, updates VoiceCallManager to coordinate token acquisition and SDK session lifecycle, and adds push notification handling for inbound calls.

## Tasks

- [x] 1. Server: Vonage User Manager and database migration
  - [x] 1.1 Create database migration for vonage_users table
    - Create `migrations/003_vonage_users.ts` with the vonage_users table schema
    - Columns: id (UUID PK), device_id (unique), vonage_user_id, vonage_user_name, display_name, push_topic, created_at, updated_at
    - Add unique index on device_id
    - _Requirements: 1.1, 1.3, 1.6_

  - [x] 1.2 Implement VonageUserManager service
    - Create `src/services/vonage-user-manager.ts`
    - Implement `ensureUser(deviceId, displayName)` — create or return existing Vonage user via Vonage Users API
    - Implement `listUsers()` — return all registered Vonage users
    - Implement `deleteUser(deviceId)` — remove from Vonage platform and local DB
    - Implement `generateClientJwt(vonageUserId)` — generate RS256 JWT with correct ACL paths
    - Validate vonage_user_name matches `^[a-zA-Z0-9_-]+$` and is 1-50 chars
    - Enforce idempotency: same deviceId always returns same user without duplicates
    - Handle Vonage API errors: do not store partial records on creation failure; retain record on deletion failure
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9_

  - [ ]* 1.3 Write property test for user idempotency (Property 4)
    - **Property 4: User Idempotency**
    - For any deviceId, calling ensureUser N times produces exactly one record with consistent vonage_user_id, non-empty push_topic, and valid vonage_user_name
    - **Validates: Requirements 1.2, 1.3, 1.5, 1.6**

  - [ ]* 1.4 Write unit tests for VonageUserManager
    - Test ensureUser creates user on first call and returns same user on subsequent calls
    - Test deleteUser removes from DB and calls Vonage API
    - Test generateClientJwt produces valid JWT with correct claims
    - Test validation rejects invalid vonage_user_name patterns
    - Test error handling: API failure does not store partial record
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.7, 1.8, 1.9_

- [x] 2. Server: Token endpoint
  - [x] 2.1 Implement POST /api/calls/token route
    - Add token handler in `src/routes/call-routes.ts`
    - Authenticate via existing session middleware
    - Validate deviceId is non-empty, at most 36 chars, UUID format
    - Return 400 if deviceId missing/empty, 401 if unauthenticated, 403 if device not registered to user, 502 if Vonage user creation fails
    - Call VonageUserManager.ensureUser and generateClientJwt
    - Return `{ jwt, vonageUser, expiresAt }` with HTTP 200
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_

  - [ ]* 2.2 Write property test for token freshness (Property 3)
    - **Property 3: Token Freshness**
    - For any valid deviceId and user, the generated JWT has sub matching vonage user, exp - iat = 86400, unique jti, and all required ACL paths
    - **Validates: Requirements 2.2, 2.3, 2.4, 2.7**

  - [ ]* 2.3 Write unit tests for token endpoint
    - Test 200 response with correct shape for valid request
    - Test 400 for missing/empty deviceId
    - Test 401 for unauthenticated request
    - Test 403 for device not belonging to user
    - Test 502 when VonageUserManager fails
    - _Requirements: 2.1, 2.5, 2.6, 2.8, 2.9_

- [x] 3. Checkpoint - Ensure all server user management and token tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Server: NCCO builder updates and inbound call push
  - [x] 4.1 Update NCCO builder for multi-user inbound calls
    - Modify `src/providers/ncco-builder.ts` to update `buildInboundCallNcco` to accept an array of Vonage users and produce one connect action per user with endpoint type 'app'
    - Add fallback: if zero users registered, return a single talk action indicating the call cannot be completed
    - Preserve existing `buildOutboundCallNcco` behavior (already correct for phone endpoint)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4_

  - [ ]* 4.2 Write property test for outbound NCCO (Property 5)
    - **Property 5: NCCO Completeness (Outbound)**
    - For any valid E.164 destination and from number, buildOutboundCallNcco produces exactly one connect action with endpoint type 'phone', correct number, and from field set
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4**

  - [ ]* 4.3 Write property test for inbound NCCO (Property 6)
    - **Property 6: NCCO Completeness (Inbound)**
    - For any non-empty list of N Vonage users, buildInboundCallNcco produces exactly N connect actions, each with endpoint type 'app' and matching user field
    - **Validates: Requirements 4.1, 4.2, 4.3**

  - [x] 4.4 Update webhook routes to use VonageUserManager for inbound NCCO
    - Modify `src/routes/webhook-routes.ts` answer webhook handler to detect direction=inbound
    - Query VonageUserManager.listUsers() and pass to updated buildInboundCallNcco
    - Ensure webhook responds within 3 seconds
    - _Requirements: 4.1, 4.2, 4.5_

  - [x] 4.5 Implement inbound call push notification via ntfy
    - Extend `src/notifications/ntfy-publisher.ts` to add `notifyIncomingCall(callId, from, vonageNumber, users)` method
    - Set priority to urgent (5), include callId, from, vonageNumber, timestamp in payload
    - Send to all registered users in parallel (Promise.allSettled)
    - Integrate into the event webhook handler: when inbound call ringing detected, trigger push
    - _Requirements: 10.1, 10.2, 10.3, 10.6_

  - [ ]* 4.6 Write property test for push notification isolation (Property 9)
    - **Property 9: Push Notification Isolation**
    - For any inbound call with N devices where a subset of pushes fail, remaining devices still receive notifications independently
    - **Validates: Requirements 10.3**

  - [ ]* 4.7 Write unit tests for updated NCCO builder and push notifications
    - Test inbound NCCO with multiple users produces correct action count
    - Test inbound NCCO with zero users returns talk action
    - Test outbound NCCO structure unchanged
    - Test push notification sends to all devices, tolerates individual failures
    - _Requirements: 3.1, 4.1, 4.4, 10.1, 10.3_

- [x] 5. Checkpoint - Ensure all server NCCO and push notification tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Android: Vonage Client SDK integration
  - [x] 6.1 Add Vonage Client SDK dependency and create VonageClientManager
    - Add `com.vonage:client-sdk-voice:4.x` to `android/app/build.gradle.kts`
    - Create `android/app/src/main/kotlin/com/softphone/domain/call/VonageClientManager.kt`
    - Implement `initialize(jwt, user)` — create session with Vonage Client SDK, emit SessionState
    - Implement `callServer(context)` — place outbound call via SDK
    - Implement `answerCall(callId)` — answer inbound call
    - Implement `rejectCall(callId)` — reject inbound call
    - Implement `hangup(callId)` — end active call
    - Implement `setMuted(muted)` and `setSpeaker(enabled)` — audio controls via SDK
    - Implement `destroy()` — disconnect session and clean up resources
    - Expose `sessionState: StateFlow<SessionState>` and `incomingCall: SharedFlow<IncomingCallInfo>`
    - Handle SDK callbacks for incoming calls, hangup, and errors
    - Handle session timeout (10s) with Error state emission
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x] 6.2 Create SessionState and IncomingCallInfo data models
    - Create `android/app/src/main/kotlin/com/softphone/domain/call/SessionState.kt` with sealed class: Disconnected, Connecting, Connected, Error
    - Create `android/app/src/main/kotlin/com/softphone/domain/call/IncomingCallInfo.kt` data class with callId, from, vonageNumber, timestamp
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 6.3 Add token API method to CallsApi
    - Add `getCallToken(deviceId): TokenResponse` to `android/app/src/main/kotlin/com/softphone/data/remote/api/CallsApi.kt`
    - Add `TokenResponse` data class to `android/app/src/main/kotlin/com/softphone/data/remote/dto/CallDtos.kt` with fields: jwt, vonageUser, expiresAt
    - _Requirements: 2.1_

- [x] 7. Android: Update VoiceCallManager with SDK orchestration
  - [x] 7.1 Integrate VonageClientManager into VoiceCallManager for outbound calls
    - Update `android/app/src/main/kotlin/com/softphone/domain/call/VoiceCallManager.kt`
    - Replace stub `initiateVonageClientCall` with real implementation: get token → initialize session → callServer
    - Replace stub `connectVonageClientSession` with real SDK answer flow
    - Replace stub `disconnectVonageClientSession` with real SDK hangup/destroy
    - Inject VonageClientManager via Hilt constructor
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 6.8_

  - [x] 7.2 Integrate VonageClientManager into VoiceCallManager for inbound calls
    - Update answer flow: acquire token → initialize session → answerCall via SDK
    - Update decline flow: rejectCall via SDK → end call
    - Handle inbound call timeout (45s without user action → ENDED with TIMEOUT)
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8_

  - [x] 7.3 Wire AudioRouter into VoiceCallManager for call audio controls
    - Inject AudioRouter into VoiceCallManager
    - Call `startCallAudioRouting()` when transitioning to CONNECTED
    - Call `stopCallAudioRouting()` when transitioning to ENDED
    - Expose mute/speaker toggles that delegate to AudioRouter
    - Add `isMuted`, `isSpeakerOn`, `currentAudioDevice` StateFlow proxies
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [ ]* 7.4 Write property test for single active call invariant (Property 1)
    - **Property 1: Single Active Call Invariant**
    - For any sequence of call operations, at most one call is active (DIALING, RINGING, or CONNECTED) at any time; new attempts while active are rejected
    - **Validates: Requirements 8.2, 6.6**

  - [ ]* 7.5 Write property test for state machine validity (Property 2)
    - **Property 2: State Machine Validity**
    - For any random (currentState, event) pair, only defined transitions are allowed; CONNECTED always has non-null connectedTime; IDLE always has null activeCallInfo
    - **Validates: Requirements 8.1, 8.4, 8.5**

  - [ ]* 7.6 Write property test for timeout guarantee (Property 7)
    - **Property 7: Timeout Guarantee**
    - For any outbound call remaining in DIALING for 30s without CONNECTED transition, the call ends with reason UNANSWERED
    - **Validates: Requirements 6.4**

  - [ ]* 7.7 Write property test for cleanup on end (Property 8)
    - **Property 8: Cleanup on End**
    - For any call transitioning to ENDED, activeCallInfo is cleared on reset, duration timer stops, and network monitoring stops
    - **Validates: Requirements 8.3**

  - [ ]* 7.8 Write property test for audio route consistency (Property 10)
    - **Property 10: Audio Route Consistency**
    - For any sequence of audio route selections during an active call, currentAudioRoute equals last user selection; mute toggles produce alternating isMuted values
    - **Validates: Requirements 9.1, 9.2, 9.3**

- [x] 8. Checkpoint - Ensure all Android call lifecycle tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Android: Push notification handling and incoming call UI
  - [x] 9.1 Update PushNotificationHandler for incoming calls
    - Modify `android/app/src/main/kotlin/com/softphone/domain/notifications/NotificationHandler.kt` to handle "incoming_call" type notifications
    - Parse callId, from, vonageNumber from notification payload
    - Forward to VoiceCallManager.handleIncomingCall when call state is IDLE
    - Ignore if call state is not IDLE (another call active)
    - Display full-screen incoming call notification within 1 second
    - _Requirements: 7.1, 7.8, 10.4, 10.5_

  - [x] 9.2 Create IncomingCallScreen composable
    - Create `android/app/src/main/kotlin/com/softphone/ui/call/IncomingCallScreen.kt`
    - Display caller phone number (or resolved contact name via ContactResolver)
    - Display vonageNumberLabel identifying which number was called
    - Show Answer and Decline action buttons
    - Wire buttons to CallViewModel answerCall/declineCall
    - _Requirements: 7.1, 7.4, 10.5_

  - [x] 9.3 Update ActiveCallScreen with audio controls
    - Update `android/app/src/main/kotlin/com/softphone/ui/call/ActiveCallScreen.kt`
    - Add mute toggle button bound to isMuted state
    - Add speaker toggle button bound to isSpeakerOn state
    - Display current audio device indicator
    - Display call duration from elapsedDurationSeconds
    - Show error message for 3 seconds when call ends with errorMessage
    - _Requirements: 9.1, 9.2, 9.6, 11.5_

- [x] 10. Android: Hilt DI wiring and device registration integration
  - [x] 10.1 Update Hilt DI modules for new components
    - Update `android/app/src/main/kotlin/com/softphone/di/AppModule.kt` to provide VonageClientManager
    - Wire VonageClientManager into VoiceCallManager constructor injection
    - Ensure AudioRouter is available for VoiceCallManager injection
    - _Requirements: 5.1, 6.1, 9.3_

  - [x] 10.2 Update device registration to trigger Vonage user provisioning
    - Modify device registration flow in `android/app/src/main/kotlin/com/softphone/data/remote/api/DevicesApiImpl.kt` to include push_topic in registration payload
    - Server-side: update `src/routes/device-routes.ts` to call VonageUserManager.ensureUser on device registration
    - Server-side: update `src/routes/device-routes.ts` to call VonageUserManager.deleteUser on device unregistration
    - _Requirements: 1.1, 1.4, 1.6_

- [x] 11. Server: Security hardening and error handling
  - [x] 11.1 Implement security controls for token and push topics
    - Ensure private key is never included in any API response or WebSocket message
    - Generate push_topic using crypto.randomUUID() on device registration
    - Validate token endpoint requires session auth (already via middleware)
    - Return appropriate errors when private key is inaccessible
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7_

  - [x] 11.2 Implement error handling for token and registration failures
    - Return HTTP 500 with descriptive error when JWT generation fails (missing key, unknown user)
    - Return HTTP 500 when Vonage Users API fails during registration
    - Log errors server-side for debugging
    - _Requirements: 11.1, 11.4_

  - [ ]* 11.3 Write unit tests for security and error handling
    - Test private key never appears in responses
    - Test push_topic is UUID v4 format
    - Test error responses for missing private key
    - Test error responses for failed Vonage API calls
    - _Requirements: 12.1, 12.3, 12.7, 11.1, 11.4_

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The server uses TypeScript with Vitest and fast-check for testing
- The Android client uses Kotlin with kotest-property for property-based tests
- The existing VoiceCallManager already has stub methods for Vonage Client SDK integration that need to be replaced with real implementations

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "6.2", "6.3"] },
    { "id": 1, "tasks": ["1.2", "6.1"] },
    { "id": 2, "tasks": ["1.3", "1.4", "2.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "4.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4", "4.5"] },
    { "id": 5, "tasks": ["4.6", "4.7", "7.1"] },
    { "id": 6, "tasks": ["7.2", "7.3"] },
    { "id": 7, "tasks": ["7.4", "7.5", "7.6", "7.7", "7.8"] },
    { "id": 8, "tasks": ["9.1", "9.2", "9.3"] },
    { "id": 9, "tasks": ["10.1", "10.2", "11.1", "11.2"] },
    { "id": 10, "tasks": ["11.3"] }
  ]
}
```
