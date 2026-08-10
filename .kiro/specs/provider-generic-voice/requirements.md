# Requirements: Provider-Generic Voice Architecture

## Introduction

This document specifies the requirements for refactoring the Svarla softphone system to a provider-generic architecture where all voice audio is relayed through the server. The current architecture tightly couples the Android client to the Vonage Client SDK for WebRTC media transport. The new architecture removes all provider-specific code from the Android client and introduces a server-side media bridge (Pion sidecar) that handles audio relay between the client and any telephony provider.

This enables:
- A single, unified client-to-server interface for all providers (Vonage, 46elks, future providers)
- Simplified future client development (iOS, desktop, web) with no provider SDK dependencies
- Server-side real-time audio processing capabilities (recording, live translation, transcription)
- Support for multiple simultaneously configured providers on the server

## Glossary

- **Server**: The TypeScript/Fastify backend application that coordinates telephony operations, signaling, and call state management
- **MediaBridge**: The Pion-based Go sidecar process that terminates WebRTC connections from clients and bridges audio to/from telephony providers via SIP or provider-specific audio APIs
- **Android_Client**: The Android application built with Kotlin/Compose that provides the user interface and connects to the Server via WebRTC for audio
- **TelephonyProvider**: The existing server-side interface (`TelephonyProvider`) abstracting provider-specific call/SMS operations
- **ProviderRegistry**: The server-side service managing multiple configured telephony providers and their phone number assignments
- **WebRTC_Session**: A peer connection between the Android_Client and the MediaBridge carrying Opus-encoded audio over DTLS/SRTP
- **SDP**: Session Description Protocol — used for WebRTC offer/answer negotiation between client and MediaBridge
- **ICE_Candidate**: Interactive Connectivity Establishment candidate — network endpoint information exchanged during WebRTC connection setup
- **Opus**: A lossy audio codec optimized for interactive speech, used for client-to-server audio transport
- **SIP**: Session Initiation Protocol — used by the MediaBridge to connect to telephony providers that support SIP trunking
- **PSTN**: Public Switched Telephone Network — the traditional phone network that end users call to/from
- **Pion**: A pure Go implementation of WebRTC used to build the MediaBridge sidecar
- **ControlAPI**: The internal REST/gRPC API exposed by the MediaBridge for the Server to manage audio sessions
- **SignalingAPI**: The Server endpoints used by the Android_Client to exchange SDP offers/answers and ICE candidates for WebRTC negotiation

## Architecture Overview

```
Android_Client ──WebRTC/Opus/TCP──→ MediaBridge (Pion) ──SIP/Audio API──→ Provider (Vonage/46elks/...)
                                         ↑
                                    ControlAPI
                                         ↑
                                      Server (Node.js/Fastify)
```

- The Android_Client connects to the MediaBridge via WebRTC for audio
- The Server orchestrates calls via the existing TelephonyProvider interface and controls the MediaBridge via its ControlAPI
- The MediaBridge bridges audio between the WebRTC session and the provider's audio channel
- Call signaling (start, answer, decline, hangup, events) continues via the existing WebSocket + REST API between the Android_Client and the Server

## Requirements

### Requirement 1: Provider-Agnostic Android Client

**User Story:** As a developer, I want the Android client to contain zero provider-specific code (no Vonage SDK, no 46elks SDK), so that adding or changing providers requires only server-side work.

#### Acceptance Criteria

1. THE Android_Client SHALL NOT include any telephony provider SDK as a dependency (no Vonage Client SDK, no 46elks SDK, no SIP library)
2. THE Android_Client SHALL connect to the MediaBridge via a standard WebRTC peer connection for all voice audio, regardless of which telephony provider handles the PSTN leg
3. THE Android_Client SHALL use a single, unified set of REST API endpoints and WebSocket events for call signaling (make, answer, decline, hangup, call events) that are identical regardless of which provider is active
4. THE Android_Client SHALL NOT contain any logic that branches or behaves differently based on the telephony provider type
5. WHEN a new telephony provider is added to the server, THE Android_Client SHALL require zero code changes to support calls through that provider

### Requirement 2: WebRTC Audio Transport (Client to Server)

**User Story:** As a user, I want high-quality, low-latency voice audio between my phone and the server using WebRTC with Opus, so that calls sound natural without echo or jitter issues.

#### Acceptance Criteria

