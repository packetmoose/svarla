# Technical Design: Provider-Generic Voice Architecture

## Overview

This document describes the technical design for refactoring Svarla to a
provider-generic architecture with server-relayed audio. The design covers
the MediaBridge (Pion sidecar), server orchestration changes, provider
adaptations, and Android client refactoring.

## Design Principles

1. **Client simplicity** — The Android client knows nothing about providers.
   It connects WebRTC to the server and uses a unified signaling API.
2. **Server as orchestrator** — The Node.js server owns all business logic,
   call state, and provider coordination. The MediaBridge is a dumb audio pipe.
3. **MediaBridge replaceability** — The sidecar is controlled via a documented
   REST+WebSocket API. Any implementation satisfying that contract can replace it.
4. **Provider-side flexibility** — Providers connect audio via SIP or WebSocket
   audio streams, supporting cloud providers (Vonage, 46elks) and hardware
   (future modem-on-Raspberry-Pi).
5. **No Google Services dependency** — The Android app must run on degoogled
   devices (GrapheneOS, LineageOS, /e/OS, etc.). All dependencies must be
   GMS-free.


## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Server Host / Docker                         │
│                                                                     │
│  ┌──────────────────────┐         ┌──────────────────────────────┐ │
│  │   Node.js / Fastify  │         │   MediaBridge (Pion / Go)    │ │
│  │                      │         │                              │ │
│  │  ┌────────────────┐  │  REST   │  ┌────────────────────────┐ │ │
│  │  │ Call Orchestr.  │──┼────────►│  │ ControlAPI (port 9090) │ │ │
│  │  └────────────────┘  │         │  └────────────────────────┘ │ │
│  │  ┌────────────────┐  │         │  ┌────────────────────────┐ │ │
│  │  │ Provider Reg.   │  │         │  │ WebRTC Endpoint (8443) │ │ │
│  │  └────────────────┘  │         │  └────────────────────────┘ │ │
│  │  ┌────────────────┐  │         │  ┌────────────────────────┐ │ │
│  │  │ WebSocket/REST  │  │         │  │ SIP UAS (port 5060)   │ │ │
│  │  │ (client-facing) │  │         │  └────────────────────────┘ │ │
│  │  └────────────────┘  │         │  ┌────────────────────────┐ │ │
│  │  ┌────────────────┐  │         │  │ Audio WS (port 9091)   │ │ │
│  │  │ Telephony Provs │  │         │  └────────────────────────┘ │ │
│  │  └────────────────┘  │         │                              │ │
│  └──────────────────────┘         └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
         ▲                                    ▲            ▲
         │ WebSocket + REST                   │ WebRTC     │ SIP / Audio WS
         │                                    │            │
    ┌────┴─────┐                         ┌────┴────┐  ┌───┴────────────┐
    │ Android  │                         │ Android │  │ Provider       │
    │ (signal) │                         │ (audio) │  │ (Vonage/46elks │
    └──────────┘                         └─────────┘  │  /Modem+Pi)   │
                                                      └────────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| Node.js Server | Call state, signaling, provider orchestration, push notifications, call history, SDP relay |
| MediaBridge | WebRTC termination, SIP termination, audio WS termination, codec transcoding, ringback generation, audio tap |
| Android Client | UI, WebRTC peer connection, signaling via REST+WebSocket |
| TelephonyProvider | Provider-specific API calls (make/end/answer/SMS), webhook handling |


## MediaBridge Design

### Technology

- **Language:** Go
- **WebRTC:** Pion (github.com/pion/webrtc)
- **SIP:** Pion SIP or go-sip library for SIP UAS
- **HTTP:** net/http stdlib for ControlAPI
- **Build:** Single static binary (CGO_ENABLED=0)

### Ports

| Port | Protocol | Purpose | Exposure |
|------|----------|---------|----------|
| 8443 | TCP | WebRTC (ICE/DTLS/SRTP) | Public |
| 9090 | HTTP | ControlAPI | Localhost only |
| 5060 | UDP/TCP | SIP (provider audio) | Public (provider-facing) |
| 9091 | WebSocket | Audio stream (provider audio) | Public (provider-facing) |

### Session Lifecycle

