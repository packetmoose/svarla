# Requirements Document

## Introduction

This document specifies the requirements for integrating voice call capabilities into the softphone application using the Vonage Client SDK for WebRTC audio on Android and server-side coordination via the existing Fastify backend. The feature enables outbound calls to PSTN destinations and inbound calls from the phone network, with push notification delivery, audio routing controls, and robust error handling.

## Glossary

- **Server**: The TypeScript/Fastify backend application that coordinates Vonage API interactions, JWT generation, NCCO routing, and user provisioning
- **Android_Client**: The Android application built with Kotlin/Compose that provides the user interface and integrates the Vonage Client SDK
- **VonageUserManager**: The server-side component responsible for creating, retrieving, and deleting Vonage Application Users
- **TokenEndpoint**: The POST /api/calls/token server endpoint that issues Vonage Client SDK JWTs
- **NccoBuilder**: The server-side component that generates Nexmo Call Control Objects for call routing
- **VonageClientManager**: The Android component wrapping the Vonage Client SDK lifecycle, session management, and call operations
- **VoiceCallManager**: The Android component orchestrating the full call lifecycle by coordinating token acquisition, SDK management, and UI state
- **PushNotificationHandler**: The Android component that receives and processes ntfy push notifications for incoming calls
- **CallStateMachine**: The state machine governing call status transitions on the Android client
- **AudioRouter**: The Android component managing audio device routing and mute/speaker state during calls
- **NCCO**: Nexmo Call Control Object — a JSON array of actions that controls call flow on the Vonage platform
- **E164_Number**: A phone number formatted according to the E.164 international standard (e.g., +14155552671)
- **Client_SDK_JWT**: An RS256-signed JSON Web Token that authenticates a Vonage Client SDK session
- **AudioRoute**: The active audio output path (earpiece, speaker, Bluetooth, or wired headset)

## Requirements

### Requirement 1: Vonage User Provisioning

**User Story:** As a device owner, I want the server to automatically provision a Vonage user for my device, so that I can establish WebRTC sessions for voice calls.

#### Acceptance Criteria

1. WHEN a device registers with the Server, THE VonageUserManager SHALL create a Vonage Application User via the Vonage Users API and store the device-to-user mapping in PostgreSQL
2. WHEN a device that already has a Vonage user requests provisioning, THE VonageUserManager SHALL return the existing user record without creating a duplicate (idempotent behavior)
3. THE VonageUserManager SHALL enforce that each device_id maps to exactly one Vonage user record in the database
4. WHEN a device unregisters, THE VonageUserManager SHALL delete the corresponding Vonage user from both the Vonage platform and the local database
5. THE VonageUserManager SHALL validate that vonage_user_name matches the pattern ^[a-zA-Z0-9_-]+$ and is between 1 and 50 characters in length
6. THE VonageUserManager SHALL store a non-empty push_topic for each registered device to enable inbound call notifications
7. IF the Vonage Users API returns an error or is unreachable during user creation, THEN THE VonageUserManager SHALL return an error response indicating provisioning failed and SHALL NOT store a partial device-to-user mapping in the database
8. IF the Vonage Users API returns an error during user deletion, THEN THE VonageUserManager SHALL log the failure, retain the local database record, and return an error response indicating the deletion was incomplete
9. IF the vonage_user_name validation fails, THEN THE VonageUserManager SHALL reject the provisioning request with an error response indicating the name format is invalid

### Requirement 2: Client SDK Token Generation

**User Story:** As an Android client, I want to obtain a time-limited Vonage Client SDK JWT from the server, so that I can authenticate my WebRTC session with the Vonage platform.

#### Acceptance Criteria

1. WHEN an authenticated client sends a POST request to /api/calls/token with a deviceId that is a non-empty string of at most 36 characters matching UUID format and registered to the authenticated user's account, THE TokenEndpoint SHALL return HTTP 200 with a JSON response containing a "jwt" field (non-empty string), a "vonageUser" field (non-empty string identifying the Vonage user), and an "expiresAt" field (integer epoch seconds indicating token expiration time)
2. THE TokenEndpoint SHALL generate RS256-signed JWTs where the sub claim equals the Vonage user name that the VonageUserManager associates with the requesting deviceId and authenticated session
3. THE TokenEndpoint SHALL set JWT expiry to exactly 24 hours after issuance (exp - iat = 86400 seconds)
4. THE TokenEndpoint SHALL include ACL paths granting full access (all methods) to the following Vonage API path prefixes: users, conversations, sessions, devices, image, media, applications, push, knocking, and legs
5. WHEN a request to /api/calls/token has a missing or empty deviceId in the request body, THE TokenEndpoint SHALL return HTTP 400 with a JSON response containing an error field indicating that deviceId is required
6. WHEN a request to /api/calls/token lacks a valid session authentication token, THE TokenEndpoint SHALL return HTTP 401
7. THE TokenEndpoint SHALL generate a unique jti claim for each issued token using a UUID v4 value
8. IF the deviceId provided is not registered to the authenticated user's account, THEN THE TokenEndpoint SHALL return HTTP 403 with a JSON response containing an error field indicating the device is not authorized
9. IF the VonageUserManager fails to create or retrieve the Vonage user for the device, THEN THE TokenEndpoint SHALL return HTTP 502 with a JSON response containing an error field indicating a downstream service failure, and SHALL NOT issue a JWT

