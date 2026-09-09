# Requirements Document

## Introduction

This document specifies the requirements for adding full two-way voice calling to the Svarla web UI (a Preact single-page application in `web/`). Today the web UI is a passive observer: `call-banner.tsx` subscribes to server WebSocket call events and displays a "Call in progress" banner, but there is no `RTCPeerConnection`, no microphone capture, no call audio playback, no dialer, and no answer/decline surface. This feature brings the browser to parity with the Android reference client so that a user can place outbound calls and receive and answer inbound calls directly in the browser.

The backend plumbing already exists and is provider-agnostic. The Server exposes a complete calling REST API (`src/routes/call-routes.ts`), the MediaBridge (Go/Pion) terminates a WebRTC client leg and bridges it to the telephony provider, and real-time call signaling already reaches the browser over the Server WebSocket (`web/src/ws.ts`). This feature is therefore predominantly frontend work: implementing the WebRTC client, the dialer, the incoming-call surface, in-call controls, and browser device registration.

The MediaBridge negotiates a PCM audio codec (16-bit LE, 16kHz mono) rather than Opus. Because `RTCPeerConnection` negotiates the codec via SDP, this does not materially change the browser client implementation. The MediaBridge uses ICE Lite and bundles all ICE candidates into the SDP answer, so the browser is not required to perform trickle ICE.

**In scope:** outbound calling, inbound call receipt and answering, inbound call alerting (audible ringtone and attention signals), the WebRTC audio session lifecycle, remote audio playback (including autoplay handling and volume control), in-call controls (mute, DTMF, duration, hang up), browser capability and secure-context precondition handling, concurrency handling (a single active call per tab), accessibility of the call surfaces, call-history integration, browser device registration as a call target, multi-device "answered elsewhere" behavior, and failure/edge-case handling.

**Out of scope (non-goals):** SMS and Conversations (already implemented and working), call waiting / holding a second concurrent call in the browser (a possible future enhancement), speaker/output-device selection via `setSinkId` (a possible future enhancement), any change to the MediaBridge media format or the ControlAPI, and any change to the Android application.

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
- **Web_Browser_Device_Name**: The literal device name string `Web Browser` used when registering a Web_Device, which the Server (`auth-routes.ts`) recognizes to trigger the `skipDeviceLimit` branch.
- **PCM_Audio**: Pulse-code-modulated audio (16-bit little-endian, 16kHz mono) negotiated via SDP between the Web_Call_Client and the MediaBridge for the two-way audio session.
- **Unload_Beacon**: A fire-and-forget request (e.g., issued on the browser `pagehide`/`unload` event) that the Web_Client attempts to send to the Web_Device deregister endpoint when the tab or browser is closing. Delivery is best-effort and is not guaranteed to complete.
- **Web_Device_Staleness_Interval**: The configurable duration a Web_Device may have no active Server_WebSocket connection and no last-seen timestamp update before the Server considers the Web_Device stale and eligible for reaping. The default is a small multiple of the 30-second WebSocket ping interval (suggested default: 90 seconds).
- **Secure_Context**: A browsing context the browser considers sufficiently secure to expose powerful WebRTC and media-capture APIs, namely a page served over HTTPS or loaded from `localhost`/`127.0.0.1`, as reflected by `window.isSecureContext`.
- **Ringtone**: The audible tone the Web_Client plays to alert the user of an inbound call while the Incoming_Call_Surface is presented and the call has not yet been answered or declined.
- **Ringback**: The audible progress tone the far party's network or the MediaBridge provides for an outbound call while the far party has not yet answered, delivered to the Web_Client during the ringing state.
- **Provider_Number_List**: The set of originating provider numbers configured on the Server and retrieved by the Web_Client via the existing number management API, used to populate the originating-number selection control in the Dialer.
- **Attention_Signal**: A non-audio alert the Web_Client raises when the browser tab is not focused or visible, such as a document title change or a browser notification, to draw the user's attention to an inbound call.
- **Call_History_API**: The existing endpoint `GET /api/calls/history` from which the Web_Client retrieves the record of completed calls across devices.

