# Implementation Plan: Provider-Generic Voice Architecture

## Overview

Refactor Svarla to a provider-generic voice architecture with server-relayed audio. The MediaBridge (Go/Pion sidecar) terminates WebRTC from clients and bridges audio to telephony providers via SIP or WebSocket. The Server (TypeScript/Fastify) orchestrates calls through the existing TelephonyProvider interface. The Android client drops all provider SDKs and connects only via standard WebRTC.

Work is organized into 7 phases: MediaBridge core (Phase 1), MediaBridge SIP/Audio (Phase 2), Server orchestration (Phase 3), Vonage adaptation (Phase 4), 46elks provider (Phase 5), Android client refactor (Phase 6), and Cleanup/Integration (Phase 7).

## Tasks

- [x] 1. MediaBridge Project Setup and Core
  - [x] 1.1 Create Go module and project structure
    - Create `mediabridge/` directory with `go mod init`, add Pion WebRTC v4 dependency, add HTTP router (stdlib net/http), create `cmd/mediabridge/main.go` entry point with config loading from `mediabridge-config.yaml`, configure structured JSON logging to stdout, implement SIGTERM graceful shutdown (complete in-progress DTLS handshakes, send BYE on active SIP sessions, exit within 5 seconds)
    - _Requirements: 4.1, 11.1, 11.2, 11.5, 11.6_

  - [x] 1.2 Implement ControlAPI session management endpoints
    - Implement POST /sessions (create session, allocate resources, accept optional audioTap config, return sessionId + sipUri + audioWsUrl), DELETE /sessions/:sessionId (tear down, free resources), GET /sessions/:sessionId (status, clientConnected, providerConnected, durationSeconds, codec), PATCH /sessions/:sessionId (update providerLeg type/uri, toggle ringback), GET /health (status, activeSessions, uptime). ControlAPI binds to localhost only (127.0.0.1) on configurable port (default 9090), JSON request/response bodies
    - _Requirements: 4.2, 4.3, 4.6, 4.7, 4.8_

  - [x] 1.3 Implement WebRTC endpoint with Pion
    - Configure Pion with ICE Lite (advertise known public IP + fixed TCP port, no STUN/TURN), listen on fixed TCP port (configurable, default 8443), implement POST /sessions/:sessionId/offer (accept SDP offer, generate SDP answer, return ICE candidates), configure Opus as only audio codec (application=voip, max bitrate 32kbps, no video), handle DTLS-SRTP negotiation for encrypted audio transport, detect client connect/disconnect and emit events, handle ICE connection state changes, implement session state machine (CREATED → WAITING_CLIENT → CLIENT_CONNECTED → BRIDGING → ACTIVE → CLOSING → DESTROYED)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 2.7, 4.4_

  - [x] 1.4 Implement ringback tone generation
    - Implement EU ringback (425Hz, 1s on / 4s off) and US ringback (440+480Hz, 2s on / 4s off) generators, mix into client receive audio when options.ringback = true, auto-stop when provider leg connects (SIP 200 OK or first audio frame on WS) or disabled via PATCH, cadence configurable per session (defaults to EU pattern)
    - _Requirements: 4.4_

  - [x] 1.5 Implement event WebSocket (MediaBridge → Server)
    - Implement WebSocket client connecting to Server's internal endpoint on startup (ws://localhost:PORT/internal/media-events), emit session events: client_connected, client_disconnected (with reason e.g. ice_failed), provider_connected, provider_disconnected (with reason e.g. bye), emit DTMF events received from provider leg, emit periodic health events (activeSessions, uptime), implement reconnection logic with configurable interval (default 3000ms)
    - _Requirements: 4.2, 4.10_