### Requirement 3: Outbound Call NCCO Generation

**User Story:** As the Vonage platform, I want to receive a correct NCCO for outbound calls, so that the destination phone is connected while the originator remains on the WebRTC leg.

#### Acceptance Criteria

1. WHEN the Server receives an answer webhook with direction=outbound, THE NccoBuilder SHALL return an NCCO containing exactly one connect action with endpoint type 'phone' and the destination number set in the endpoint's number field
2. WHEN building an outbound NCCO, THE NccoBuilder SHALL set the 'from' field on the connect action to the caller's Vonage number in E.164 format (matching ^\+[1-9]\d{1,14}$)
3. WHEN an eventUrl is provided, THE NccoBuilder SHALL include it as a single-element array in the connect action's eventUrl field
4. IF an eventUrl is not provided, THEN THE NccoBuilder SHALL omit the eventUrl field from the connect action entirely
5. THE NccoBuilder SHALL include the destination number in E.164 format (matching ^\+[1-9]\d{1,14}$) in the phone endpoint's number field

### Requirement 4: Inbound Call NCCO Generation

**User Story:** As the Vonage platform, I want to receive a correct NCCO for inbound calls, so that all registered devices ring simultaneously.

#### Acceptance Criteria

1. WHEN the Server receives an answer webhook with direction=inbound, THE NccoBuilder SHALL return an NCCO containing one connect action per registered Vonage user, each with endpoint type 'app' and the user field set to that Vonage user's identifier
2. THE NccoBuilder SHALL produce an NCCO where the number of connect actions equals the number of registered Vonage users at the time the webhook is received
3. WHEN an eventUrl is provided, THE NccoBuilder SHALL include it as a single-element array in each inbound NCCO connect action
4. IF zero Vonage users are registered when an inbound answer webhook is received, THEN THE Server SHALL return an NCCO containing a single talk action with a message indicating the call cannot be completed, and SHALL NOT return an empty NCCO array
5. THE Server SHALL respond to the inbound answer webhook within 3 seconds to prevent the Vonage platform from timing out the request

### Requirement 5: Vonage Client SDK Session Management

**User Story:** As a device user, I want the app to establish a WebRTC session with the Vonage platform, so that I can send and receive audio during calls.

#### Acceptance Criteria

1. WHEN the VonageClientManager receives a valid JWT and matching user identifier, THE VonageClientManager SHALL establish a WebRTC session within 10 seconds and emit a Connected session state
2. IF the JWT is invalid or expired during session initialization, THEN THE VonageClientManager SHALL emit an Error session state with a message indicating the authentication failure reason
3. IF the network is unreachable during session initialization or the session is not established within 10 seconds, THEN THE VonageClientManager SHALL emit an Error session state with a message indicating the connection failure
4. WHEN destroy() is called, THE VonageClientManager SHALL disconnect the SDK session, transition the session state to Disconnected, and cancel any pending initialization
5. IF an active session already exists when a new session initialization is requested, THEN THE VonageClientManager SHALL disconnect the existing session before initializing the new session
6. IF the network connection is lost while a session is in the Connected state, THEN THE VonageClientManager SHALL emit an Error session state with a message indicating the connection was lost

### Requirement 6: Outbound Call Lifecycle

**User Story:** As a device user, I want to place outbound calls to phone numbers, so that I can communicate with people via PSTN.

#### Acceptance Criteria

