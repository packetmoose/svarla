# SIP Telephony Provider — Requirements

> Voice-only provider for connecting Svarla to a SIP-based PBX (e.g., Asterisk, FreeSWITCH, or any standards-compliant SIP server).

## Assumptions

- The app supports **one active call at a time** per account/device. There is no need for concurrent call multiplexing on the trunk.
- One SIP trunk per provider instance is sufficient.
- Media always flows through the MediaBridge sidecar (no direct RTP between client and PBX).
- The Android client requires **zero changes** — all SIP specifics are abstracted behind the existing `callId`-based REST + WebRTC API.

---

## 1. Provider Configuration & Registration

| ID | Requirement |
|----|-------------|
| **SIP-1.1** | The system SHALL support a new provider type `sip` in the provider registry. |
| **SIP-1.2** | The SIP provider configuration SHALL include: SIP server address (host:port), transport protocol (UDP/TCP/TLS), optional authentication credentials (username, password, realm), registration mode (register vs. static trunk), one or more DID numbers to associate with the provider, and DTMF mode. |
| **SIP-1.3** | When `register` mode is enabled, the system SHALL maintain a persistent SIP REGISTER with the configured SIP server, refreshing before expiry and re-registering on failure with exponential backoff. |
| **SIP-1.4** | When `trunk_mode` is enabled (static trunk), the system SHALL NOT send REGISTER requests. It SHALL rely on IP-based authentication or pre-shared credentials configured in the remote PBX. |
| **SIP-1.5** | The provider SHALL expose only `VOICE` capability for its configured numbers. `sendSms()` SHALL return an error indicating SMS is not supported. |

---

## 2. Inbound Calls (PBX → Svarla)

| ID | Requirement |
|----|-------------|
| **SIP-2.1** | The MediaBridge SHALL accept unsolicited SIP INVITEs from the configured SIP server (trunk peer), matching by source IP/port and trunk configuration. |
| **SIP-2.2** | On receiving a matched inbound INVITE, the MediaBridge SHALL emit a new `inbound_sip_call` event via the event WebSocket, including caller ID (From header), dialed number (To header/Request-URI), and a generated session ID. |
| **SIP-2.3** | The Node.js SIP provider SHALL handle the `inbound_sip_call` event by emitting an `incoming_call` TelephonyEvent to the CallOrchestrator, triggering the standard inbound call flow (push notifications, device ringing, etc.). |
| **SIP-2.4** | The MediaBridge SHALL respond with `100 Trying` immediately and `180 Ringing` once the session is created, then `200 OK` (with SDP) once the client answers and WebRTC is established. |
| **SIP-2.5** | If no device answers within a configurable timeout (default 30 seconds), the MediaBridge SHALL respond with `480 Temporarily Unavailable` and the call SHALL be recorded as MISSED. |

---

## 3. Outbound Calls (Svarla → PBX)