## Requirements

### Requirement 1: Browser Device Registration as a Call Target

**User Story:** As a browser user, I want my browser tab to register as a device, so that inbound calls ring in the browser and I can be reached like my phone.

#### Acceptance Criteria

1. WHEN an authenticated user loads the Web_Client and no Web_Device identifier is persisted for the current browser session, THE Web_Client SHALL register a Web_Device via the Device_Registry using the Web_Browser_Device_Name so that the Server applies the `skipDeviceLimit` flag.
2. WHEN registering the Web_Device, THE Web_Client SHALL register it with no push endpoint URL so that inbound-call notifications are delivered over the active Server_WebSocket connection rather than via push.
3. WHERE the `skipDeviceLimit` flag is applied, THE Device_Registry SHALL register the Web_Device without incrementing the active-device count and without rejecting the registration at the 5 active-device maximum.
4. WHEN an authenticated user loads the Web_Client and a Web_Device identifier is already persisted for the current browser session, THE Web_Client SHALL reuse the persisted device identifier and SHALL NOT create a duplicate Web_Device.
5. WHEN the Web_Device is registered, THE Web_Client SHALL persist the resulting device identifier in browser session storage for the duration of the browser session.
6. IF Web_Device registration does not complete within 10 seconds, THEN THE Web_Client SHALL treat registration as failed, retain the current session, display an error indicating inbound calling is unavailable, and provide a manual retry control.
7. IF Web_Device registration returns an error response, THEN THE Web_Client SHALL display an error indicating inbound calling is unavailable and SHALL provide a manual retry control.
8. WHEN the user selects the manual retry control after a failed registration, THE Web_Client SHALL re-attempt Web_Device registration using the Web_Browser_Device_Name.
9. WHEN the user logs out of the Web_Client, THE Web_Client SHALL deregister the Web_Device from the Device_Registry and clear the persisted device identifier from browser session storage.
10. WHILE no Web_Device is registered, THE Web_Client SHALL disable the Incoming_Call_Surface.
11. WHEN the Web_Client receives a browser unload or `pagehide` event (tab or browser close) while a Web_Device is registered, THE Web_Client SHALL attempt a best-effort deregistration of the Web_Device by issuing an Unload_Beacon to the Web_Device deregister endpoint, acknowledging that the Unload_Beacon MAY not complete.
12. THE Web_Client SHALL treat correctness as independent of the Unload_Beacon completing, deferring to server-side staleness reaping (see Requirement 13) as the authoritative mechanism for removing an orphaned Web_Device.
13. WHEN the Web_Client re-establishes the Server_WebSocket after a transient disconnect AND the persisted Web_Device identifier is still registered in the Device_Registry, THE Web_Client SHALL reuse the persisted Web_Device identifier and SHALL NOT create a duplicate Web_Device.
14. IF the Web_Client re-establishes the Server_WebSocket after a transient disconnect AND the persisted Web_Device identifier has been reaped or deactivated so that it is no longer active in the Device_Registry, THEN THE Web_Client SHALL register a new Web_Device using the Web_Browser_Device_Name and SHALL update the persisted device identifier to the new Web_Device identifier.

### Requirement 2: Place an Outbound Call

**User Story:** As a browser user, I want to dial a phone number and place a call, so that I can reach someone from my browser.

#### Acceptance Criteria