A "session" in the MediaBridge represents one active call with two legs:
- **Client leg:** WebRTC peer connection from the Android app
- **Provider leg:** SIP dialog or WebSocket audio stream from the provider

```
Session States:
  CREATED → WAITING_CLIENT → CLIENT_CONNECTED → BRIDGING → ACTIVE → CLOSING → DESTROYED

CREATED:          Session allocated, no connections yet
WAITING_CLIENT:   SDP answer generated, waiting for WebRTC connection
CLIENT_CONNECTED: WebRTC established, waiting for provider leg
BRIDGING:         Provider leg connecting (SIP INVITE received / WS connecting)
ACTIVE:           Both legs connected, audio flowing bidirectionally
CLOSING:          Teardown in progress (BYE sent, WebRTC closing)
DESTROYED:        Session cleaned up
```


### ControlAPI Specification

Base URL: `http://localhost:9090`

#### POST /sessions

Create a new session. Returns session ID and SDP configuration.

**Request:**
```json
{
  "sessionId": "uuid-v4",
  "providerLeg": {
    "type": "sip",
    "uri": "sip:conference@mediabridge.example.com"
  },
  "options": {
    "ringback": true,
    "audioTap": {
      "enabled": false,
      "endpoint": "ws://localhost:9092/tap/session-id"
    }
  }
}
```

Provider leg types:
- `"sip"` — MediaBridge listens for SIP INVITE on its SIP port matching the session
- `"websocket"` — MediaBridge accepts audio WebSocket from provider on audio WS port
- `"pending"` — Provider leg not yet known, will be connected later via PATCH

**Response:**
```json
{
  "sessionId": "uuid-v4",
  "status": "CREATED",
  "sipUri": "sip:session-id@mediabridge-host:5060",
  "audioWsUrl": "ws://mediabridge-host:9091/audio/session-id"
}
```

#### POST /sessions/:sessionId/offer

Pass the client's SDP offer to the MediaBridge, get back an SDP answer.

**Request:**
```json
{
  "sdpOffer": "v=0\r\no=- ..."
}
```

**Response:**
```json
{
  "sdpAnswer": "v=0\r\no=- ...",
  "iceCandidates": [
    {"candidate": "candidate:1 1 TCP ...", "sdpMid": "0", "sdpMLineIndex": 0}
  ]
}
```

#### PATCH /sessions/:sessionId

Update session configuration (e.g., connect provider leg, enable/disable ringback).

**Request:**
```json
{
  "providerLeg": {
    "type": "sip",
    "uri": "sip:updated-uri@provider.com"
  },
  "ringback": false
}
```

#### DELETE /sessions/:sessionId

Tear down the session. Sends SIP BYE, closes WebRTC, frees resources.

**Response:** `204 No Content`

#### GET /sessions/:sessionId

Get current session status.

**Response:**
```json
{
  "sessionId": "uuid-v4",
  "status": "ACTIVE",
  "clientConnected": true,
  "providerConnected": true,
  "durationSeconds": 45,
  "codec": "opus/48000/2"
}
```

#### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "activeSessions": 0,
  "uptime": 3600
}
```


### MediaBridge Event WebSocket

The MediaBridge connects to the Server via WebSocket to push async events.

**Connection:** MediaBridge → `ws://localhost:PORT/internal/media-events`
(Server listens; MediaBridge connects on startup)

**Events (MediaBridge → Server):**

```json
{"type": "session_event", "sessionId": "...", "event": "client_connected"}
{"type": "session_event", "sessionId": "...", "event": "provider_connected"}
{"type": "session_event", "sessionId": "...", "event": "client_disconnected", "reason": "ice_failed"}
{"type": "session_event", "sessionId": "...", "event": "provider_disconnected", "reason": "bye"}
{"type": "session_event", "sessionId": "...", "event": "dtmf", "digit": "5"}
{"type": "health", "activeSessions": 1, "uptime": 7200}
```

This allows the Server to react to media-layer events without polling.

### Audio Codec Pipeline

```
Android (Opus/48kHz) → [WebRTC/DTLS-SRTP] → MediaBridge → [transcode if needed]
                                                          → SIP (G.711 µ-law or Opus)
                                                          → Audio WS (PCM 16kHz or Opus)
```