1. WHEN the user initiates an outbound call with a valid E.164 destination number, THE VoiceCallManager SHALL transition the call state from IDLE to DIALING, store the destination number and selected Vonage number in activeCallInfo, and start a 30-second timeout
2. WHEN an outbound call transitions to DIALING state, THE VoiceCallManager SHALL acquire a token, initialize the SDK session, and place the call via callServer with the selected Vonage number as caller ID and the destination number as the target
3. WHEN the remote party answers (call_event status:connected received), THE VoiceCallManager SHALL transition the call state from DIALING to CONNECTED, set connectedTime to the current timestamp, and start the duration timer
4. WHEN the 30-second outbound timeout expires without a CONNECTED transition, THE VoiceCallManager SHALL disconnect the SDK session and transition the call to ENDED with reason UNANSWERED
5. IF token acquisition or SDK initialization fails during an outbound call, THEN THE VoiceCallManager SHALL transition the call to ENDED with reason FAILED and an error message indicating the failure cause
6. IF an outbound call is attempted when the current state is not IDLE, THEN THE VoiceCallManager SHALL reject the attempt without changing the current call state and log a warning
7. IF the destination number does not conform to E.164 format, THEN THE VoiceCallManager SHALL reject the outbound call attempt without transitioning from IDLE and indicate that the number is invalid
8. WHEN the user ends a call while in DIALING state, THE VoiceCallManager SHALL cancel the outbound timeout, disconnect the SDK session, and transition the call to ENDED with reason LOCAL_HANGUP

### Requirement 7: Inbound Call Lifecycle

**User Story:** As a device user, I want to receive incoming phone calls with the option to answer or reject them, so that I can handle communications from the phone network.

#### Acceptance Criteria

1. WHEN a push notification for an incoming call is received AND the call state is IDLE, THE PushNotificationHandler SHALL transition the call state to RINGING and display the incoming call UI showing the caller's phone number and the Vonage number that was called
2. WHEN the user answers an incoming call in RINGING state, THE VoiceCallManager SHALL acquire a token, initialize the SDK session, and answer the call via the SDK
3. WHEN the SDK confirms the inbound call is answered, THE VoiceCallManager SHALL transition the call state to CONNECTED and start the duration timer
4. WHEN the user rejects an incoming call, THE VonageClientManager SHALL call rejectCall with the callId and transition the state to ENDED with reason DECLINED
5. IF token acquisition or SDK initialization fails while answering an inbound call, THEN THE VoiceCallManager SHALL transition the call to ENDED with reason FAILED and provide an error message describing the failure
6. IF the remote caller disconnects while the call is in RINGING state, THEN THE VoiceCallManager SHALL transition the call to ENDED with reason REMOTE_HANGUP
7. IF the call remains in RINGING state for more than 45 seconds without user action or remote disconnection, THEN THE VoiceCallManager SHALL transition the call to ENDED with reason TIMEOUT
8. IF a push notification for an incoming call is received while the call state is not IDLE, THEN THE PushNotificationHandler SHALL ignore the incoming call notification without changing the current call state

### Requirement 8: Call State Machine Integrity

**User Story:** As a developer, I want the call state machine to enforce valid transitions only, so that the application never reaches an inconsistent state.

#### Acceptance Criteria

1. THE CallStateMachine SHALL allow only the following transitions: IDLE to DIALING, IDLE to RINGING, DIALING to CONNECTED, DIALING to ENDED, RINGING to CONNECTED, RINGING to ENDED, CONNECTED to ENDED, ENDED to IDLE
2. IF a transition is attempted that is not in the set of allowed transitions, THEN THE CallStateMachine SHALL reject the transition, preserve the current state unchanged, and log a warning message indicating the rejected source state and target state
3. IF a call event is received while the CallStateMachine is in DIALING, RINGING, or CONNECTED state, THEN THE CallStateMachine SHALL ignore the incoming call event and preserve the current active call state unchanged
4. WHEN a call transitions to ENDED, THE CallStateMachine SHALL stop the duration timer, stop network monitoring, retain activeCallInfo for UI display, and set the endReason to the cause of termination
5. WHEN a call transitions from ENDED to IDLE, THE CallStateMachine SHALL clear activeCallInfo to null, clear endReason to null, and reset elapsedDurationSeconds to 0
6. THE CallStateMachine SHALL ensure that CONNECTED state always has a non-null connectedTime value in activeCallInfo
7. THE CallStateMachine SHALL ensure that IDLE state always has a null activeCallInfo value and a null endReason value

### Requirement 9: Audio Routing and Call Controls

**User Story:** As a user on an active call, I want to control audio routing and mute state, so that I can manage my call experience hands-free or privately.

#### Acceptance Criteria

1. WHEN the user toggles mute during an active call, THE AudioRouter SHALL invert the current isMuted state, apply it to the system microphone, and emit the updated value on the isMuted StateFlow within 500 milliseconds
2. WHEN the user toggles speaker during an active call, THE AudioRouter SHALL invert the current isSpeakerOn state, route audio to speaker (if enabling) or to the highest-priority available device (if disabling), and emit the updated value on the isSpeakerOn StateFlow within 500 milliseconds
3. WHEN a call transitions to the CONNECTED state, THE AudioRouter SHALL initialize isMuted to false, isSpeakerOn to false, and currentAudioDevice to the highest-priority available device using priority order: wired headset > Bluetooth > earpiece
4. WHEN an external audio device (Bluetooth or wired headset) connects or disconnects during an active call, THE AudioRouter SHALL update the availableDevices set and automatically re-route audio to the highest-priority available device without interrupting the active audio stream
5. IF the user toggles mute or speaker while no call is active, THEN THE AudioRouter SHALL ignore the request and not modify any audio state
6. THE Android_Client SHALL support audio routing to earpiece, speaker, Bluetooth, and wired headset