1. THE Dialer SHALL provide a destination phone number input accepting 1–20 characters and a control for selecting the originating provider number.
2. WHEN the user submits a destination number, THE Web_Client SHALL validate it and normalize it to an E164_Number before initiating the call.
3. IF the destination number is empty, contains disallowed characters, or cannot be normalized to E.164, THEN THE Web_Client SHALL display a validation error and SHALL NOT send the call request.
4. IF no originating provider number is selected, THEN THE Web_Client SHALL display an error and SHALL NOT send the call request.
5. WHEN the user places a validated call, THE Web_Client SHALL send `POST /api/calls/make` with the selected originating number and the normalized E164_Number.
6. WHEN the Calling_API returns a call identifier, THE Web_Client SHALL transition to establishing a two-way WebRTC PCM_Audio session for that call identifier.
7. IF `POST /api/calls/make` returns HTTP 503 or does not respond within 10 seconds, THEN THE Web_Client SHALL display a calling-service-unavailable message and return the Dialer to its idle state.
8. IF `POST /api/calls/make` returns HTTP 400, THEN THE Web_Client SHALL display the validation error returned by the Calling_API and return the Dialer to its idle state.
9. WHEN the Dialer is presented, THE Web_Client SHALL populate the originating provider-number selection control from the Provider_Number_List retrieved via the existing number management API.
10. IF no provider number is available in the Provider_Number_List, THEN THE Web_Client SHALL disable outbound calling and SHALL indicate that no calling number is configured.

### Requirement 3: Receive and Answer an Inbound Call

**User Story:** As a browser user, I want to see and answer incoming calls in the browser, so that I can take calls without my phone.

#### Acceptance Criteria

1. WHEN the Server_WebSocket delivers a `call_event` with status `connected` for a call not already displayed, THE Web_Client SHALL present the Incoming_Call_Surface within 500 ms with the caller number, or "Unknown caller" when unavailable.
2. WHEN the Web_Client establishes or re-establishes the Server_WebSocket connection, THE Web_Client SHALL fetch `GET /api/calls/active` and present the Incoming_Call_Surface for any active call for which the user has not sent an answer or decline request.
3. IF a `call_event` arrives for a call identifier already displayed, THEN THE Web_Client SHALL update the existing surface rather than create a second one.
4. WHEN the user selects Answer, THE Web_Client SHALL send `POST /api/calls/answer/:callId` for the displayed call identifier.
5. WHEN the Calling_API confirms answer with HTTP 200, THE Web_Client SHALL transition to establishing a two-way WebRTC PCM_Audio session for that call identifier.
6. IF the WebRTC session cannot be established within 15 seconds after answering, THEN THE Web_Client SHALL end the call attempt, display an error, and return to idle.
7. WHEN the user selects Decline, THE Web_Client SHALL send `POST /api/calls/decline/:callId` and dismiss the Incoming_Call_Surface.
8. IF `POST /api/calls/answer/:callId` returns HTTP 409, THEN THE Web_Client SHALL dismiss the Incoming_Call_Surface and display a call-no-longer-available message.
9. WHEN a terminal `call_event` (`completed`/`failed`/`busy`) or `call_cancelled` (`answered_elsewhere`) arrives for a displayed inbound call, THE Web_Client SHALL dismiss the Incoming_Call_Surface.

### Requirement 4: Establish the WebRTC Audio Session

**User Story:** As a browser user, I want the browser to set up two-way audio when a call connects, so that I can hear and speak to the other party.

#### Acceptance Criteria