Transcoding paths:
- **SIP to Vonage/46elks:** Opus → G.711 (µ-law, 8kHz) — standard PSTN codec
- **Audio WS to Pi/Modem:** Opus → PCM 16-bit 16kHz (or pass Opus through if receiver supports it)
- **Audio tap:** Always delivers PCM 16-bit 16kHz regardless of leg codecs

### Ringback Generation

When `options.ringback = true` in the session config:
1. MediaBridge generates a standard telephone ringback tone (425Hz, 1s on / 4s off for EU; 440+480Hz, 2s on / 4s off for US)
2. Tone is mixed into the client leg's receive audio
3. When the provider leg connects (SIP 200 OK or first audio frame on WS), ringback stops automatically
4. Server can explicitly disable via `PATCH /sessions/:id {"ringback": false}`

Ringback cadence is configurable per session (defaults to EU pattern).


## Call Flow Sequences

### Outbound Call

```
Android              Server                  MediaBridge         Provider (e.g., Vonage)
  │                    │                        │                      │
  │ POST /calls/make   │                        │                      │
  │ {from, to}         │                        │                      │
  │───────────────────►│                        │                      │
  │                    │ POST /sessions          │                      │
  │                    │ {sessionId, provider:   │                      │
  │                    │  pending, ringback:true}│                      │
  │                    │───────────────────────►│                      │
  │                    │ {sessionId, sipUri}     │                      │
  │                    │◄───────────────────────│                      │
  │                    │                        │                      │
  │                    │ provider.makeCall(from,to)                     │
  │                    │──────────────────────────────────────────────►│
  │                    │ {callId}               │                      │
  │                    │◄──────────────────────────────────────────────│
  │                    │                        │                      │
  │                    │ PATCH /sessions/:id    │                      │
  │                    │ {providerLeg: {type:sip, uri: sipUri}}        │
  │                    │───────────────────────►│                      │
  │                    │                        │                      │
  │ 200 {callId, from, │                        │                      │
  │      to}           │                        │                      │
  │◄───────────────────│                        │                      │
  │                    │                        │                      │
  │ POST /calls/webrtc/offer                    │                      │
  │ {sdpOffer, callId} │                        │                      │
  │───────────────────►│ POST /sessions/:id/offer                     │
  │                    │───────────────────────►│                      │
  │                    │ {sdpAnswer, ice}        │                      │
  │                    │◄───────────────────────│                      │
  │ {sdpAnswer}        │                        │                      │
  │◄───────────────────│                        │                      │
  │                    │                        │                      │
  │ [WebRTC connects]  │                        │                      │
  │═══════════════════════════════════════════►│                      │
  │                    │ event: client_connected │                      │
  │                    │◄───────────────────────│                      │
  │                    │                        │                      │
  │ [Hears ringback]   │                        │                      │
  │◄══════════════════════════════════(tone)════│                      │
  │                    │                        │                      │
  │                    │                        │ SIP INVITE from      │
  │                    │                        │ Vonage (answer wh.)  │
  │                    │                        │◄─────────────────────│
  │                    │                        │ 200 OK               │
  │                    │                        │─────────────────────►│
  │                    │ event: provider_connected                     │
  │                    │◄───────────────────────│                      │
  │                    │                        │                      │
  │ WS: call_event     │                        │                      │
  │ {status:connected} │                        │                      │
  │◄───────────────────│                        │                      │
  │                    │                        │                      │
  │ [Audio flows both directions through MediaBridge]                  │
  │◄═══════════════════════════════════════════►│◄════════════════════►│
```


### Inbound Call