### Requirement 10: Push Notifications for Incoming Calls

**User Story:** As a device user, I want to receive push notifications for incoming calls even when the app is in the background, so that I never miss a call.

#### Acceptance Criteria

1. WHEN an inbound call arrives, THE Server SHALL send a push notification via ntfy to all registered devices within 3 seconds, including the callId, caller phone number, vonageNumber, vonageNumberLabel, and timestamp in the notification payload
2. WHEN the Server sends a push notification for an incoming call, THE Server SHALL set the ntfy priority to 5 (urgent) and include the notification type "incoming_call" in the payload extras
3. IF a push notification fails to deliver to one device, THEN THE Server SHALL continue delivering to remaining devices in parallel without blocking or delaying their delivery
4. THE Server SHALL provide three notification delivery paths (Vonage SDK push, ntfy push, WebSocket call_event) so that a device receives the incoming call signal if at least one path is operational
5. WHEN the PushNotificationHandler receives a call notification, THE Android_Client SHALL display a full-screen incoming call notification within 1 second, showing the caller's phone number or resolved contact name, the vonageNumberLabel identifying which number was called, and action buttons to answer or decline the call, regardless of whether the app is in the foreground or background
6. IF the Server detects that a call has already ended or been answered before a queued push notification is delivered, THEN THE Server SHALL discard the notification and SHALL NOT deliver it to any device

### Requirement 11: Error Handling and Recovery

**User Story:** As a device user, I want the application to handle errors gracefully during calls, so that I understand what happened and can take corrective action.

#### Acceptance Criteria

1. IF the Server cannot generate a JWT due to a missing private key or unknown user, THEN THE Server SHALL return HTTP 500 with an error message indicating the cause of token generation failure
2. IF the Vonage Client SDK fails to establish a WebRTC session within 10 seconds, THEN THE VoiceCallManager SHALL transition the call to ENDED with reason FAILED and set a non-null errorMessage describing the session failure
3. IF the device loses network connectivity while the call state is DIALING or CONNECTED, THEN THE VoiceCallManager SHALL disconnect the SDK session and transition the call to ENDED with reason CONNECTIVITY_LOST and set the errorMessage to indicate connectivity loss
4. IF the Vonage Users API returns an error during device registration, THEN THE Server SHALL return HTTP 500 with an error message indicating the registration failure cause
5. WHEN a call transitions to ENDED with a non-null errorMessage, THE Android_Client SHALL display the failure reason to the user for at least 3 seconds and provide a control to reset the call state to IDLE
6. IF token acquisition fails during an outbound or inbound call setup, THEN THE Android_Client SHALL display an error message indicating call setup failure and the VoiceCallManager SHALL transition the call to ENDED with reason FAILED

### Requirement 12: Security and Token Scoping

**User Story:** As a system administrator, I want tokens and credentials to be properly scoped and secured, so that compromised credentials have minimal impact.

#### Acceptance Criteria

1. THE Server SHALL store the Vonage private key exclusively server-side and never include it in any API response, WebSocket message, or client-facing payload
2. THE TokenEndpoint SHALL scope each Client_SDK_JWT to a single Vonage user by setting the sub claim to the requesting device's Vonage user identifier, and SHALL restrict ACL permissions to only the paths required for Client SDK operation (users, conversations, sessions, devices, image, media, applications, push, knocking, and legs endpoints)
3. THE Server SHALL generate push notification topics using a cryptographically random UUID v4 per registered device, and SHALL not derive topic names from predictable values such as device name, user identity, or sequential identifiers
4. THE TokenEndpoint SHALL require valid session authentication before issuing any Client_SDK_JWT, and SHALL include a unique jti claim in each issued token to prevent replay
5. THE Server SHALL set JWT expiry to exactly 24 hours after issuance (exp minus iat equals 86400 seconds) to limit exposure duration of compromised tokens
6. IF the TokenEndpoint receives a request without valid session authentication, THEN THE Server SHALL reject the request with an authentication error and SHALL NOT issue a Client_SDK_JWT
7. IF the Vonage private key file is inaccessible or unreadable when JWT generation is attempted, THEN THE Server SHALL return an error response indicating token generation failure and SHALL NOT issue a Client_SDK_JWT
