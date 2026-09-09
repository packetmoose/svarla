# Requirements Document

## Introduction

This document specifies the requirements for adding full two-way voice calling to the Svarla web UI (a Preact single-page application in `web/`). Today the web UI is a passive observer: `call-banner.tsx` subscribes to server WebSocket call events and displays a "Call in progress" banner, but there is no `RTCPeerConnection`, no microphone capture, no call audio playback, no dialer, and no answer/decline surface. This feature brings the browser to parity with the Android reference client so that a user can place outbound calls and receive and answer inbound calls directly in the browser.

The backend plumbing already exists and is provider-agnostic. The Server exposes a complete calling REST API (`src/routes/call-routes.ts`), the MediaBridge (Go/Pion) terminates a WebRTC client leg and bridges it to the telephony provider, and real-time call signaling already reaches the browser over the Server WebSocket (`web/src/ws.ts`). This feature is therefore predominantly frontend work: implementing the WebRTC client, the dialer, the incoming-call surface, in-call controls, and browser device registration.

The MediaBridge negotiates a PCM audio codec (16-bit LE, 16kHz mono) rather than Opus. Because `RTCPeerConnection` negotiates the codec via SDP, this does not materially change the browser client implementation. The MediaBridge uses ICE Lite and bundles all ICE candidates into the SDP answer, so the browser is not required to perform trickle ICE.

**In scope:** outbound calling, inbound call receipt and answering, the WebRTC audio session lifecycle, in-call controls (mute, DTMF, duration, hang up), browser device registration as a call target, multi-device "answered elsewhere" behavior, and failure/edge-case handling.

**Out of scope (non-goals):** SMS and Conversations (already implemented and working), any change to the MediaBridge media format or the ControlAPI, and any change to the Android application.

## Glossary

- **Web_Client**: The Preact single-page application in `web/` that provides the browser user interface.
- **Web_Call_Client**: The browser-side WebRTC component (the web analog of the Android `WebRtcAudioClient`) that manages a single `RTCPeerConnection` to the MediaBridge, including offer creation, answer application, mute, DTMF, and teardown.
- **Server**: The TypeScript/Fastify backend that exposes the calling REST API and the Server WebSocket.
- **Calling_API**: The provider-agnostic REST endpoints under `/api/calls/*` defined in `src/routes/call-routes.ts`.
- **MediaBridge**: The Go/Pion service that terminates the browser WebRTC leg and bridges audio to the telephony provider.
- **Server_WebSocket**: The real-time channel defined in `web/src/ws.ts` over which the Server pushes `call_event` and `call_cancelled` messages to the Web_Client.
- **Dialer**: The Web_Client UI surface for composing and placing an outbound call.
- **Incoming_Call_Surface**: The Web_Client UI that presents a ringing inbound call with Answer and Decline actions.
- **In_Call_Surface**: The Web_Client UI shown while a call is connected, containing mute, DTMF, duration, and hang-up controls.
- **Web_Device**: The Web_Client registered in the device registry as a ringable call target, created with the `skipDeviceLimit` flag.
- **Device_Registry**: The server-side device store managed by `DeviceRegistryManager` (`src/services/device-registry-manager.ts`), which enforces a maximum of 5 active devices for non-web devices.
- **Call_Connection_State**: The Web_Call_Client connection state, one of Disconnected, Connecting, Connected, or Failed, mirroring the Android reference state machine.
- **Media_Inactivity_Watchdog**: A Web_Call_Client mechanism that detects when inbound media has stopped (remote hangup) even though ICE remains nominally connected, used as a last-resort teardown.
- **E164_Number**: A phone number formatted according to the E.164 international standard (e.g., +14155552671).
- **DTMF_Digit**: A single dual-tone multi-frequency character, one of 0-9, `*`, or `#`.
- **RTCDTMFSender**: The browser WebRTC API for sending in-band DTMF tones (RFC 4733/2833) on an audio track.
- **SDP_Offer**: The Session Description Protocol offer string the Web_Call_Client generates for the MediaBridge.
- **SDP_Answer**: The Session Description Protocol answer string returned by the Calling_API from the MediaBridge, with bundled ICE candidates.
- **ICE_Server**: A STUN or TURN server used by the browser for NAT traversal during WebRTC connection establishment.