```
Provider             Server                  MediaBridge              Android
  │                    │                        │                       │
  │ Webhook: incoming  │                        │                       │
  │ call (answer URL)  │                        │                       │
  │───────────────────►│                        │                       │
  │                    │ POST /sessions          │                       │
  │                    │ {sessionId, provider:   │                       │
  │                    │  sip, ringback:false}   │                       │
  │                    │───────────────────────►│                       │
  │                    │ {sessionId, sipUri}     │                       │
  │                    │◄───────────────────────│                       │
  │                    │                        │                       │
  │ Response: connect  │                        │                       │
  │ to sipUri          │                        │                       │
  │◄───────────────────│                        │                       │
  │                    │                        │                       │
  │ SIP INVITE ────────────────────────────────►│                       │
  │                    │ event: provider_connected                      │
  │                    │◄───────────────────────│                       │
  │                    │                        │                       │
  │                    │ Push notification +     │                       │
  │                    │ WS: call_event          │                       │
  │                    │ {status:ringing, callId,│                       │
  │                    │  from, providerNumber}  │                       │
  │                    │───────────────────────────────────────────────►│
  │                    │                        │                       │
  │                    │                        │          User answers │
  │                    │                        │                       │
  │                    │ POST /calls/answer/:id  │                       │
  │                    │◄──────────────────────────────────────────────│
  │                    │                        │                       │
  │                    │ 200 {success}          │                       │
  │                    │───────────────────────────────────────────────►│
  │                    │                        │                       │
  │                    │                        │  POST /calls/webrtc/  │
  │                    │                        │  offer {sdpOffer}     │
  │                    │◄──────────────────────────────────────────────│
  │                    │ POST /sessions/:id/offer│                       │
  │                    │───────────────────────►│                       │
  │                    │ {sdpAnswer}             │                       │
  │                    │◄───────────────────────│                       │
  │                    │ {sdpAnswer}             │                       │
  │                    │───────────────────────────────────────────────►│
  │                    │                        │                       │
  │                    │                        │  [WebRTC connects]    │
  │                    │                        │◄═════════════════════│
  │                    │ event: client_connected │                       │
  │                    │◄───────────────────────│                       │
  │                    │                        │                       │
  │                    │ WS: call_event          │                       │
  │                    │ {status:connected}      │                       │
  │                    │───────────────────────────────────────────────►│
  │                    │                        │                       │
  │ [Audio bridged]    │                        │                       │
  │◄═══════════════════════════════════════════►│◄════════════════════►│
```


### Call Hangup (Any Party)

```
[Client hangs up]
Android ─── POST /calls/decline/:callId ───► Server
                                              │
                                              ├── DELETE /sessions/:id ──► MediaBridge
                                              │                            (sends SIP BYE, closes WebRTC)
                                              ├── provider.endCall(callId) ──► Provider
                                              │
                                              └── WS: call_event {status:disconnected} ──► Android

[Provider hangs up]
Provider ─── webhook: call completed ──► Server
                                          │
                                          ├── DELETE /sessions/:id ──► MediaBridge
                                          │
                                          └── WS: call_event {status:disconnected} ──► Android

[Media bridge detects disconnect]
MediaBridge ─── event: provider_disconnected ──► Server
                                                  │
                                                  ├── provider.endCall(callId)
                                                  │
                                                  └── WS: call_event {status:disconnected} ──► Android
```


## Server-Side Changes

### New Components

#### MediaBridgeClient (`src/services/media-bridge-client.ts`)

Thin HTTP+WebSocket client that communicates with the MediaBridge ControlAPI.

```typescript
interface MediaBridgeClient {
  createSession(config: SessionConfig): Promise<SessionInfo>;
  submitOffer(sessionId: string, sdpOffer: string): Promise<OfferResult>;
  updateSession(sessionId: string, patch: SessionPatch): Promise<void>;
  destroySession(sessionId: string): Promise<void>;
  getSessionStatus(sessionId: string): Promise<SessionStatus>;
  isHealthy(): Promise<boolean>;
}

interface SessionConfig {
  sessionId: string;
  providerLeg: ProviderLegConfig;
  options?: { ringback?: boolean; audioTap?: AudioTapConfig };
}

type ProviderLegConfig =
  | { type: 'sip'; uri: string }
  | { type: 'websocket'; url: string }
  | { type: 'pending' };

interface SessionInfo {
  sessionId: string;
  status: string;
  sipUri: string;
  audioWsUrl: string;
}

interface OfferResult {
  sdpAnswer: string;
  iceCandidates: IceCandidate[];
}
```

#### CallOrchestrator (`src/services/call-orchestrator.ts`)

Replaces the current direct-to-Vonage call logic. Coordinates between
MediaBridgeClient, TelephonyProvider, and client signaling.

```typescript
interface CallOrchestrator {
  initiateOutbound(deviceId: string, from: string, to: string): Promise<OutboundCallResult>;
  handleInbound(providerId: string, callId: string, from: string, to: string): Promise<void>;
  answerCall(callId: string, deviceId: string): Promise<AnswerResult>;
  endCall(callId: string): Promise<void>;
  handleWebRtcOffer(callId: string, deviceId: string, sdpOffer: string): Promise<OfferResult>;
  handleMediaEvent(event: MediaBridgeEvent): void;
}
```