- [x] 2. MediaBridge SIP + Audio WebSocket
  - [x] 2.1 Implement SIP UAS (User Agent Server)
    - Implement SIP listener on port 5060 (UDP + TCP, configurable), accept SIP INVITE matching session ID in Request-URI, negotiate SDP for audio (G.711 µ-law primary, Opus if supported), send SIP 200 OK on successful negotiation, handle SIP BYE from provider (emit provider_disconnected), send SIP BYE when session destroyed, handle SIP re-INVITE for codec renegotiation, support SIP digest authentication or IP allowlisting for security
    - _Requirements: 4.5, 4.9, 11.2_

  - [x] 2.2 Implement audio bridge pipeline
    - Implement Opus ↔ G.711 µ-law transcoding, bridge decoded audio frames between WebRTC leg and SIP leg bidirectionally, handle clock rate differences (48kHz Opus ↔ 8kHz G.711), implement jitter buffer for SIP leg RTP timing, ensure no perceptible latency introduced in bridge path
    - _Requirements: 4.4, 4.9_

  - [x] 2.3 Implement WebSocket audio stream endpoint
    - Implement WebSocket listener on port 9091 (configurable) at path /audio/:sessionId, accept bidirectional PCM 16-bit 16kHz audio frames (or Opus pass-through if receiver supports it), bridge audio between WS stream and WebRTC leg, support token-based (Bearer) authentication in WS upgrade handshake, handle connection/disconnection → emit provider_connected/provider_disconnected events
    - _Requirements: 4.5_

  - [x] 2.4 Implement audio tap for future processing
    - Implement optional audio tap when audioTap.enabled = true in session config, copy decoded PCM frames (both directions) to configured tap endpoint (WebSocket or Unix socket), deliver as 16kHz 16-bit PCM with direction labels (client-to-provider, provider-to-client) as separate labeled channels, implement in separate goroutine with non-blocking copy (zero latency on main audio path), no-op when disabled (zero overhead), document tap endpoint format as part of ControlAPI specification
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [x] 2.5 Implement DTMF relay
    - Detect RFC 2833 telephone-event packets from WebRTC leg, relay as RFC 2833 on SIP leg (outbound DTMF), detect RFC 2833 from SIP leg → emit DTMF event to Server via event WebSocket (inbound DTMF), support both in-band relay and event-based notification
    - _Requirements: 12.1_