## Requirements

### Requirement 1: Browser Device Registration as a Call Target

**User Story:** As a browser user, I want my browser tab to register as a device, so that inbound calls ring in the browser and I can be reached like my phone.

#### Acceptance Criteria

1. WHEN an authenticated user loads the Web_Client and no Web_Device is registered for the current session, THE Web_Client SHALL register a Web_Device via the Device_Registry with the `skipDeviceLimit` flag set to true.
2. WHERE the `skipDeviceLimit` flag is set to true, THE Device_Registry SHALL register the Web_Device without counting it against the 5 active-device limit.
3. THE Web_Client SHALL assign the Web_Device a device name that identifies it as a browser session.
4. WHEN the Web_Device is registered, THE Web_Client SHALL persist the resulting device identifier for the duration of the browser session.
5. WHEN the user logs out of the Web_Client, THE Web_Client SHALL deregister the Web_Device from the Device_Registry.
6. IF Web_Device registration fails, THEN THE Web_Client SHALL display an error message indicating that inbound calling is unavailable and SHALL allow the user to retry registration.
7. WHILE no Web_Device is registered, THE Web_Client SHALL disable the Incoming_Call_Surface.

### Requirement 2: Place an Outbound Call

**User Story:** As a browser user, I want to dial a phone number and place a call, so that I can reach someone from my browser.

#### Acceptance Criteria

1. THE Dialer SHALL provide an input for entering a destination phone number and a control for selecting the originating provider number.
2. WHEN the user submits a destination number, THE Web_Client SHALL validate the destination number and normalize it to an E164_Number before initiating the call.
3. IF the destination number fails validation, THEN THE Web_Client SHALL display a validation error and SHALL NOT send the call request.
4. WHEN the user places a validated call, THE Web_Client SHALL send a `POST /api/calls/make` request containing the selected originating number and the normalized E164_Number.
5. WHEN the Calling_API returns a call identifier for an outbound call, THE Web_Client SHALL transition to establishing a WebRTC audio session for that call identifier.
6. IF the `POST /api/calls/make` request returns HTTP 503, THEN THE Web_Client SHALL display a message indicating the calling service is unavailable and SHALL return the Dialer to its idle state.
7. IF the `POST /api/calls/make` request returns HTTP 400, THEN THE Web_Client SHALL display the validation error returned by the Calling_API.

### Requirement 3: Receive and Answer an Inbound Call

**User Story:** As a browser user, I want to see and answer incoming calls in the browser, so that I can take calls without my phone.

#### Acceptance Criteria

1. WHEN the Server_WebSocket delivers a `call_event` with status `connected` for a call not already displayed, THE Web_Client SHALL present the Incoming_Call_Surface with the caller number when available.
2. WHEN the Web_Client establishes or re-establishes the Server_WebSocket connection, THE Web_Client SHALL fetch active calls via `GET /api/calls/active` and present the Incoming_Call_Surface for any active call the user has not yet joined.
3. WHEN the user selects Answer on the Incoming_Call_Surface, THE Web_Client SHALL send a `POST /api/calls/answer/:callId` request for the displayed call identifier.
4. WHEN the Calling_API confirms the answer with HTTP 200, THE Web_Client SHALL transition to establishing a WebRTC audio session for that call identifier.
5. WHEN the user selects Decline on the Incoming_Call_Surface, THE Web_Client SHALL send a `POST /api/calls/decline/:callId` request and SHALL dismiss the Incoming_Call_Surface.
6. IF the `POST /api/calls/answer/:callId` request returns HTTP 409, THEN THE Web_Client SHALL dismiss the Incoming_Call_Surface and display a message indicating the call is no longer available.

### Requirement 4: Establish the WebRTC Audio Session