1. WHEN a WebRTC audio session is required for a call identifier, THE Web_Call_Client SHALL request microphone access before creating the SDP_Offer.
2. IF the user denies microphone access, THEN THE Web_Call_Client SHALL abort the session, display a microphone-permission-required message, and end the associated call.
3. WHEN microphone access is granted, THE Web_Call_Client SHALL create an `RTCPeerConnection`, add the captured local audio track, and generate an SDP_Offer to enable two-way audio.
4. WHEN the SDP_Offer is generated, THE Web_Call_Client SHALL send `POST /api/calls/webrtc/offer` with the SDP_Offer and call identifier, expecting a response within 10 seconds.
5. IF the offer request fails or does not respond within 10 seconds, THEN THE Web_Call_Client SHALL set Call_Connection_State to Failed, display an error, and end the call.
6. WHEN the Calling_API returns an SDP_Answer, THE Web_Call_Client SHALL apply it as the remote description.
7. IF applying the remote description fails, THEN THE Web_Call_Client SHALL set Call_Connection_State to Failed, display an error, and end the call.
8. WHEN the remote audio track is received, THE Web_Call_Client SHALL attach it to a browser audio output element and begin playback so that received audio is rendered to the user.
9. WHEN ICE and DTLS negotiation completes successfully within 15 seconds, THE Web_Call_Client SHALL set Call_Connection_State to Connected.
10. IF ICE/DTLS negotiation fails or does not complete within 15 seconds, THEN THE Web_Call_Client SHALL set Call_Connection_State to Failed with a machine-readable reason, display an error, and end the call.
11. THE Web_Call_Client SHALL apply the ICE candidates bundled in the SDP_Answer without requiring trickle ICE exchange.
12. IF the browser autoplay policy blocks playback of the remote audio, THEN THE Web_Client SHALL surface a control, tied to a user gesture, that resumes call audio, so that inbound-call audio plays after the user's Answer gesture.
13. WHILE a two-way audio session is Connected, THE In_Call_Surface SHALL provide a volume control for the remote call audio.

### Requirement 5: Call Connection State Lifecycle

**User Story:** As a browser user, I want the call state to reflect what is actually happening, so that the UI accurately shows connecting, connected, and failed states.

#### Acceptance Criteria

1. WHEN the Web_Call_Client begins creating an SDP_Offer, THE Web_Call_Client SHALL set Call_Connection_State to Connecting.
2. WHILE Call_Connection_State is Connecting, THE In_Call_Surface SHALL display a "Connecting" status label that persists until the state becomes Connected or Failed.
3. WHEN ICE and DTLS negotiation complete, THE Web_Call_Client SHALL set Call_Connection_State to Connected.
4. IF Call_Connection_State remains Connecting for more than 30 seconds, THEN THE Web_Call_Client SHALL set it to Failed with a machine-readable reason and end the call.
5. WHEN ICE negotiation fails, THE Web_Call_Client SHALL set Call_Connection_State to Failed with a machine-readable failure reason identifying the cause and end the call.
6. WHEN the Web_Call_Client is torn down, THE Web_Call_Client SHALL set Call_Connection_State to Disconnected, stop and release the microphone audio track, and close the `RTCPeerConnection`.
7. IF the WebRTC connection is lost while Connected, THEN THE Web_Call_Client SHALL set Call_Connection_State to Failed with a machine-readable reason and end the call.
8. THE two-way audio session SHALL carry PCM_Audio negotiated via SDP.
9. WHILE an outbound call has been placed and the far party has not yet answered, THE In_Call_Surface SHALL display a "Ringing" progress state that is distinct from both the "Connecting" media-negotiation state and the "Connected" state.
10. WHERE the MediaBridge provides Ringback audio for the outbound call, THE Web_Client SHALL play the received Ringback audio to the user during the Ringing progress state.

### Requirement 6: In-Call Mute Control

**User Story:** As a browser user, I want to mute and unmute my microphone during a call, so that I can control what the other party hears.

#### Acceptance Criteria

1. WHILE Connected, THE In_Call_Surface SHALL display a mute control operable via pointer and keyboard.
2. WHEN the user activates the mute control while unmuted, THE Web_Call_Client SHALL set the local audio MediaStreamTrack.enabled to false within 200 ms.
3. WHEN the user activates the mute control while muted, THE Web_Call_Client SHALL set the local audio MediaStreamTrack.enabled to true within 200 ms.
4. WHEN the local audio track transitions to disabled, THE In_Call_Surface SHALL display a muted-state indicator within 200 ms.
5. WHEN the local audio track transitions to enabled, THE In_Call_Surface SHALL display an unmuted-state indicator within 200 ms.
6. WHILE Connected, THE Web_Call_Client SHALL preserve the current mute state across the active PCM_Audio WebRTC session until the user next activates the mute control.
7. IF the local audio MediaStreamTrack is unavailable or ended when the user activates mute, THEN THE Web_Call_Client SHALL retain the last known mute state, make no change, and display an indicator that the action could not be applied.