| ID | Requirement |
|----|-------------|
| **SIP-3.1** | The SIP provider's `makeCall(from, to, sipUri)` SHALL instruct the MediaBridge to originate a SIP INVITE to the configured SIP server, with the destination number encoded in the Request-URI (e.g., `sip:<to>@<sip-server>:<port>`). |
| **SIP-3.2** | The MediaBridge ControlAPI SHALL be extended with an `originate` mode on the SIP provider leg type, indicating the MediaBridge should send an outbound INVITE rather than wait for an inbound one. |
| **SIP-3.3** | The outbound INVITE SHALL include appropriate `From` header (caller ID from the provider's configured number), SDP offer for audio, and authentication credentials if required by the SIP server. |
| **SIP-3.4** | The SIP provider SHALL map SIP response codes to CallState: `180/183` → RINGING, `200` → ANSWERED, `486` → BUSY, `4xx/5xx/6xx` → FAILED. |
| **SIP-3.5** | When the far end answers (200 OK with SDP), the MediaBridge SHALL bridge the audio between the WebRTC client leg and the SIP provider leg, reporting `provider_connected` via the event WebSocket. |

---

## 4. Call Lifecycle & Teardown

| ID | Requirement |
|----|-------------|
| **SIP-4.1** | The SIP provider's `endCall()` SHALL instruct the MediaBridge to send a SIP BYE on the active SIP dialog. |
| **SIP-4.2** | If the remote party (PBX/far-end) sends BYE, the MediaBridge SHALL emit a `provider_disconnected` event, triggering the standard CallOrchestrator end-call flow. |
| **SIP-4.3** | If the remote party sends a SIP CANCEL (before answer), the MediaBridge SHALL emit an event mapped to call state FAILED, and the call SHALL be recorded as MISSED for inbound or UNANSWERED for outbound. |
| **SIP-4.4** | Call duration SHALL be calculated from the time of 200 OK (answer) until BYE, consistent with other providers. |

---

## 5. DTMF (Dual-Tone Multi-Frequency)

| ID | Requirement |
|----|-------------|
| **SIP-5.1** | The MediaBridge SHALL support receiving DTMF from the SIP leg via RFC 4733 (RTP telephone-event) and SHALL relay detected digits to the Node.js server as `dtmf` events on the event WebSocket. |
| **SIP-5.2** | The MediaBridge SHALL support receiving DTMF via SIP INFO (application/dtmf-relay) as a fallback for PBX systems that do not support RFC 4733, and SHALL relay detected digits identically. |
| **SIP-5.3** | The MediaBridge SHALL support sending DTMF toward the SIP leg (originated from the WebRTC client) using RFC 4733 telephone-event by default. |
| **SIP-5.4** | The SIP provider configuration SHALL include a `dtmf_mode` option (`rfc4733`, `sip_info`, `auto`) controlling how DTMF is sent toward the SIP server. Default SHALL be `auto` (prefer RFC 4733, fall back to SIP INFO based on SDP negotiation). |
| **SIP-5.5** | DTMF digits received from the SIP leg SHALL be forwarded to connected WebRTC clients via the existing `dtmf` event WebSocket mechanism, allowing the Android client to display/use them. |
| **SIP-5.6** | DTMF digits sent from the Android client (via `POST /api/calls/{callId}/dtmf`) SHALL be forwarded by the CallOrchestrator to the MediaBridge, which SHALL transmit them on the SIP leg using the configured `dtmf_mode`. |

---

## 6. MediaBridge ControlAPI Extensions

| ID | Requirement |
|----|-------------|
| **SIP-6.1** | The ControlAPI `POST /sessions` endpoint SHALL accept a new provider leg variant: `{ type: 'sip', uri: '...', mode: 'originate' }` which instructs the MediaBridge to send an outbound INVITE to the given URI. |
| **SIP-6.2** | A new `POST /sip/trunks` endpoint SHALL allow the Node.js server to register a SIP trunk configuration at startup, specifying: trunk ID, remote host/port, transport, credentials, and associated provider ID. |
| **SIP-6.3** | A new `DELETE /sip/trunks/:trunkId` endpoint SHALL allow removing a trunk configuration at runtime (e.g., when a provider is disabled). |
| **SIP-6.4** | The event WebSocket SHALL emit a new event type `inbound_sip_call` with fields: `trunkId`, `callId` (generated), `from`, `to`, `sipCallId` (SIP Call-ID header). |
| **SIP-6.5** | When registration mode is used, the MediaBridge SHALL handle SIP REGISTER on behalf of the configured trunk and emit `trunk_registration_failed` / `trunk_registration_success` events to allow the Node.js server to update provider status. |
| **SIP-6.6** | A new `POST /sessions/:sessionId/dtmf` endpoint SHALL accept `{ digit: string, method?: 'rfc4733' | 'sip_info' }` to send a DTMF digit toward the provider SIP leg. |

---

## 7. Node.js Provider Implementation

| ID | Requirement |
|----|-------------|
| **SIP-7.1** | A new `SipTelephonyProvider` class SHALL implement the `TelephonyProvider` interface with provider ID `"sip"`. |
| **SIP-7.2** | `start()` SHALL register the SIP trunk configuration with the MediaBridge via the ControlAPI and subscribe to `inbound_sip_call` events. |
| **SIP-7.3** | `stop()` SHALL deregister the trunk from the MediaBridge and clean up any active call state. |
| **SIP-7.4** | `listNumbers()` SHALL return the configured DID numbers with `VOICE` capability only. |
| **SIP-7.5** | `getWebhookEndpoints()` SHALL return an empty array (no HTTP webhooks needed for SIP). |
| **SIP-7.6** | `handleWebhook()` SHALL be a no-op that throws an error (SIP provider doesn't use webhooks). |
| **SIP-7.7** | The provider SHALL set `supportsSips = true` when TLS transport is configured, and `false` otherwise. |

---

## 8. Configuration Validation

| ID | Requirement |
|----|-------------|
| **SIP-8.1** | A new Zod schema `sipConfigSchema` SHALL validate: `sip_server` (required string), `transport` (enum: udp/tcp/tls, default udp), `username` (optional), `password` (optional), `realm` (optional), `register` (boolean, default true), `trunk_mode` (boolean, default false), `numbers` (array of E.164 strings, min 1), `caller_id` (optional E.164 string), `dtmf_mode` (enum: rfc4733/sip_info/auto, default auto). |
| **SIP-8.2** | Validation SHALL enforce that `register` and `trunk_mode` are mutually exclusive — exactly one must be true. |
| **SIP-8.3** | When `register` is true, `username` and `password` SHALL be required. |

---

## 9. Security & Network

| ID | Requirement |
|----|-------------|
| **SIP-9.1** | SIP credentials (password) SHALL be encrypted at rest in the database using the existing config encryption mechanism. |
| **SIP-9.2** | The MediaBridge SHALL only accept inbound SIP INVITEs from IP addresses associated with the configured trunk. Unmatched INVITEs SHALL be rejected with `403 Forbidden`. |
| **SIP-9.3** | When TLS transport is configured, the MediaBridge SHALL validate the remote SIP server's TLS certificate (with an option to disable validation for self-signed certs in development). |

---

## 10. Observability

| ID | Requirement |
|----|-------------|
| **SIP-10.1** | The SIP provider SHALL log all significant SIP events (REGISTER success/failure, INVITE sent/received, BYE, errors) at `info` level. |
| **SIP-10.2** | Trunk registration status (registered/unregistered/failed) SHALL be reflected in the provider registry entry's `status` field and exposed via the admin API. |
| **SIP-10.3** | DTMF events (sent and received) SHALL be logged at `debug` level with the associated call ID and digit. |

---

## Non-Requirements (Out of scope)

- SMS/MMS over SIP MESSAGE
- Video calls
- SIP presence/BLF (Busy Lamp Field)
- Conference calling / multi-party
- SRTP key negotiation (rely on TLS transport for encryption)
- Direct RTP (media always flows through MediaBridge)
- T.38 fax
- SIP SUBSCRIBE/NOTIFY (voicemail indicators, etc.)
- Multiple concurrent calls (app is single-call-at-a-time)
- Multiple SIP trunks per provider instance