### Modified Components

#### call-routes.ts

- `POST /api/calls/make` — delegates to CallOrchestrator.initiateOutbound()
- `POST /api/calls/answer/:callId` — delegates to CallOrchestrator.answerCall()
- `POST /api/calls/decline/:callId` — delegates to CallOrchestrator.endCall()
- `POST /api/calls/webrtc/offer` — **NEW** — delegates to CallOrchestrator.handleWebRtcOffer()
- `GET /api/calls/active` — unchanged (uses generic field names)

#### Removed Components

- `ProviderUserManager` — no longer needed (no client SDK auth)
- `POST /api/calls/token` — removed
- `ncco-builder.ts` — replaced with SIP URI in NCCO connect actions
- Vonage Client SDK user provisioning logic

#### Field Renames in WebSocket Events

| Old field | New field |
|-----------|-----------|
| `vonageNumber` | `providerNumber` |
| `vonageNumberLabel` | `providerNumberLabel` |
| `vonageUser` | _(removed)_ |


## Provider Adaptations

### Vonage Provider Changes

The `VonageTelephonyProvider` changes how it routes audio:

**Before (client SDK):**
```
NCCO: [{ action: "connect", endpoint: [{type: "app", user: "device-xyz"}] }]
```

**After (SIP to MediaBridge):**
```
NCCO: [{ action: "connect", endpoint: [{type: "sip", uri: "sip://session-id@mediabridge:5060"}] }]
```

Changes to `makeCall()`:
1. Receives `sipUri` from the CallOrchestrator (which got it from MediaBridgeClient)
2. Passes the SIP URI to Vonage's create-call API in the answer NCCO
3. Vonage initiates the PSTN leg AND SIP-connects to MediaBridge

Changes to `handleWebhook('answer')`:
1. For inbound calls: returns NCCO connecting caller to MediaBridge SIP URI
2. For outbound calls: returns NCCO connecting to destination phone (PSTN)
   and the eventUrl for call state updates

The Vonage provider no longer generates client SDK JWTs or manages Vonage users.

### 46elks Provider (New)

`src/providers/elks46-telephony-provider.ts`

```typescript
class Elks46TelephonyProvider implements TelephonyProvider {
  readonly providerId = '46elks';

  // Config
  private apiUsername: string;
  private apiPassword: string;
  private webhookBaseUrl: string;

  async makeCall(from: string, to: string): Promise<CallInitResult> {
    // POST https://api.46elks.com/a1/calls
    // Body: from, to, voice_start (webhook URL that returns "connect" to SIP URI)
    // Auth: HTTP Basic (apiUsername:apiPassword)
  }

  async endCall(callId: string): Promise<void> {
    // POST https://api.46elks.com/a1/calls/{callId}
    // Body: {status: "hangup"}
  }

  async answerCall(callId: string, deviceId: string): Promise<CallAnswerResult> {
    // For 46elks, "answering" means the webhook response connects to MediaBridge SIP
    // This is handled in handleWebhook, not as a separate API call
  }

  async sendSms(from: string, to: string, body: string): Promise<SmsResult> {
    // POST https://api.46elks.com/a1/sms
    // Body: from, to, message
  }

  async listNumbers(): Promise<ProviderNumber[]> {
    // GET https://api.46elks.com/a1/numbers
    // Maps: active=yes, capabilities contains "voice"/"sms"
  }

  getWebhookEndpoints(): string[] {
    return ['voice_start', 'voice_event', 'sms_incoming'];
  }

  async handleWebhook(endpoint: string, body: unknown): Promise<unknown> {
    switch (endpoint) {
      case 'voice_start':
        // Inbound call: emit incoming_call event
        // Return: {"connect": "+sipUri", "callerid": from}
      case 'voice_event':
        // Call status update: map to CallState, emit call_state_changed
      case 'sms_incoming':
        // Inbound SMS: emit incoming_sms event
    }
  }
}
```

### Future: Modem/Raspberry Pi Provider

The architecture naturally supports a remote hardware provider:

```
Raspberry Pi (modem + service)
  │
  │ Audio: WebSocket stream to MediaBridge audioWsUrl
  │ Control: Registers with Server as a provider via REST API
  │
  └── Implements TelephonyProvider over network:
      - makeCall → AT commands to modem, streams audio to MediaBridge WS
      - endCall → ATH
      - inbound → detects RING, notifies Server, streams audio to MediaBridge WS
      - sendSms → AT+CMGS
```

The MediaBridge's WebSocket audio endpoint (`ws://host:9091/audio/:sessionId`) is
designed exactly for this use case — a remote device streams raw PCM or Opus
audio over a standard WebSocket connection.


## Android Client Changes

### Dependencies

**Remove:**
- `com.vonage:client-sdk-voice:1.2.0`

**Add:**
- `io.github.webrtc-sdk:android:144.7559.05` (GMS-free libwebrtc build maintained
  by the LiveKit team, published to Maven Central. Same open-source WebRTC/Chromium
  code as used by Signal, Threema, Element — just packaged independently without
  any Google Play Services dependency. Runs on GrapheneOS, LineageOS, /e/OS, etc.)

### New Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Android App                        │
│                                                     │
│  ┌─────────────────┐     ┌──────────────────────┐  │
│  │ VoiceCallManager │────►│ WebRtcAudioClient    │  │
│  │ (orchestrator)   │     │ (PeerConnection)     │  │
│  └────────┬─────────┘     └──────────────────────┘  │
│           │                                         │
│  ┌────────▼─────────┐     ┌──────────────────────┐  │
│  │ CallsApi          │     │ AudioRouter          │  │
│  │ (REST signaling)  │     │ (audio device mgmt)  │  │
│  └──────────────────┘     └──────────────────────┘  │
│                                                     │
│  ┌──────────────────┐                               │
│  │ SyncManager       │ (WebSocket for call events   │
│  │                   │  and ICE candidates)         │
│  └──────────────────┘                               │
└─────────────────────────────────────────────────────┘
```

### WebRtcAudioClient (`domain/call/WebRtcAudioClient.kt`)

Replaces `VonageClientManager`. Manages a single WebRTC peer connection.

```kotlin
interface WebRtcAudioClient {
    val connectionState: StateFlow<WebRtcState>

    /** Create an SDP offer for a new audio session */
    suspend fun createOffer(): String

    /** Set the remote SDP answer from the server */
    suspend fun setRemoteAnswer(sdpAnswer: String)

    /** Add a remote ICE candidate */
    fun addIceCandidate(candidate: IceCandidate)

    /** Set mute state (local audio track enabled/disabled) */
    fun setMuted(muted: Boolean)

    /** Send DTMF digit via RTP telephone-event */
    fun sendDtmf(digit: Char)

    /** Close the peer connection and release resources */
    fun disconnect()
}