### Requirement 7: In-Call DTMF Keypad

**User Story:** As a browser user, I want a keypad to send touch tones during a call, so that I can navigate phone menus.

#### Acceptance Criteria

1. WHILE Connected, THE In_Call_Surface SHALL provide a DTMF keypad with exactly twelve selectable controls for the digits 0-9, `*`, and `#`.
2. WHILE NOT Connected, THE DTMF keypad controls SHALL be non-interactive.
3. WHEN the user presses a DTMF_Digit AND an RTCDTMFSender is available on the local audio track, THE Web_Call_Client SHALL send the DTMF_Digit in-band via the RTCDTMFSender within 200 ms.
4. IF no RTCDTMFSender is available on the local audio track, THEN THE Web_Call_Client SHALL send the DTMF_Digit via `POST /api/calls/:callId/dtmf` as a fallback.
5. IF the fallback DTMF request returns a non-success response or does not respond within 5 seconds, THEN THE Web_Call_Client SHALL preserve the Connected state and display a DTMF-not-delivered indication.
6. IF the user submits a character that is not a DTMF_Digit, THEN THE Web_Call_Client SHALL reject the input, preserve state, and send no DTMF signal on either path.

### Requirement 8: Call Duration and Hang Up

**User Story:** As a browser user, I want to see how long the call has lasted and be able to hang up, so that I can manage the call.

#### Acceptance Criteria

1. WHEN Call_Connection_State becomes Connected, THE In_Call_Surface SHALL start a call duration timer initialized to zero seconds.
2. WHILE Connected, THE In_Call_Surface SHALL display elapsed duration as mm:ss (extending to hh:mm:ss at/beyond 60 minutes), updating at least once per second.
3. WHEN the user selects hang up, THE Web_Call_Client SHALL send `POST /api/calls/decline/:callId` for the active call identifier and tear down the two-way WebRTC PCM_Audio session.
4. IF the hang-up request fails or does not respond within 5 seconds, THEN THE Web_Call_Client SHALL still tear down the session, return to idle, and surface an indication that the call was ended locally.
5. WHEN a call ends for any reason, THE In_Call_Surface SHALL stop the timer, clear the displayed duration, and return the Web_Client to its idle state with call controls reset.

### Requirement 9: Remote Hangup and Call Termination Signaling

**User Story:** As a browser user, I want the call to end in my browser when the other party hangs up, so that I am not left in a dead call.

#### Acceptance Criteria

1. WHEN the Server_WebSocket delivers a `call_event` with status `completed`, `failed`, or `busy` for the active call identifier, THE Web_Client SHALL tear down the two-way WebRTC PCM_Audio session, release the microphone capture stream, and return to idle within 2 seconds.
2. WHEN tearing down in response to such a `call_event`, THE Web_Client SHALL display a call-ended indication identifying the termination cause.
3. IF an event's call identifier does not match the active or any displayed inbound call identifier, THEN THE Web_Client SHALL ignore it and leave state unchanged.
4. IF a duplicate `call_event` arrives for an already-torn-down call, THEN THE Web_Client SHALL ignore it and remain idle.
5. WHEN a `call_cancelled` event with reason `answered_elsewhere` arrives for a displayed inbound call, THE Web_Client SHALL dismiss the Incoming_Call_Surface within 2 seconds.
6. WHILE Connected, THE Media_Inactivity_Watchdog SHALL evaluate inbound media reception at intervals not exceeding 1 second, treating reception as inactive when no inbound audio media packets arrive for a continuous 5 seconds.
7. IF the Media_Inactivity_Watchdog reports inactive for a continuous 5 seconds while Connected and no termination signal has been received, THEN THE Web_Client SHALL tear down the session, release the microphone, return to idle within 2 seconds, and display a call-ended indication citing loss of media.
8. WHEN a Web_Client browser closes abruptly during an active call such that the WebRTC peer connection drops and the MediaBridge emits a `client_disconnected` event, THE Server SHALL end the call and release the provider or far-party leg so that the far party is not left in a dead call.