**User Story:** As a browser user, I want the browser to set up two-way audio when a call connects, so that I can hear and speak to the other party.

#### Acceptance Criteria

1. WHEN a WebRTC audio session is required for a call identifier, THE Web_Call_Client SHALL request microphone access from the browser before creating the SDP_Offer.
2. IF the user denies microphone access, THEN THE Web_Call_Client SHALL abort the audio session, display a message indicating microphone permission is required, and end the associated call.
3. WHEN microphone access is granted, THE Web_Call_Client SHALL create an `RTCPeerConnection`, add the captured local audio track, and generate an SDP_Offer.
4. WHEN the SDP_Offer is generated, THE Web_Call_Client SHALL send a `POST /api/calls/webrtc/offer` request containing the SDP_Offer and the call identifier.
5. WHEN the Calling_API returns an SDP_Answer, THE Web_Call_Client SHALL apply the SDP_Answer as the remote description.
6. WHEN the remote audio track is received, THE Web_Call_Client SHALL route the remote audio to a browser audio output element for playback.
7. WHEN ICE and DTLS negotiation completes successfully, THE Web_Call_Client SHALL set the Call_Connection_State to Connected.
8. THE Web_Call_Client SHALL apply the ICE candidates bundled in the SDP_Answer without requiring trickle ICE exchange.

### Requirement 5: Call Connection State Lifecycle

**User Story:** As a browser user, I want the call state to reflect what is actually happening, so that the UI accurately shows connecting, connected, and failed states.

#### Acceptance Criteria

1. WHEN the Web_Call_Client begins creating an SDP_Offer, THE Web_Call_Client SHALL set the Call_Connection_State to Connecting.
2. WHILE the Call_Connection_State is Connecting, THE In_Call_Surface SHALL indicate that the call is connecting.
3. WHEN ICE negotiation fails, THE Web_Call_Client SHALL set the Call_Connection_State to Failed with a reason.
4. WHEN the Web_Call_Client is torn down, THE Web_Call_Client SHALL set the Call_Connection_State to Disconnected and release the microphone track and the `RTCPeerConnection`.
5. IF the WebRTC connection is lost while the Call_Connection_State is Connected, THEN THE Web_Call_Client SHALL set the Call_Connection_State to Failed with a reason and end the call.

### Requirement 6: In-Call Mute Control

**User Story:** As a browser user, I want to mute and unmute my microphone during a call, so that I can control what the other party hears.

#### Acceptance Criteria

1. WHILE the Call_Connection_State is Connected, THE In_Call_Surface SHALL provide a mute control.
2. WHEN the user activates the mute control, THE Web_Call_Client SHALL disable the local audio track.
3. WHEN the user deactivates the mute control, THE Web_Call_Client SHALL enable the local audio track.
4. THE In_Call_Surface SHALL display whether the microphone is currently muted or unmuted.

### Requirement 7: In-Call DTMF Keypad

**User Story:** As a browser user, I want a keypad to send touch tones during a call, so that I can navigate phone menus.

#### Acceptance Criteria

1. WHILE the Call_Connection_State is Connected, THE In_Call_Surface SHALL provide a DTMF keypad supporting the digits 0-9, `*`, and `#`.
2. WHEN the user presses a DTMF_Digit, THE Web_Call_Client SHALL send the DTMF_Digit in-band using the RTCDTMFSender on the local audio track.
3. IF the RTCDTMFSender is unavailable for the active session, THEN THE Web_Call_Client SHALL send the DTMF_Digit via `POST /api/calls/:callId/dtmf` as a fallback.
4. IF the user submits a character that is not a DTMF_Digit, THEN THE Web_Call_Client SHALL reject the input and SHALL NOT send a DTMF signal.

### Requirement 8: Call Duration and Hang Up

**User Story:** As a browser user, I want to see how long the call has lasted and be able to hang up, so that I can manage the call.

#### Acceptance Criteria