1. THE Android_Client SHALL establish a WebRTC peer connection to the MediaBridge using the Opus codec for audio encoding
2. THE WebRTC connection SHALL use TCP as the primary ICE transport to ensure reliable connectivity through firewalls and VPNs
3. THE MediaBridge SHALL listen on a single, fixed TCP port (configurable, defaulting to 8443) for all WebRTC connections — no dynamic port allocation
4. THE MediaBridge SHALL advertise its public IP address and fixed port as the sole ICE candidate — no STUN or TURN infrastructure SHALL be required
5. THE Android_Client SHALL handle WebRTC echo cancellation, jitter buffering, and noise suppression via the standard WebRTC audio pipeline (no custom DSP implementation)
6. THE Opus encoder SHALL be configured for voice optimization (application=voip) with a maximum bitrate of 32kbps to minimize bandwidth usage
7. THE WebRTC connection SHALL support DTLS-SRTP for encrypted audio transport between the Android_Client and the MediaBridge
8. IF the WebRTC connection between the Android_Client and MediaBridge is lost during an active call, THE Android_Client SHALL notify the user of connectivity loss and transition the call to ENDED with reason CONNECTIVITY_LOST

### Requirement 3: WebRTC Signaling

**User Story:** As a client, I want to negotiate a WebRTC connection with the server using standard SDP offer/answer exchange, so that audio sessions are established reliably.

#### Acceptance Criteria

1. THE Server SHALL expose a signaling endpoint (POST /api/calls/webrtc/offer) that accepts an SDP offer from the Android_Client and returns an SDP answer from the MediaBridge
2. THE Server SHALL relay ICE candidates between the Android_Client and the MediaBridge via WebSocket messages (type: "ice_candidate")
3. THE signaling endpoint SHALL authenticate requests using the existing session middleware — unauthenticated requests SHALL be rejected with HTTP 401
4. THE signaling flow SHALL complete (offer sent, answer received, ICE candidates exchanged, DTLS handshake finished) within 5 seconds under normal network conditions
5. THE Server SHALL associate each WebRTC session with the active call for the authenticated device, so that audio is routed to the correct call
6. IF the MediaBridge is unreachable when a signaling request is received, THE Server SHALL return HTTP 503 with an error message indicating the media service is unavailable

### Requirement 4: Media Bridge (Pion Sidecar)

**User Story:** As a system operator, I want a lightweight, replaceable media bridge component that handles audio relay between clients and telephony providers, so that the system can evolve without major architectural changes.

#### Acceptance Criteria

1. THE MediaBridge SHALL be implemented as a separate process (Go binary using the Pion WebRTC library) that communicates with the Server via a ControlAPI
2. THE MediaBridge ControlAPI SHALL support the following operations: create session, destroy session, connect provider audio (SIP URI or audio stream endpoint), get session status
3. THE Server SHALL control the MediaBridge exclusively through the ControlAPI — the MediaBridge SHALL NOT directly access the database, telephony provider APIs, or client-facing endpoints
4. THE MediaBridge SHALL support bridging audio between exactly one WebRTC peer connection and one provider audio channel per session (1:1 bridge, not a mixer)
5. THE MediaBridge SHALL support receiving provider audio via SIP (for providers like Vonage and 46elks that expose SIP endpoints) and via WebSocket audio streams (for providers that stream raw audio)
6. THE MediaBridge SHALL expose a health check endpoint that the Server can poll to verify the sidecar is operational
7. THE ControlAPI SHALL be a REST API over HTTP on a localhost-only port (not exposed externally), using JSON request/response bodies
8. THE MediaBridge SHALL be stateless from a persistence perspective — all session state is ephemeral and lost on restart; the Server is responsible for detecting this and re-establishing sessions if needed
9. THE MediaBridge SHALL handle Opus decoding/encoding and any necessary transcoding between the WebRTC audio format and the provider audio format (e.g., Opus ↔ G.711 for SIP)
10. IF the MediaBridge process crashes or becomes unresponsive, THE Server SHALL detect the failure (via health check or connection loss) and transition all active calls to ENDED with reason FAILED

### Requirement 5: Server Call Orchestration

**User Story:** As the server, I want to orchestrate the full call lifecycle by coordinating between the client, media bridge, and telephony provider, so that calls work seamlessly regardless of which provider is active.

#### Acceptance Criteria

1. WHEN the Android_Client initiates an outbound call (POST /api/calls/make), THE Server SHALL: (a) create a MediaBridge session via the ControlAPI, (b) initiate the provider-side call via the TelephonyProvider interface, (c) instruct the MediaBridge to connect to the provider's audio channel, and (d) return signaling information to the client for WebRTC connection
2. WHEN an inbound call arrives via a TelephonyProvider webhook, THE Server SHALL: (a) create a MediaBridge session via the ControlAPI, (b) notify all registered devices via push notification and WebSocket, and (c) when a device answers, complete the WebRTC signaling and instruct the MediaBridge to bridge the audio
3. WHEN a call ends (from any party: client hangup, remote hangup, provider disconnect), THE Server SHALL: (a) destroy the MediaBridge session via the ControlAPI, (b) notify the client via WebSocket call event, and (c) update call history
4. THE Server SHALL use the existing ProviderRegistry to determine which TelephonyProvider handles each call based on the phone number assignment
5. THE Server SHALL NOT send any provider-specific information to the Android_Client in call signaling responses — all responses SHALL use generic field names (e.g., "providerNumber" not "vonageNumber")
6. THE existing TelephonyProvider interface (makeCall, endCall, answerCall, sendSms, listNumbers, handleWebhook) SHALL remain unchanged — provider implementations are unaffected by this refactoring