### Requirement 10: Multi-Device and Multi-Tab Behavior

**User Story:** As a user with a phone and multiple browser tabs, I want only one endpoint to hold each call, so that answering in one place clears the ringing everywhere else.

#### Acceptance Criteria

1. WHEN the Server_WebSocket delivers a `call_cancelled` event with reason `answered_elsewhere` for a displayed inbound call identifier, THE Web_Client SHALL dismiss the Incoming_Call_Surface within 1 second and return to idle.
2. WHILE a call identifier is held on another endpoint (an `answered_elsewhere` cancellation received and no subsequent terminal `call_event`), THE Web_Client SHALL NOT display the Incoming_Call_Surface for that call identifier.
3. WHERE two or more Web_Client tabs are open under the same authenticated user session, each tab SHALL maintain its own Server_WebSocket connection and independently receive call signaling.
4. WHEN a call identifier is answered from one endpoint, THE Server_WebSocket SHALL deliver `call_cancelled`/`answered_elsewhere` to every connected endpoint except the answering endpoint, and each receiving Web_Client SHALL dismiss the Incoming_Call_Surface within 1 second.
5. WHEN a call is answered in one tab on the same device as sibling tabs (which are excluded from the cancellation), THE sibling tabs SHALL reconcile against `GET /api/calls/active` on their next reconnect/reconciliation and dismiss the Incoming_Call_Surface for any call identifier not returned as active.

### Requirement 11: Calling Service and Signaling Failure Handling

**User Story:** As a browser user, I want clear behavior when the calling service or signaling fails, so that I understand why a call could not be established.

#### Acceptance Criteria

1. IF `POST /api/calls/webrtc/offer` returns HTTP 503, THEN THE Web_Client SHALL display a media-service-unavailable message within 1 second, end the call attempt, and return to idle.
2. IF `POST /api/calls/webrtc/offer` returns HTTP 504, THEN THE Web_Client SHALL display a signaling-timed-out message within 1 second, end the call attempt, and return to idle.
3. IF the offer request does not receive a response within the server's 5-second signaling timeout, THEN THE Web_Client SHALL treat it as a signaling failure, end the call attempt, and return to idle.
4. IF `POST /api/calls/webrtc/offer` returns HTTP 404, THEN THE Web_Client SHALL display a call-not-found message within 1 second and return to idle.
5. IF the Server_WebSocket connection is lost while the two-way WebRTC PCM_Audio session is Connected, THEN THE Web_Client SHALL continue playing established call audio and display a signaling-disconnected indication.
6. IF the Server_WebSocket connection is lost while a call is not Connected, THEN THE Web_Client SHALL terminate the call attempt and return to idle.
7. WHEN the Server_WebSocket reconnects, THE Web_Client SHALL reconcile displayed call state against `GET /api/calls/active` within 2 seconds; IF no matching active call is returned, THEN THE Web_Client SHALL end the displayed call state and return to idle.

### Requirement 12: ICE and TURN Reachability

**User Story:** As a browser user on a real-world network, I want NAT traversal to work, so that call audio connects even when I am behind a firewall or carrier-grade NAT.

#### Acceptance Criteria