1. WHEN the Call_Connection_State becomes Connected, THE In_Call_Surface SHALL start a call duration timer.
2. WHILE the Call_Connection_State is Connected, THE In_Call_Surface SHALL display the elapsed call duration.
3. WHEN the user selects hang up, THE Web_Call_Client SHALL send a `POST /api/calls/decline/:callId` request for the active call identifier and SHALL tear down the WebRTC audio session.
4. WHEN a call ends for any reason, THE In_Call_Surface SHALL stop the call duration timer and return the Web_Client to its idle state.

### Requirement 9: Remote Hangup and Call Termination Signaling

**User Story:** As a browser user, I want the call to end in my browser when the other party hangs up, so that I am not left in a dead call.

#### Acceptance Criteria

1. WHEN the Server_WebSocket delivers a `call_event` with status `completed`, `failed`, or `busy` for the active call identifier, THE Web_Client SHALL tear down the WebRTC audio session and return to its idle state.
2. WHEN the Server_WebSocket delivers a `call_cancelled` event with reason `answered_elsewhere` for a displayed inbound call, THE Web_Client SHALL dismiss the Incoming_Call_Surface for that call identifier.
3. WHILE the Call_Connection_State is Connected, THE Media_Inactivity_Watchdog SHALL monitor inbound media reception.
4. IF inbound media stops for a sustained interval while the Call_Connection_State remains Connected and no termination signal has been received, THEN THE Web_Call_Client SHALL tear down the WebRTC audio session as a last-resort teardown.

### Requirement 10: Multi-Device and Multi-Tab Behavior

**User Story:** As a user with a phone and multiple browser tabs, I want only one endpoint to hold each call, so that answering in one place clears the ringing everywhere else.

#### Acceptance Criteria

1. WHEN an inbound call is answered on another device, THE Web_Client SHALL dismiss the Incoming_Call_Surface in response to the `answered_elsewhere` signal.
2. WHILE a call is connected on another endpoint, THE Web_Client SHALL display a call-in-progress indication rather than the Incoming_Call_Surface for that call identifier.
3. WHERE multiple Web_Client tabs are open for the same user, THE Web_Client in each tab SHALL independently receive Server_WebSocket call signaling.
4. WHEN a call is answered in one Web_Client tab, THE other Web_Client tabs SHALL dismiss the Incoming_Call_Surface for that call identifier.

### Requirement 11: Calling Service and Signaling Failure Handling

**User Story:** As a browser user, I want clear behavior when the calling service or signaling fails, so that I understand why a call could not be established.

#### Acceptance Criteria

1. IF the `POST /api/calls/webrtc/offer` request returns HTTP 503, THEN THE Web_Client SHALL display a message indicating the media service is unavailable and SHALL end the call attempt.
2. IF the `POST /api/calls/webrtc/offer` request returns HTTP 504, THEN THE Web_Client SHALL display a message indicating signaling timed out and SHALL end the call attempt.
3. IF the `POST /api/calls/webrtc/offer` request returns HTTP 404, THEN THE Web_Client SHALL display a message indicating the call was not found and SHALL return to its idle state.
4. IF the Server_WebSocket connection is lost during an active call, THEN THE Web_Client SHALL continue playing established call audio while the WebRTC connection remains Connected.
5. WHEN the Server_WebSocket reconnects, THE Web_Client SHALL reconcile displayed call state against `GET /api/calls/active`.

### Requirement 12: ICE and TURN Reachability

**User Story:** As a browser user on a real-world network, I want NAT traversal to work, so that call audio connects even when I am behind a firewall or carrier-grade NAT.

#### Acceptance Criteria

1. THE Web_Call_Client SHALL configure the `RTCPeerConnection` with the ICE_Server set required for NAT traversal to the MediaBridge.
2. WHERE a TURN relay is configured, THE Web_Call_Client SHALL use the TURN relay when direct connectivity to the MediaBridge cannot be established.
3. IF ICE connectivity cannot be established within the negotiation timeout, THEN THE Web_Call_Client SHALL set the Call_Connection_State to Failed with a reason and end the call attempt.