- [x] 3. Server Orchestration
  - [x] 3.1 Create MediaBridgeClient service
    - Create `src/services/media-bridge-client.ts`, implement createSession(config: SessionConfig) → HTTP POST /sessions, submitOffer(sessionId, sdpOffer) → POST /sessions/:id/offer → returns {sdpAnswer, iceCandidates}, updateSession(sessionId, patch) → HTTP PATCH /sessions/:id, destroySession(sessionId) → HTTP DELETE /sessions/:id, getSessionStatus(sessionId) → HTTP GET /sessions/:id, isHealthy() → GET /health, add health check polling on configurable interval (default 5s from server config mediaBridge.healthCheckInterval)
    - _Requirements: 4.3, 4.6, 5.1_

  - [x] 3.2 Create MediaBridge event listener
    - Create internal WebSocket server endpoint `/internal/media-events` (on configurable port from mediaBridge.eventWebSocketPort), accept connection from MediaBridge on startup, parse and dispatch session events (client_connected, provider_connected, client_disconnected, provider_disconnected, dtmf, health), route events to CallOrchestrator for state updates, handle MediaBridge reconnection and re-sync of active sessions
    - _Requirements: 4.10, 5.3_

  - [x] 3.3 Create CallOrchestrator service
    - Create `src/services/call-orchestrator.ts`, implement initiateOutbound(deviceId, from, to) → create session with providerLeg:pending + ringback:true → provider.makeCall(from, to, sipUri) → PATCH session with providerLeg → return callId, implement handleInbound(providerId, callId, from, to) → create session with providerLeg:sip → return sipUri for webhook → notify devices via push + WS, implement answerCall(callId, deviceId) → mark answered → notify other devices (answered_elsewhere), implement handleWebRtcOffer(callId, deviceId, sdpOffer) → submitOffer to MediaBridge → return sdpAnswer, implement endCall(callId) → destroySession → provider.endCall → notify clients → update call history, implement handleMediaEvent(event) → provider_disconnected → endCall, client_disconnected → endCall, dtmf → forward. Use ProviderRegistry to determine which TelephonyProvider handles each call based on phone number assignment
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 8.2, 8.3, 8.5_

  - [x] 3.4 Add WebRTC offer API route
    - Add POST /api/calls/webrtc/offer accepting {sdpOffer: string, callId: string}, authenticate via existing session middleware (reject with HTTP 401 if unauthenticated), associate WebRTC session with active call for authenticated device, delegate to CallOrchestrator.handleWebRtcOffer(), return {sdpAnswer: string}, return HTTP 503 if MediaBridge unavailable with error message indicating media service unavailable, ensure signaling completes within 5s timeout
    - _Requirements: 3.1, 3.3, 3.4, 3.5, 3.6, 6.1, 6.4_

  - [x] 3.5 Implement ICE candidate relay via WebSocket
    - Add WebSocket message type `ice_candidate` (client → server → MediaBridge), add reverse direction (MediaBridge → server → client), handle trickle ICE or bundle all in offer/answer if ICE Lite, ensure candidates routed to correct session/call
    - _Requirements: 3.2, 6.2_

  - [x] 3.6 Update existing call routes to use CallOrchestrator
    - Modify POST /api/calls/make to delegate to CallOrchestrator.initiateOutbound(), response contains {callId, from, to} only (no provider-specific fields), modify POST /api/calls/answer/:callId to delegate to CallOrchestrator.answerCall(), modify POST /api/calls/decline/:callId to delegate to CallOrchestrator.endCall(), add POST /api/calls/:callId/dtmf fallback endpoint for out-of-band DTMF, GET /api/calls/active remains unchanged (uses generic field names)
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 6.1, 6.3, 6.6_

  - [x] 3.7 Implement MediaBridge failure detection
    - Detect MediaBridge crash or unresponsiveness via health check polling failure or event WebSocket disconnect, on failure: transition all active calls to ENDED with reason FAILED, notify all affected clients via WebSocket call_event {status: failed}, log structured warning for operational monitoring
    - _Requirements: 4.10, 2.8_

  - [x] 3.8 Add server configuration for MediaBridge
    - Add `mediaBridge` section to server config (controlApiUrl: default http://localhost:9090, eventWebSocketPort: default 9095, healthCheckInterval: default 5000ms), initialize MediaBridgeClient on server startup, start internal event WebSocket server on eventWebSocketPort, add health monitoring with warnings when MediaBridge unavailable
    - _Requirements: 11.3_

- [x] 4. Checkpoint - Ensure MediaBridge and Server orchestration tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Vonage Provider Adaptation
  - [x] 5.1 Modify Vonage NCCO for SIP routing
    - Modify outbound NCCO: replace {type: "app", user: "..."} with {type: "sip", uri: "sip://session-id@mediabridge:5060"}, modify inbound answer webhook: return NCCO connecting caller to MediaBridge SIP URI, update makeCall() to accept sipUri parameter from CallOrchestrator and include in NCCO, update handleWebhook('answer') to receive SIP URI context and return appropriate NCCO with SIP connect action
    - _Requirements: 10.1, 10.2, 10.3_

  - [x] 5.2 Remove Vonage Client SDK server dependencies
    - Remove ProviderUserManager service (`src/services/provider-user-manager.ts`), remove POST /api/calls/token route from call-routes.ts, remove Vonage Users API client code, remove provider_users database table (add migration), remove JWT generation for client SDK auth, remove ncco-builder "app user" logic (keep SIP connect patterns)
    - _Requirements: 10.4, 6.7, 12.4_

  - [x] 5.3 Verify Vonage integration through MediaBridge
    - Verify outbound calls work through MediaBridge SIP (NCCO connect → SIP INVITE → audio bridge), verify inbound calls work through MediaBridge SIP (webhook → NCCO → SIP INVITE), verify call events (ringing, connected, completed, failed) flow correctly through CallOrchestrator, verify existing webhooks (answer, event, inbound-sms, sms-status) continue to function, verify SMS remains unaffected (no MediaBridge involvement), verify call history recording works, verify push notifications still work
    - _Requirements: 10.5, 10.6, 12.1, 12.2_

- [x] 6. 46elks Provider
  - [x] 6.1 Implement 46elks telephony provider
    - Create `src/providers/elks46-telephony-provider.ts` implementing TelephonyProvider interface, implement makeCall(from, to, sipUri) via POST https://api.46elks.com/a1/calls with voice_start webhook URL that returns SIP connect JSON, implement endCall(callId) via POST https://api.46elks.com/a1/calls/{callId} with {status: "hangup"}, implement answerCall() (handled via voice_start webhook response connecting to MediaBridge SIP), implement sendSms(from, to, message) via POST https://api.46elks.com/a1/sms, implement listNumbers() via GET https://api.46elks.com/a1/numbers mapping capabilities (voice, sms) to ProviderNumber format, implement HTTP Basic Authentication (apiUsername:apiPassword), connect call audio to MediaBridge via SIP URI
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9_

  - [x] 6.2 Implement 46elks webhook handlers
    - Implement voice_start webhook handler (incoming call → emit incoming_call event, return {"connect": "sipUri", "callerid": from}), implement voice_event webhook (call status updates: ongoing/success/failed → map to CallState, emit call_state_changed), implement sms_incoming webhook (incoming SMS → emit incoming_sms event), register webhook endpoints via getWebhookEndpoints() returning ['voice_start', 'voice_event', 'sms_incoming']
    - _Requirements: 7.3, 7.5, 7.10_

  - [x] 6.3 Register 46elks provider in server
    - Add "46elks" case to provider factory in server.ts, define Elks46ProviderConfig interface (apiUsername: string, apiPassword: string, webhookBaseUrl: string), add to ProviderRegistry so numbers can be assigned to 46elks provider, ensure multiple providers can be active simultaneously with separate number assignments
    - _Requirements: 7.9, 8.1, 8.2_

- [x] 7. Checkpoint - Ensure Vonage and 46elks provider tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Android Client Refactor
  - [x] 8.1 Update Android dependencies
    - Remove `com.vonage:client-sdk-voice` from libs.versions.toml and build.gradle.kts, add `io.github.webrtc-sdk:android:144.7559.05` (GMS-free libwebrtc build, no Google Play Services dependency) to libs.versions.toml and build.gradle.kts, verify build succeeds with new dependency, ensure no provider SDK remains as dependency
    - _Requirements: 1.1, 2.1_

  - [x] 8.2 Implement WebRtcAudioClient
    - Create `domain/call/WebRtcAudioClient.kt` interface with: connectionState (StateFlow<WebRtcState>), createOffer(): String, setRemoteAnswer(sdpAnswer: String), addIceCandidate(candidate), setMuted(muted: Boolean), sendDtmf(digit: Char), disconnect(). Create `domain/call/WebRtcAudioClientImpl.kt`: initialize PeerConnectionFactory (audio-only, no video), create PeerConnection with ICE server config (MediaBridge TCP fixed port + public IP), configure Opus codec (voip mode, max 32kbps), use standard WebRTC echo cancellation/jitter buffering/noise suppression (no custom DSP), implement createOffer() → SDP string, setRemoteAnswer(sdp), addIceCandidate(candidate), setMuted(muted) → enable/disable local audio track, sendDtmf(digit) → RTCDTMFSender, disconnect() → close peer connection and release resources, expose connectionState: StateFlow<WebRtcState> (Disconnected/Connecting/Connected/Failed), handle ICE connection state changes
    - _Requirements: 1.2, 2.1, 2.5, 2.8_

  - [x] 8.3 Create Android DI voice module
    - Delete `di/VonageModule.kt`, create `di/VoiceModule.kt` binding WebRtcAudioClientImpl to WebRtcAudioClient interface via Hilt, ensure no provider-specific DI bindings remain
    - _Requirements: 1.1_

  - [x] 8.4 Refactor VoiceCallManager
    - Replace vonageClientManager with webRtcAudioClient injection, replace initiateVonageClientCall() with: POST /calls/make → get callId → createOffer() → POST /calls/webrtc/offer → setRemoteAnswer(sdpAnswer), replace disconnectVonageClientSession() with disconnect(), update answerCall() flow: POST /calls/answer → createOffer() → POST /calls/webrtc/offer → setRemoteAnswer(), update toggleMute() to use webRtcAudioClient.setMuted(), update sendDtmf() to use webRtcAudioClient.sendDtmf() (primary in-band) with REST fallback, remove initializeSdkSession()/observeSdkIncomingCalls()/observeSdkHangupEvents(), monitor WebRTC connectionState for connectivity loss → notify user and transition call to ENDED with reason CONNECTIVITY_LOST, ensure NO logic branches based on telephony provider type
    - _Requirements: 1.2, 1.3, 1.4, 2.8, 12.1, 12.3_

  - [x] 8.5 Update Android CallsApi
    - Add `submitWebRtcOffer(callId: String, sdpOffer: String): WebRtcOfferResponse` (POST /api/calls/webrtc/offer), remove `getCallToken(deviceId: String): TokenResponse`, add `sendDtmf(callId: String, digit: Char)` out-of-band fallback (POST /api/calls/:callId/dtmf)
    - _Requirements: 6.1, 6.4, 6.7_

  - [x] 8.6 Update Android DTOs
    - Remove TokenResponse/TokenRequest DTOs, add WebRtcOfferRequest(sdpOffer: String, callId: String) and WebRtcOfferResponse(sdpAnswer: String) DTOs, rename ActiveCallDto field vonageNumber → providerNumber (keep @SerialName("vonageNumber") for backward compat during transition), rename vonageNumberLabel → providerNumberLabel (keep @SerialName for backward compat), remove vonageUser references from all DTOs
    - _Requirements: 6.3, 6.4, 6.6, 12.5, 12.6, 12.7_

  - [x] 8.7 Update Android WebSocket event handling
    - Update JSON parsing to accept both vonageNumber/providerNumber field names during transition period, accept both vonageNumberLabel/providerNumberLabel, add handler for "ice_candidate" WebSocket message type (relay to WebRtcAudioClient.addIceCandidate), handle call_event statuses (ringing/connected/disconnected/completed/busy/failed), handle call_cancelled with reasons (answered_elsewhere/declined/caller_disconnect/timeout), remove SDK-specific event handling
    - _Requirements: 6.2, 6.5, 12.7_

  - [x] 8.8 Android file cleanup
    - Delete VonageClientManager.kt (interface + impl), delete VonageCall.kt, delete VonageModule.kt (if not already deleted in 8.3), update all imports referencing removed files, remove Vonage-specific comments/references throughout codebase, verify no provider-specific code remains in client
    - _Requirements: 1.1, 1.4, 1.5, 12.3_

- [x] 9. Checkpoint - Ensure Android client builds and unit tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Cleanup and Integration
  - [x] 10.1 Server field name cleanup
    - Remove all vonageUser/vonageNumber/vonageNumberLabel field names from WebSocket events (only send providerNumber/providerNumberLabel), remove vonageUserManager parameter from registerCallRoutes(), clean up ncco-builder.ts (remove app-user NCCO logic, keep SIP connect patterns), remove dead imports and unused code, rename ActiveCallDto field vonageNumber → providerNumber in GET /api/calls/active response, ensure ALL responses use provider-generic terminology
    - _Requirements: 5.5, 6.6, 12.5, 12.6_

  - [x] 10.2 Deployment configuration
    - Create `mediabridge/Dockerfile` for standalone MediaBridge build (single static binary, CGO_ENABLED=0), add docker-compose.yml with server + mediabridge services (expose ports: 3000 API, 8443 WebRTC TCP, 5060 SIP, 9091 Audio WS), alternatively extend main Dockerfile for single-container with s6-overlay, update Caddyfile for WebRTC port routing (TCP pass-through on 8443), document port requirements in README
    - _Requirements: 11.1, 11.4_

  - [x] 10.3 Configuration and documentation
    - Create `mediabridge-config.example.yaml` with all configurable values (webrtcPort, controlApiPort, sipPort, audioWsPort, publicIp, eventUpstream URL/reconnectInterval, audio ringbackCadence/opusMaxBitrate/sipCodec, logging level/format), update server config with mediaBridge section (controlApiUrl, eventWebSocketPort, healthCheckInterval), update .env.example with new environment variables (PUBLIC_IP, MEDIA_BRIDGE_CONTROL_URL, MEDIA_BRIDGE_EVENT_WS_PORT), update README.md with new architecture diagram and setup instructions, document ControlAPI specification (endpoints, request/response formats, events)
    - _Requirements: 11.2, 11.3, 11.5_

  - [x] 10.4 Multi-provider number display verification
    - Verify Android client displays all phone numbers from all configured providers in a single unified list, verify user does not need to know/select which provider backs a specific number, verify numbers API returns combined list from ProviderRegistry across all providers
    - _Requirements: 8.1, 8.4_

  - [x] 10.5 End-to-end integration testing
    - E2E: outbound call via Vonage through MediaBridge (make → WebRTC connect → ringback → SIP connect → audio flows), E2E: inbound call via Vonage through MediaBridge (webhook → notify → answer → WebRTC → audio), E2E: outbound/inbound call via 46elks through MediaBridge, test DTMF both directions (in-band via RTCDTMFSender and out-of-band REST fallback), test mute/unmute (local audio track enable/disable), test call history recording after call ends, test missed call notifications (push + WS), test answered-elsewhere flow (multi-device, cancel other devices), test connectivity loss handling (WebRTC disconnect → ENDED with CONNECTIVITY_LOST), test MediaBridge crash recovery (server detects → ends calls → notifies clients), test SMS send/receive unaffected by changes, test speaker routing unchanged
    - _Requirements: 12.1, 12.2, 4.10, 8.2, 8.3, 8.5_

- [x] 11. Final Checkpoint - Full system integration verified
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- The design uses Go for MediaBridge, TypeScript for Server, and Kotlin for Android — all tasks use the appropriate language for each component.
- Phases 4 (task 5) and 5 (task 6) are fully independent — Vonage adaptation and 46elks implementation can proceed in parallel once CallOrchestrator (3.3) is done.
- Phase 6 (task 8, Android) can start once the WebRTC Offer route (3.4) is defined, even if MediaBridge isn't fully functional yet.
- MediaBridgeClient (3.1) only depends on the ControlAPI spec (1.2), not SIP or audio pipelines — server orchestration can begin while Phase 2 is in progress.
- Audio Tap (2.4) and DTMF Relay (2.5) are not blocking for main call flow and can be deferred.
- The design has no Correctness Properties section, so no property-based tests are included. Testing is covered via unit tests and integration tests within relevant tasks.
- Tasks marked with checkpoints ensure incremental validation throughout the build.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5"] },
    { "id": 2, "tasks": ["2.1", "2.3", "3.1", "3.2"] },
    { "id": 3, "tasks": ["2.2", "2.4", "2.5", "3.3", "3.8"] },
    { "id": 4, "tasks": ["3.4", "3.5", "3.6", "3.7"] },
    { "id": 5, "tasks": ["5.1", "6.1", "8.1"] },
    { "id": 6, "tasks": ["5.2", "5.3", "6.2", "6.3", "8.2", "8.5", "8.6"] },
    { "id": 7, "tasks": ["8.3", "8.7"] },
    { "id": 8, "tasks": ["8.4"] },
    { "id": 9, "tasks": ["8.8", "10.1"] },
    { "id": 10, "tasks": ["10.2", "10.3", "10.4"] },
    { "id": 11, "tasks": ["10.5"] }
  ]
}

```