sealed class WebRtcState {
    object Disconnected : WebRtcState()
    object Connecting : WebRtcState()
    object Connected : WebRtcState()
    data class Failed(val reason: String) : WebRtcState()
}
```

### Updated VoiceCallManager Flow

**Outbound call:**
1. `makeCall(from, to)` → POST /api/calls/make → get `callId`
2. `webRtcClient.createOffer()` → POST /api/calls/webrtc/offer → get `sdpAnswer`
3. `webRtcClient.setRemoteAnswer(sdpAnswer)`
4. WebRTC connects → audio flows
5. Wait for WS `call_event {status: connected}` → update UI

**Inbound call:**
1. WS `call_event {status: ringing}` → show incoming call UI
2. User answers → POST /api/calls/answer/:callId
3. `webRtcClient.createOffer()` → POST /api/calls/webrtc/offer → get `sdpAnswer`
4. `webRtcClient.setRemoteAnswer(sdpAnswer)`
5. WebRTC connects → audio flows
6. WS `call_event {status: connected}` → update UI

### Files Removed

- `domain/call/VonageClientManager.kt` (interface + impl)
- `domain/call/VonageCall.kt`
- `di/VonageModule.kt`

### Files Modified

- `domain/call/VoiceCallManager.kt` — replace Vonage SDK calls with WebRtcAudioClient
- `domain/call/IncomingCallInfo.kt` — already uses `providerNumber`
- `data/remote/dto/CallDtos.kt` — rename `vonageUser`→remove, `vonageNumber`→`providerNumber`
- `data/remote/api/CallsApi.kt` — add `submitWebRtcOffer()`, remove `getCallToken()`
- `di/AppModule.kt` or new `VoiceModule.kt` — bind WebRtcAudioClient

### Files Added

- `domain/call/WebRtcAudioClient.kt` (interface)
- `domain/call/WebRtcAudioClientImpl.kt` (implementation using org.webrtc)
- `di/VoiceModule.kt` (Hilt module binding WebRtcAudioClient)


## DTMF Design

DTMF flows through two paths (belt and suspenders):

1. **In-band (primary):** Android uses `RTCDTMFSender` API → RTP telephone-event
   packets → MediaBridge receives → relays as RFC 2833 on SIP leg
2. **Out-of-band (fallback):** Android sends POST /api/calls/:callId/dtmf
   → Server tells provider via API (e.g., Vonage PUT /calls/:id with DTMF action)

The MediaBridge also relays DTMF received from the provider leg (inbound DTMF)
as an event to the Server, which can forward to the client if needed.

## Security Considerations

### Network Exposure

| Port | Who can access | Protection |
|------|---------------|-----------|
| 8443 (WebRTC) | Android clients | DTLS-SRTP encryption, ICE consent |
| 5060 (SIP) | Telephony providers only | IP allowlist + SIP digest auth |
| 9091 (Audio WS) | Provider devices (Pi) | Token-based auth in WS handshake |
| 9090 (ControlAPI) | Localhost only | Bind to 127.0.0.1 |

### Authentication

- **Client → Server:** Existing session token (unchanged)
- **Client → MediaBridge:** DTLS certificate verification (WebRTC standard)
- **Provider → MediaBridge (SIP):** SIP digest authentication or IP allowlisting
- **Provider → MediaBridge (WS):** Bearer token in WebSocket upgrade request
- **Server → MediaBridge:** Localhost-only — no auth needed (same host)

### Audio Encryption

- Client ↔ MediaBridge: DTLS-SRTP (mandatory in WebRTC)
- MediaBridge ↔ Provider (SIP): SRTP if provider supports it, otherwise cleartext
  (matches current Vonage behavior — PSTN leg is always cleartext anyway)
- MediaBridge ↔ Provider (WS): WSS (TLS) for remote providers (Pi)

## Configuration

### Server Config (server-config.yaml additions)

```yaml
mediaBridge:
  controlApiUrl: "http://localhost:9090"
  eventWebSocketPort: 9095  # Server listens, MediaBridge connects
  healthCheckInterval: 5000  # ms
```

### MediaBridge Config (mediabridge-config.yaml)

```yaml
server:
  webrtcPort: 8443
  controlApiPort: 9090
  sipPort: 5060
  audioWsPort: 9091
  publicIp: "203.0.113.10"  # Advertised in ICE candidates

eventUpstream:
  url: "ws://localhost:9095/internal/media-events"
  reconnectInterval: 3000

audio:
  ringbackCadence: "eu"  # "eu" (425Hz) or "us" (440+480Hz)
  opusMaxBitrate: 32000
  sipCodec: "PCMU"  # G.711 µ-law for SIP legs

logging:
  level: "info"
  format: "json"
```

### Provider Config (46elks in provider registry)

```json
{
  "type": "46elks",
  "config": {
    "api_username": "u...",
    "api_password": "...",
    "webhook_base_url": "https://your-server.example.com/webhooks"
  }
}
```


## Deployment

### Docker Compose (recommended)

```yaml
services:
  server:
    build: .
    ports:
      - "3000:3000"      # API + WebSocket
    depends_on:
      - mediabridge
    environment:
      MEDIA_BRIDGE_CONTROL_URL: "http://mediabridge:9090"
      MEDIA_BRIDGE_EVENT_WS_PORT: "9095"

  mediabridge:
    image: svarla/mediabridge:latest
    ports:
      - "8443:8443"      # WebRTC (TCP)
      - "5060:5060/udp"  # SIP
      - "5060:5060/tcp"  # SIP
      - "9091:9091"      # Audio WebSocket
    environment:
      PUBLIC_IP: "${PUBLIC_IP}"
      CONTROL_API_PORT: "9090"
      EVENT_UPSTREAM_URL: "ws://server:9095/internal/media-events"