1. WHEN initializing the `RTCPeerConnection`, THE Web_Call_Client SHALL configure an ICE_Server set including at least one STUN server plus any configured TURN server.
2. WHERE direct connectivity cannot be established (no host/server-reflexive/peer-reflexive candidate pair reaches the connected ICE state), THE Web_Call_Client SHALL use the configured TURN relay candidate pair.
3. WHEN `iceConnectionState` reaches `connected` or `completed` against the ICE Lite MediaBridge, THE Web_Call_Client SHALL set Call_Connection_State to Connected.
4. IF ICE connectivity is not established within 20 seconds of the start of ICE gathering, THEN THE Web_Call_Client SHALL set Call_Connection_State to Failed with a machine-readable reason (ICE negotiation timeout), display an error, release resources, and end the call attempt.

### Requirement 13: Server-Side Stale Web Device Reaping

**User Story:** As an operator, I want orphaned browser devices cleaned up automatically, so that the device registry stays accurate when browsers close without logging out.

This requirement covers server-side registration cleanup for web-registered devices and is authoritative over the best-effort Unload_Beacon described in Requirement 1.

#### Acceptance Criteria

1. THE Server SHALL update a Web_Device's last-seen timestamp while it maintains an active Server_WebSocket connection for that Web_Device.
2. THE Server SHALL consider a Web_Device stale when the Web_Device has had no active Server_WebSocket connection AND its last-seen timestamp has not been updated for at least the Web_Device_Staleness_Interval.
3. WHEN a Web_Device is stale, THE Server SHALL deactivate the Web_Device in the Device_Registry so that the Web_Device is no longer notified of inbound calls.
4. THE Server SHALL apply reaping only to web-registered devices (devices registered with the Web_Browser_Device_Name or the `skipDeviceLimit` flag) and SHALL NOT reap Android devices that rely on push notifications.
5. WHILE a Web_Device has been reaped, THE Server SHALL NOT route inbound-call notifications to the reaped Web_Device.
6. WHEN the Server reaps a stale Web_Device, THE Server SHALL leave every other active device unaffected and SHALL NOT disrupt any in-progress call on another endpoint.
7. WHERE a Web_Device that would otherwise be considered stale is currently associated with an active call, THE Server SHALL NOT reap that Web_Device until the call has ended.


### Requirement 14: Single Active Call and Concurrency

**User Story:** As a browser user, I want the browser to handle only one call at a time cleanly, so that a second inbound or outbound call never disrupts my current call or leaves the UI in an ambiguous state.

#### Acceptance Criteria

1. WHILE the Web_Client has an active call (Call_Connection_State is Connecting or Connected), IF an inbound `call_event` with status `connected` arrives for a different call identifier, THEN THE Web_Client SHALL NOT present a second In_Call_Surface and SHALL automatically decline the new call via `POST /api/calls/decline/:callId`.
2. WHILE the Web_Client has an active call, THE Dialer SHALL be disabled or SHALL reject attempts to place a new outbound call, and SHALL surface that a call is already in progress.
3. THE Web_Client SHALL maintain at most one active WebRTC PCM_Audio session per browser tab at any time.

> Note: Call waiting (presenting a non-intrusive call-waiting indication and allowing the user to accept a second concurrent call) is a non-goal for v1. Auto-decline of the second call is the default behavior for v1. Call waiting is noted as a possible future enhancement.

### Requirement 15: Browser Capability and Secure Context Preconditions

**User Story:** As a browser user, I want the app to tell me clearly when my browser or connection cannot support calling, so that I am not left with silent failures.

#### Acceptance Criteria

1. WHEN the Web_Client loads, THE Web_Client SHALL detect whether the page is running in a Secure_Context and whether the browser supports the required WebRTC APIs (`RTCPeerConnection` and `getUserMedia`).
2. IF the Web_Client is not in a Secure_Context, THEN THE Web_Client SHALL disable calling features and display a message indicating that calling requires a secure (HTTPS) connection.
3. IF the browser does not support the required WebRTC APIs, THEN THE Web_Client SHALL disable calling features and display an unsupported-browser message.
4. IF no microphone input device is available when a call requires audio capture, THEN THE Web_Call_Client SHALL abort the session and display a no-microphone-available message.
5. IF microphone permission is in a persistently denied state (previously blocked), THEN THE Web_Client SHALL display guidance on how to re-enable microphone access rather than silently failing.