### Requirement 6: Unified Client-Server Signaling Interface

**User Story:** As a client developer, I want a single set of call signaling endpoints and WebSocket events that work identically for all providers, so that clients are simple and future-proof.

#### Acceptance Criteria

1. THE call signaling REST endpoints SHALL be: POST /api/calls/make (initiate outbound), POST /api/calls/answer/:callId (answer inbound), POST /api/calls/decline/:callId (decline inbound), POST /api/calls/webrtc/offer (SDP exchange), and GET /api/calls/active (get active calls)
2. THE WebSocket call event types SHALL be: "call_event" (with status: ringing/connected/disconnected/completed/busy/failed), "call_cancelled" (with reason: answered_elsewhere/declined/caller_disconnect/timeout), and "ice_candidate" (for ICE candidate relay)
3. THE POST /api/calls/make response SHALL contain: callId (string), from (string, E.164), to (string, E.164) — no provider-specific fields
4. THE POST /api/calls/webrtc/offer request SHALL contain: sdpOffer (string), callId (string). The response SHALL contain: sdpAnswer (string)
5. THE WebSocket "call_event" with status "ringing" SHALL contain: callId (string), from (string, caller number), providerNumber (string, the user's number that was called), providerNumberLabel (string|null, user-assigned label)
6. ALL field names in API responses and WebSocket events SHALL use provider-generic terminology — no references to "vonage", "elks", or any specific provider name
7. THE POST /api/calls/token endpoint SHALL be removed — token-based authentication to provider SDKs is no longer needed since the client connects only to the MediaBridge

### Requirement 7: 46elks Provider Integration (Server-Side)

**User Story:** As a server operator, I want to configure 46elks as a telephony provider alongside Vonage, so that I can use Swedish phone numbers with competitive pricing.

#### Acceptance Criteria

1. THE Server SHALL support a provider type "46elks" in the ProviderRegistry that implements the TelephonyProvider interface
2. THE 46elks provider SHALL support outbound calls via the 46elks Calls API (POST https://api.46elks.com/a1/calls) with from, to, and voice_start parameters
3. THE 46elks provider SHALL support inbound calls by handling webhooks configured on the 46elks number (voice_start URL pointing to the Server's webhook endpoint)
4. THE 46elks provider SHALL support outbound SMS via the 46elks SMS API (POST https://api.46elks.com/a1/sms) with from, to, and message parameters
5. THE 46elks provider SHALL support inbound SMS by handling the sms_url webhook configured on the 46elks number
6. THE 46elks provider SHALL authenticate to the 46elks API using HTTP Basic Authentication with the configured API username and API password
7. THE 46elks provider SHALL connect call audio to the MediaBridge via SIP URI (46elks supports connecting calls to SIP endpoints via the "connect" voice_start action)
8. THE 46elks provider SHALL list available numbers via the 46elks Numbers API (GET https://api.46elks.com/a1/numbers) and map capabilities (voice, sms) to the ProviderNumber format
9. THE 46elks provider configuration SHALL require: apiUsername, apiPassword, and webhookBaseUrl
10. THE 46elks provider SHALL handle the following webhook events: voice_start (incoming call), call status updates (ongoing/success/failed), and incoming SMS

### Requirement 8: Multiple Provider Support

**User Story:** As a server operator, I want to configure multiple telephony providers simultaneously (e.g., Vonage for international numbers and 46elks for Swedish numbers), so that I can use the best provider for each number.

#### Acceptance Criteria

1. THE ProviderRegistry SHALL continue to support multiple providers configured simultaneously, each with their own set of assigned phone numbers
2. WHEN a call is made from a specific phone number, THE Server SHALL route it through the provider that owns that number (as determined by the ProviderRegistry)
3. WHEN an inbound call arrives on a provider's webhook, THE Server SHALL handle it through that provider's TelephonyProvider implementation and present it to the client using the unified signaling interface
4. THE Android_Client SHALL display all phone numbers from all configured providers in a single unified list — the user does not need to know or select which provider backs a specific number
5. THE Server SHALL create a separate MediaBridge session for each active call, with the provider-specific audio connection configured according to the owning provider's capabilities (SIP URI format, audio stream endpoint, etc.)

### Requirement 9: Audio Tap for Future Processing

**User Story:** As a developer, I want the MediaBridge to support tapping the audio stream for future real-time processing (recording, transcription, translation), so that these features can be added without architectural changes.

#### Acceptance Criteria

1. THE MediaBridge ControlAPI SHALL support an optional "audio tap" parameter when creating a session, which when enabled streams raw PCM audio (both directions) to a configured endpoint (WebSocket or Unix socket)
2. THE audio tap SHALL provide bidirectional audio streams (client-to-provider and provider-to-client) as separate labeled channels
3. THE audio tap SHALL deliver audio as 16kHz 16-bit PCM frames (suitable for speech processing APIs) regardless of the codec used on the WebRTC or SIP leg
4. THE audio tap SHALL NOT introduce perceptible latency or quality degradation to the main call audio path
5. THE audio tap feature SHALL be disabled by default and activated only when explicitly requested via the ControlAPI — no audio data SHALL leave the MediaBridge when the tap is not active
6. THE audio tap endpoint format SHALL be documented as part of the ControlAPI specification so that future processing services can connect to it

### Requirement 10: Vonage Provider Adaptation

**User Story:** As a system with existing Vonage integration, I want Vonage to continue working through the new server-relayed architecture without breaking existing functionality.

#### Acceptance Criteria

1. THE existing VonageTelephonyProvider SHALL be adapted to connect call audio through the MediaBridge instead of directly to the Vonage Client SDK on the device
2. FOR outbound calls via Vonage, THE Server SHALL instruct Vonage to connect the PSTN leg to a SIP endpoint on the MediaBridge (using NCCO connect action with type "sip")
3. FOR inbound calls via Vonage, THE Server SHALL respond to the answer webhook with an NCCO that connects the caller to a SIP endpoint on the MediaBridge
4. THE VonageProviderUserManager and Client SDK token generation (POST /api/calls/token) SHALL be removed since the client no longer connects directly to Vonage
5. THE existing Vonage webhooks (answer, event, inbound-sms, sms-status) SHALL continue to function for call control and SMS — only the audio path changes
6. ALL existing call features (outbound, inbound, call history, call events, push notifications) SHALL continue to function identically from the user's perspective after the migration

### Requirement 11: Deployment and Configuration

**User Story:** As a system operator, I want the media bridge to be simple to deploy alongside the existing server, with minimal configuration and infrastructure requirements.

#### Acceptance Criteria

1. THE MediaBridge SHALL be packaged as a single static Go binary that can run as a sidecar process alongside the Node.js server (in the same Docker container or as a separate service)
2. THE MediaBridge configuration SHALL require at minimum: listen port (TCP, default 8443), ControlAPI port (HTTP, localhost-only, default 9090), public IP address (for ICE candidate advertisement), and SIP listen port (for provider audio, default 5060)
3. THE Server configuration SHALL include the MediaBridge ControlAPI URL (default: http://localhost:9090) to communicate with the sidecar
4. THE existing Dockerfile SHALL be extended (or a docker-compose configuration added) to include the MediaBridge binary alongside the Node.js server
5. THE MediaBridge SHALL log structured JSON output to stdout for operational monitoring, including session lifecycle events and error conditions
6. THE MediaBridge SHALL gracefully shut down when receiving SIGTERM — completing any in-progress DTLS handshakes and sending BYE on active SIP sessions before exiting within 5 seconds

### Requirement 12: Backward Compatibility and Migration

**User Story:** As an existing user, I want the transition to the new architecture to be seamless — existing features must continue working and the migration path must be clear.

#### Acceptance Criteria

1. ALL existing call features SHALL continue to function after migration: outbound calls, inbound calls, call history, missed call notifications, call answered-elsewhere notifications, DTMF, mute, speaker routing
2. ALL existing SMS features SHALL be unaffected by this change — SMS continues to flow through the TelephonyProvider interface without involving the MediaBridge
3. THE Android_Client SHALL remove the Vonage Client SDK dependency and replace the VonageClientManager, VonageModule, and VonageCall classes with a provider-agnostic WebRTC client implementation
4. THE Server SHALL remove the ProviderUserManager service and the POST /api/calls/token endpoint, as provider-specific client authentication is no longer needed
5. THE WebSocket event field "vonageNumber" SHALL be renamed to "providerNumber" and "vonageNumberLabel" SHALL be renamed to "providerNumberLabel" in all server-to-client messages
6. THE ActiveCallDto field "vonageNumber" SHALL be renamed to "providerNumber" in the GET /api/calls/active response
7. THE Android_Client SHALL update all DTO parsing to use the new generic field names while maintaining backward compatibility during a transition period (accepting both old and new field names)