```

### Single Container (alternative)

Both processes in one container using a process supervisor (e.g., s6-overlay):

```dockerfile
FROM node:20-slim AS server
# ... existing server build ...

FROM golang:1.22 AS mediabridge
WORKDIR /build
COPY mediabridge/ .
RUN CGO_ENABLED=0 go build -o /mediabridge ./cmd/mediabridge

FROM node:20-slim
COPY --from=server /app /app
COPY --from=mediabridge /mediabridge /usr/local/bin/mediabridge
# s6-overlay to run both processes
```

### Caddy/Reverse Proxy

The existing Caddyfile needs updating to route WebRTC traffic:

```
your-domain.com {
    # Existing API
    handle /api/* {
        reverse_proxy server:3000
    }

    # WebSocket
    handle /ws/* {
        reverse_proxy server:3000
    }

    # WebRTC (TCP on 8443) — passed through directly
    # Note: WebRTC TCP typically needs direct port exposure, not HTTP reverse proxy
}

# Direct TCP pass-through for WebRTC
:8443 {
    reverse_proxy mediabridge:8443
}
```

## Implementation Phases

### Phase 1: MediaBridge Core
- Go project setup with Pion
- ControlAPI (create/destroy/offer/status/health)
- WebRTC termination (accept offer, generate answer, ICE)
- Ringback tone generation
- Basic audio pipeline (receive from client, hold in buffer)

### Phase 2: MediaBridge SIP + Audio WS
- SIP UAS implementation (accept INVITE, negotiate codec, bridge audio)
- WebSocket audio stream endpoint (accept connection, bidirectional PCM)
- Opus ↔ G.711 transcoding
- Event WebSocket to Server

### Phase 3: Server Orchestration
- MediaBridgeClient service
- CallOrchestrator service
- New route: POST /api/calls/webrtc/offer
- Internal WebSocket listener for MediaBridge events
- Update call-routes to use orchestrator

### Phase 4: Vonage Provider Adaptation
- Modify NCCO generation to use SIP connect (instead of app connect)
- Remove ProviderUserManager and /api/calls/token
- Remove ncco-builder "app user" logic
- Test outbound + inbound calls through MediaBridge

### Phase 5: 46elks Provider
- Implement Elks46TelephonyProvider
- Webhook handlers (voice_start, voice_event, sms_incoming)
- Register in provider factory
- Test with real 46elks account

### Phase 6: Android Client Refactor
- Remove Vonage SDK dependency
- Add google-webrtc dependency
- Implement WebRtcAudioClient
- Refactor VoiceCallManager (replace Vonage calls with WebRTC)
- Add webrtc/offer API call in CallsApi
- Update DTOs (field renames)
- Remove VonageModule, VonageClientManager, VonageCall
- Test full call flow

### Phase 7: Cleanup and Polish
- Remove all dead Vonage client SDK code from server
- Rename remaining "vonage" field names in WebSocket events
- Update documentation
- Update Docker build to include MediaBridge binary
- End-to-end integration testing

## Open Considerations

1. **Certificate for WebRTC DTLS:** The MediaBridge needs a self-signed cert
   for DTLS. WebRTC handles this via fingerprint in SDP — no CA-signed cert needed.

2. **ICE Lite:** Since the MediaBridge has a known public IP and fixed port,
   it can use ICE Lite (simplified ICE that doesn't gather candidates — just
   advertises its address). This simplifies the implementation significantly.

3. **Srflx/Relay:** If the Android client is behind a very restrictive NAT
   that blocks even outbound TCP to port 8443, we might need a TURN fallback.
   For now, assume TCP to a known port works (it does for 99% of networks).
   Can add TURN later if needed.

4. **Multiple simultaneous devices:** The current system supports multiple
   registered devices but only one active call. The MediaBridge supports one
   session at a time. If the answered device changes (answered_elsewhere),
   the Server destroys the old session and creates a new one.

5. **Audio tap latency budget:** The tap copies decoded PCM frames to a
   separate goroutine that writes to the tap endpoint. This adds ~0 latency
   to the main path since it's a non-blocking copy. Processing latency on
   the tap consumer side doesn't affect call audio.