### Requirement 16: Inbound Call Alerting

**User Story:** As a browser user, I want an audible and visible alert when a call comes in, so that I notice inbound calls even when I am not looking at the tab.

#### Acceptance Criteria

1. WHILE the Incoming_Call_Surface is presented AND the call has not been answered or declined, THE Web_Client SHALL play an audible Ringtone, subject to browser autoplay constraints.
2. WHEN the inbound call is answered, declined, cancelled, or otherwise dismissed, THE Web_Client SHALL stop the Ringtone.
3. WHERE the browser tab is not focused or visible, THE Web_Client SHALL raise an Attention_Signal, such as a document title change and/or a browser notification where permitted.

> Note: Browser autoplay policy may suppress the Ringtone until a user gesture occurs; the visual Incoming_Call_Surface remains the primary guaranteed alert.

### Requirement 17: Call History Integration

**User Story:** As a browser user, I want my browser calls to show up in call history and to be able to call back from it, so that the browser behaves consistently with my other devices.

#### Acceptance Criteria

1. WHEN a call placed or received in the Web_Client completes, THE completed call SHALL appear in the call history retrieved via the Call_History_API (`GET /api/calls/history`) consistently with calls placed or received on other devices.
2. THE Web_Client SHALL allow initiating an outbound call to a number selected from call history ("call back").

### Requirement 18: Accessibility of Call Surfaces

**User Story:** As a browser user who relies on assistive technology or keyboard navigation, I want the call surfaces to be fully accessible, so that I can receive, answer, and manage calls without a pointer.

#### Acceptance Criteria

1. WHEN the Incoming_Call_Surface is presented, THE Web_Client SHALL announce the incoming call to assistive technologies via an ARIA live region and SHALL move keyboard focus to the Answer/Decline actions.
2. THE In_Call_Surface and Incoming_Call_Surface controls SHALL be fully operable via keyboard and SHALL expose accessible names and roles.
3. WHEN Call_Connection_State changes (Connecting, Connected, Failed, or ended), THE Web_Client SHALL announce the change to assistive technologies.

## Correctness Properties

The following invariants describe properties that SHALL hold across all valid executions of the Web_Call_Client state machine and the server-side reaper. They are phrased as invariants to support automated verification. These properties SHOULD be validated via property-based tests where practical. The primary new code under test is the browser Web_Call_Client state machine and the server-side stale Web_Device reaper.

- **Single-call invariant:** THE Web_Client SHALL always maintain at most one active WebRTC PCM_Audio session per browser tab at any time.
- **Connected-implies-resources invariant:** THE Web_Call_Client SHALL always ensure that whenever Call_Connection_State is Connected, a live `RTCPeerConnection` and a live local microphone audio track both exist.
- **Resource-safety invariant:** THE Web_Call_Client SHALL always, after a call ends via any path (local hang up, remote hangup, failure, decline, Media_Inactivity_Watchdog teardown, or browser close), stop the local microphone track and close the `RTCPeerConnection`, leaking no microphone capture.
- **Idempotent-teardown invariant:** THE Web_Client SHALL always ensure that duplicate or out-of-order terminal `call_event` or `call_cancelled` messages never create duplicate surfaces and never trigger double-teardown side effects.
- **Registration-uniqueness invariant:** THE Web_Client SHALL always maintain at most one active Web_Device per browser session, such that reconnecting never creates a duplicate Web_Device.
- **Reaper-safety invariant:** THE Server SHALL always ensure that reaping a stale Web_Device never disrupts an active call on another endpoint.
