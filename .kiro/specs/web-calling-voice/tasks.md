# Implementation Plan: Web Calling Voice

## Overview

This plan brings full two-way voice calling to the Svarla web UI (the Preact SPA in `web/`). Almost all backend plumbing already exists (`src/routes/call-routes.ts`, the MediaBridge, and the Server WebSocket in `web/src/ws.ts`), so the work is predominantly **browser** code plus **one** new server component (the stale Web_Device reaper) with two small read accessors.

The implementation proceeds foundation-first so that pure, easily testable logic lands before the modules that depend on it:

1. Pure validators/formatters + capability guard (E.164 validation, duration formatting, DTMF validation, secure-context/WebRTC detection).
2. `WebRtcCallClient` (the browser analog of Android `WebRtcAudioClientImpl`) against jsdom WebRTC mocks.
3. `CallController` state machine (single source of truth: place/answer/decline/hangup, mic-first ordering, Ringing + Outbound_No_Answer_Timeout, reconcile, single-call guard, idempotent teardown).
4. `deviceLifecycle` (reuse the login-provisioned `device_id`, unload beacon, reconnect reconcile, logout).
5. `alerting` (ringtone/ringback/attention).
6. Icons + token CSS.
7. UI surfaces (Dialer popover, IncomingCallSurface modal, InCallSurface compact overlay + expandable DTMF keypad + volume) with accessibility and theming.
8. Wiring into `main.tsx` + a nav "dial" affordance.
9. Server: broadcaster accessors + orchestrator `getActiveDeviceIds()` + `web-device-reaper.ts` (last-seen refresh) wired at bootstrap.
10. Integration/verification for call-history appearance and mid-call far-party release, plus a final end-to-end wiring/regression pass.

All new browser modules live under `web/src/call/`; UI surfaces live under `web/src/components/`; the single server module is `src/services/web-device-reaper.ts`. The design specifies TypeScript throughout, so all tasks are implemented in TypeScript.

## Tasks

- [x] 1. Pure validators, formatters, and capability guard
  Foundation layer: pure input→output functions and load-time feature detection, TDD-friendly and dependency-free. These back Properties 7, 8, 9 and the capability gating (Reqs 15.1–15.3).

  - [x] 1.1 Implement destination validation and E.164 normalization (`web/src/call/dialer-validation.ts`)
    - Accept a 1–20 character destination string; reject empty input and disallowed characters
    - Normalize accepted input to an `E164_Number`; return a discriminated result `{ ok: true, e164 } | { ok: false, error }`
    - Expose a helper the Dialer uses to gate submission (send only when normalization succeeds)
    - _Requirements: 2.1, 2.2, 2.3 / Properties: P7_

  - [ ]* 1.2 Write property test for destination validation and E.164 normalization (`web/src/call/dialer-validation.test.ts`)
    - **Property 7: Destination validation and E.164 normalization**
    - Comment tag: `// Feature: web-calling-voice, Property 7: Destination validation and E.164 normalization`
    - Generate arbitrary strings (`fc.string`); assert a `POST /api/calls/make`-eligible result only for non-empty, allowed-character inputs that normalize to a valid E.164 number; all others yield a validation error and no request
    - **Validates: Requirements 2.2, 2.3**
    - _Requirements: 2.2, 2.3 / Properties: P7_

  - [x] 1.3 Implement call-duration formatter (`web/src/call/duration-format.ts`)
    - Format non-negative elapsed seconds as `mm:ss` below 60 minutes and `hh:mm:ss` at/beyond 60 minutes
    - Preserve the underlying elapsed value (no rounding that changes seconds)
    - _Requirements: 8.2 / Properties: P8_

  - [ ]* 1.4 Write property test for duration formatting (`web/src/call/duration-format.test.ts`)
    - **Property 8: Duration formatting**
    - Comment tag: `// Feature: web-calling-voice, Property 8: Duration formatting`
    - Generate non-negative integers (`fc.nat`); assert `mm:ss` below 3600s and `hh:mm:ss` at/beyond 3600s, and that the formatted value round-trips back to the same elapsed seconds
    - **Validates: Requirements 8.2**
    - _Requirements: 8.2 / Properties: P8_

  - [x] 1.5 Implement DTMF digit validation (`web/src/call/dtmf-validation.ts`)
    - Return true only for a single `DTMF_Digit` (`0`–`9`, `*`, `#`); reject all other characters
    - Provide the guard used by both the in-band and fallback DTMF paths so a non-digit produces no signal on either path
    - _Requirements: 7.6 / Properties: P9_

  - [ ]* 1.6 Write property test for DTMF input validation (`web/src/call/dtmf-validation.test.ts`)
    - **Property 9: DTMF input validation**
    - Comment tag: `// Feature: web-calling-voice, Property 9: DTMF input validation`
    - Generate arbitrary characters (`fc.char`); assert acceptance only for `0`–`9`, `*`, `#` and rejection (no signal, no state change) for everything else
    - **Validates: Requirements 7.6**
    - _Requirements: 7.6 / Properties: P9_

  - [x] 1.7 Implement the capability guard (`web/src/call/capability-guard.ts`)
    - Implement `detectCapabilities(): CapabilityReport` reporting `secureContext` (`window.isSecureContext`), `hasRTCPeerConnection`, `hasGetUserMedia`, and `callingSupported` (all of the above)
    - Provide the message keys the UI uses to disable calling: "requires a secure (HTTPS) connection" (insecure context) and "unsupported browser" (missing WebRTC APIs)
    - _Requirements: 15.1, 15.2, 15.3_

  - [ ]* 1.8 Write unit tests for the capability guard (`web/src/call/capability-guard.test.ts`)
    - Test secure vs. insecure context detection and missing `RTCPeerConnection`/`getUserMedia` via jsdom globals
    - Assert `callingSupported` is false and the correct message key is chosen for each failing precondition (Reqs 15.2, 15.3)
    - _Requirements: 15.1, 15.2, 15.3_

- [x] 2. WebRtcCallClient (browser WebRTC session)
  The browser analog of Android `WebRtcAudioClientImpl`. Owns exactly one `RTCPeerConnection` and one local mic track: getUserMedia → offer → apply answer → playback → mute → DTMF → `getStats()` watchdog → idempotent teardown. Backs Properties 2 and 3.

  - [x] 2.1 Implement `WebRtcCallClient` core lifecycle (`web/src/call/webrtc-call-client.ts`)
    - Define `WebRtcState` (`disconnected`/`connecting`/`connected`/`failed`) and machine-readable `WebRtcFailureReason` (`mic-denied`, `no-microphone`, `offer-failed`, `answer-failed`, `ice-timeout`, `ice-failed`, `connecting-timeout`, `connection-lost`, `media-inactive`)
    - `createOffer()`: `getUserMedia` → new `RTCPeerConnection` (default `iceServers: []`, STUN/TURN optional) → `addTrack` → `createOffer` → `setLocalDescription`; set state to `connecting`; map `NotAllowedError`→`mic-denied`, `NotFoundError`→`no-microphone`
    - `applyAnswer(sdpAnswer)`: `setRemoteDescription(answer)`; ICE candidates are bundled (ICE Lite, no trickle); on throw set `failed{answer-failed}`
    - Attach the remote track to the provided `HTMLAudioElement` on `ontrack` and begin playback
    - Drive Connected on `iceConnectionState` `connected`/`completed`; expose the observable `state` store
    - `setVolume(level)` sets remote audio element volume in `[0,1]`
    - _Requirements: 4.1, 4.3, 4.4, 4.6, 4.8, 4.9, 4.11, 4.13, 5.1, 5.3, 5.8, 12.1, 12.2, 12.4_

  - [x] 2.2 Implement mute, DTMF, teardown, and timers on `WebRtcCallClient`
    - `setMuted(muted)`: set local audio `MediaStreamTrack.enabled = !muted` within 200ms; if the track is unavailable/ended, retain last state, make no change, and return the effective state (Req 6.7)
    - `sendDtmf(digit)`: use `pc.getSenders().find(s => s.track?.kind === "audio")?.dtmf` and `insertDTMF(digit)`; return false when no `RTCDTMFSender` is available (caller falls back)
    - `close()`: stop the local track and close the `RTCPeerConnection`; idempotent (safe to call repeatedly); set state to `disconnected`
    - ICE timeout (20s from gather start → `ice-failed`/`ice-timeout`), connecting cap (>30s → `connecting-timeout`), and connection-lost after Connected (`iceConnectionState` disconnected/failed → `connection-lost`) all transition to `failed{reason}`
    - _Requirements: 4.5, 4.7, 4.10, 5.4, 5.5, 5.6, 5.7, 6.2, 6.3, 6.6, 6.7, 7.3, 7.4, 8.3_

  - [x] 2.3 Implement the media-inactivity watchdog via `getStats()` polling
    - `getInboundStats()` reads `inbound-rtp` `packetsReceived`/`bytesReceived` from `RTCPeerConnection.getStats()`
    - Poll at intervals not exceeding 1s while Connected; expose a `mediaReceiving` store; treat reception as inactive when no inbound delta occurs for a continuous 5s
    - On 5s of inactivity while Connected with no termination signal, transition to `failed{media-inactive}` so the controller tears down and cites loss of media
    - _Requirements: 9.6, 9.7 / Properties: P3_

  - [ ]* 2.4 Write property test for the connected-implies-resources invariant (`web/src/call/webrtc-call-client.test.ts`)
    - **Property 2: Connected-implies-resources invariant**
    - Comment tag: `// Feature: web-calling-voice, Property 2: Connected-implies-resources invariant`
    - With jsdom fakes for `RTCPeerConnection`/`getUserMedia`, generate execution paths; assert that whenever the client reports Connected, a non-closed `RTCPeerConnection` and a live local track (`readyState === "live"`) both exist
    - **Validates: Requirements 4.3, 4.9, 5.3, 5.6**
    - _Requirements: 4.3, 4.9, 5.3, 5.6 / Properties: P2_

  - [ ]* 2.5 Write property test for the resource-safety invariant (`web/src/call/webrtc-call-client.test.ts`)
    - **Property 3: Resource-safety invariant**
    - Comment tag: `// Feature: web-calling-voice, Property 3: Resource-safety invariant`
    - Generate every end path (hang up, remote completed/failed/busy, decline, WebRTC failure, watchdog teardown, browser close); assert `track.stop()` and `pc.close()` each run and no mic capture leaks; assert `close()` is idempotent (repeated calls stop/close at most once effectively)
    - **Validates: Requirements 4.2, 5.6, 8.3, 9.1, 9.7**
    - _Requirements: 4.2, 5.6, 8.3, 9.1, 9.7 / Properties: P3_

  - [ ]* 2.6 Write unit tests for `WebRtcCallClient` failure and edge cases (`web/src/call/webrtc-call-client.test.ts`)
    - Mic denied (`NotAllowedError`→`mic-denied`) and no mic device (`NotFoundError`→`no-microphone`); apply-answer failure (`answer-failed`); ICE failed/timeout (20s) and connecting cap (>30s); connection lost after Connected (`connection-lost`)
    - Mute no-op when the track is ended (Req 6.7); DTMF returns false with no `RTCDTMFSender` (drives the fallback in the controller); autoplay-blocked `audio.play()` rejection surfaces to the controller for a gesture-tied resume (Req 4.12)
    - _Requirements: 4.2, 4.5, 4.7, 4.10, 4.12, 5.4, 5.5, 5.7, 6.7, 7.4, 15.4, 15.5_

- [x] 3. CallController state machine (single source of truth)
  Owns `CallPhase` (Idle/Connecting/Ringing/Connected/Failed), the active/incoming `CallMetadata`, the single-call guard, the Outbound_No_Answer_Timeout timer, ws subscriptions, and idempotent teardown keyed by `callId`. Backs Properties 1 and 4.

  - [x] 3.1 Implement the `CallController` store, phases, and ws subscriptions (`web/src/call/call-controller.ts`)
    - Define `CallPhase`, `CallMetadata`, `CallControllerState` and a `createStore<CallControllerState>` (`web/src/state.ts`)
    - `start()`/`stop()` wire `ws.ts` `subscribe` for `call_event`, `call_cancelled`, and `ws_connected`
    - Map `WebRtcState`→`CallPhase` (`connecting`→Connecting, `connected`→Connected, `failed`→Failed, `disconnected`→Idle)
    - Surface `error` message keys for UI; expose `setMuted`/`setVolume` delegating to `WebRtcCallClient`
    - _Requirements: 5.1, 5.2, 5.3, 5.6, 6.1, 6.4, 6.5_

  - [x] 3.2 Implement outbound `placeCall` and inbound `answer` with mic-first ordering
    - `placeCall(from, to)`: `POST /api/calls/make {from,to}`; on `{callId}` establish the WebRTC session (mic acquired at/before `createOffer`); handle 503/no-response-within-10s ("calling service unavailable", return to idle) and 400 (show Calling_API validation error, return to idle)
    - `answer(callId)`: acquire the mic as a **precondition** — on grant, `POST /api/calls/answer/:callId` then establish the WebRTC session with the already-acquired track; on mic denial/unavailable send `POST /api/calls/decline/:callId` and surface `mic-denied`/`no-microphone` (never answered-but-silent)
    - Handle answer 409 (dismiss Incoming_Call_Surface, "call no longer available") and the 15s inbound establishment cap (end attempt, error, idle)
    - Route offer signaling failures via `WebRtcCallClient`: 503 ("media service unavailable"), 504 ("signaling timed out"), no-response-within-server-5s (signaling failure), 404 ("call not found") — each ends the attempt and returns to idle within 1s
    - _Requirements: 2.5, 2.6, 2.7, 2.8, 3.4, 3.5, 3.6, 3.8, 4.1, 4.2, 4.4, 4.5, 11.1, 11.2, 11.3, 11.4, 15.4, 15.5_

  - [x] 3.3 Implement Ringing progress state and the Outbound_No_Answer_Timeout timer
    - Enter Ringing after an outbound call is placed and before the far-party `call_event: connected`; render distinct from Connecting and Connected
    - Play `Ringback` during Ringing where the MediaBridge provides it (delegates to `alerting`)
    - On a terminal `call_event` `failed`/`busy` while Ringing, end the attempt, surface the outcome (no-answer/busy/failed), and return to idle — never decide "no answer" locally on this path
    - Own the Outbound_No_Answer_Timeout timer (default 60s, configurable): start on entering Ringing, clear on any terminal `call_event`/`call_cancelled` or state exit; on expiry send `POST /api/calls/decline/:callId`, tear down the session, and return to idle
    - _Requirements: 5.9, 5.10, 5.11, 5.12_

  - [x] 3.4 Implement inbound presentation, decline, hangup, duration, and DTMF routing
    - On `call_event: connected` for a not-yet-displayed inbound call, present the incoming metadata within 500ms with the caller number or "Unknown caller"; update (never duplicate) the existing surface for a repeat `call_event` on the same `callId`
    - `decline(callId)`: `POST /api/calls/decline/:callId` and dismiss the incoming surface
    - `hangup()`: `POST /api/calls/decline/:callId` (shared route) and tear down; if the request fails or exceeds 5s, still tear down locally, return to idle, and surface "call ended locally"
    - Start the duration timer at zero on entering Connected; stop and clear it on any end; reset controls on return to idle
    - `sendDtmf(digit)`: validate via the DTMF guard (reject non-digits with no signal); prefer in-band via `WebRtcCallClient`; fall back to `POST /api/calls/:callId/dtmf`; on fallback non-success or >5s preserve Connected and surface "DTMF not delivered"
    - _Requirements: 3.1, 3.3, 3.7, 7.3, 7.4, 7.5, 7.6, 8.1, 8.3, 8.4, 8.5_

  - [x] 3.5 Implement the single-call guard and terminal-event teardown (idempotent, callId-keyed)
    - While `phase ∈ {Connecting, Ringing, Connected}`, an inbound `call_event: connected` for a different `callId` triggers `decline(newCallId)` and never opens a second surface; maintain at most one active WebRTC session per tab
    - Disable/reject `placeCall` while a call is active and surface "a call is already in progress"
    - On terminal `call_event` (`completed`/`failed`/`busy`) for the active `callId`, tear down the session, release the mic, return to idle within 2s, and display a call-ended indication citing the cause
    - Ignore events whose `callId` matches neither the active nor a displayed inbound call; ignore duplicate terminal events for an already-torn-down call; ignore `blocked_call` events with no state change and no error (v1 non-goal)
    - Auto-decline a second inbound call (call waiting is a non-goal)
    - _Requirements: 3.3, 9.1, 9.2, 9.3, 9.4, 9.9, 14.1, 14.2, 14.3_

  - [x] 3.6 Implement `call_cancelled`/answered_elsewhere handling and reconnect reconciliation
    - On `call_cancelled` reason `answered_elsewhere` for a displayed inbound call, dismiss the Incoming_Call_Surface within 1s and return to idle; do not re-present that `callId` while held elsewhere
    - `reconcile()`: on `ws_connected` fetch `GET /api/calls/active` within 2s; present the incoming surface for any active call not yet answered/declined; end displayed call state for any `callId` not returned as active (dismisses sibling-tab surfaces answered on the same device)
    - WS lost while Connected: keep playing established audio and show "signaling disconnected"; WS lost while not Connected: terminate the attempt and return to idle
    - _Requirements: 3.2, 3.9, 9.5, 10.1, 10.2, 10.4, 10.5, 11.5, 11.6, 11.7_

  - [ ]* 3.7 Write property test for the single-call invariant (`web/src/call/call-controller.test.ts`)
    - **Property 1: Single-call invariant**
    - Comment tag: `// Feature: web-calling-voice, Property 1: Single-call invariant`
    - Generate `fc.array` sequences of `placeCall`/`inbound(callId)`/`answer`/`terminal(status)`/`cancelled(reason)`; with a mocked `WebRtcCallClient`, assert at most one active session and one surface at every step, and that a second `call_event: connected` for a different `callId` yields `POST /api/calls/decline/:callId` and no second surface
    - **Validates: Requirements 14.1, 14.3**
    - _Requirements: 14.1, 14.3 / Properties: P1_

  - [ ]* 3.8 Write property test for the idempotent-teardown invariant (`web/src/call/call-controller.test.ts`)
    - **Property 4: Idempotent-teardown invariant**
    - Comment tag: `// Feature: web-calling-voice, Property 4: Idempotent-teardown invariant`
    - Generate streams of terminal `call_event`/`call_cancelled` for a given `callId` with duplicates and arbitrary orderings; assert no duplicate surface is ever created and teardown side effects (`track.stop()`, `pc.close()`) run at most once for that call
    - **Validates: Requirements 3.3, 9.3, 9.4, 10.1, 10.2**
    - _Requirements: 3.3, 9.3, 9.4, 10.1, 10.2 / Properties: P4_

  - [ ]* 3.9 Write unit tests for `CallController` status mappings and edge cases (`web/src/call/call-controller.test.ts`)
    - EXAMPLE status-code mappings: make 503/400; offer 503/504/404 and server-5s timeout; answer 409; inbound 15s cap; connecting >30s; ICE fail
    - Mic-first denial on the answer path sends decline (never answered-but-silent); hang-up failure still tears down locally; DTMF fallback failure preserves Connected; unknown-callId and `blocked_call` events ignored; WS-drop-while-Connected keeps audio vs. WS-drop-while-connecting terminates
    - Outbound Ringing terminal (`failed`/`busy`) and Outbound_No_Answer_Timeout expiry both return to idle
    - _Requirements: 2.7, 2.8, 3.6, 3.8, 4.10, 5.4, 5.11, 5.12, 7.5, 8.4, 9.3, 9.9, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

- [x] 4. Checkpoint - Core call engine (client + controller) tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Device lifecycle (browser device as a call target)
  Reuses the login-provisioned `localStorage` `device_id`; adds the unload beacon, reconnect reconciliation, and logout deregistration. Backs Property 5.

  - [x] 5.1 Implement `deviceLifecycle` reuse, unload beacon, and logout (`web/src/call/device-lifecycle.ts`)
    - `ensureRegistered()`: reuse the persisted `localStorage` `device_id`; single-flight so concurrent callers share one in-flight promise; only provision when missing
    - `deregisterOnUnload()`: best-effort `DELETE /api/devices/:deviceId` via `navigator.sendBeacon` (falling back to `fetch(..., { keepalive: true })`) on `pagehide`/unload; correctness defers to the server reaper
    - `logout()`: `POST /api/auth/logout` then clear the persisted `device_id`
    - Disable the Incoming_Call_Surface while no Web_Device is registered
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.9, 1.10, 1.11, 1.12_

  - [x] 5.2 Implement reconnect reconciliation, registration timeout, and retry
    - `reconcileOnReconnect()`: on `ws_connected`, if the persisted `device_id` is still active, reuse it; if reaped/deactivated, re-provision a new Web_Device and update the persisted id
    - Treat registration exceeding 10s or returning an error as failed: retain the session, show "inbound calling unavailable", and expose a manual retry control that re-attempts registration
    - _Requirements: 1.6, 1.7, 1.8, 1.13, 1.14_

  - [ ]* 5.3 Write property test for the registration-uniqueness invariant (`web/src/call/device-lifecycle.test.ts`)
    - **Property 5: Registration-uniqueness invariant**
    - Comment tag: `// Feature: web-calling-voice, Property 5: Registration-uniqueness invariant`
    - Generate sequences of load / transient disconnect+reconnect / reaped-or-not outcomes against a mocked registry; assert at most one active Web_Device per session — reuse whenever the persisted id remains active, provision only after it is reaped/deactivated, never duplicate
    - **Validates: Requirements 1.4, 1.13, 1.14**
    - _Requirements: 1.4, 1.13, 1.14 / Properties: P5_

  - [ ]* 5.4 Write unit tests for device lifecycle edge cases (`web/src/call/device-lifecycle.test.ts`)
    - Registration timeout (>10s) and error responses surface "inbound calling unavailable" with a working retry (Reqs 1.6–1.8); unload beacon uses `sendBeacon` then `keepalive` fallback; logout clears the persisted id
    - _Requirements: 1.6, 1.7, 1.8, 1.9, 1.11_

- [x] 6. Alerting (ringtone / ringback / attention)
  Audible inbound ringtone, outbound ringback, and out-of-tab attention signals, subject to autoplay policy.

  - [x] 6.1 Implement the `alerting` service (`web/src/call/alerting.ts`)
    - `startRingtone()`/`stopRingtone()`: loop while the Incoming_Call_Surface is presented and unanswered; stop on answer/decline/cancel/dismiss (subject to autoplay policy — the visual surface remains the guaranteed alert)
    - `playRingback()`/`stopRingback()`: play MediaBridge-provided ringback during outbound Ringing
    - `raiseAttention(callerLabel)`/`clearAttention()`: change the document title and/or raise a browser Notification where permitted when the tab is hidden/unfocused
    - _Requirements: 5.10, 16.1, 16.2, 16.3_

  - [ ]* 6.2 Write unit tests for alerting (`web/src/call/alerting.test.ts`)
    - Ringtone start/stop tied to inbound presentation; ringback during Ringing; attention raised only when the tab is hidden/unfocused and cleared on dismissal; graceful handling when autoplay/Notification is unavailable
    - _Requirements: 16.1, 16.2, 16.3_

- [x] 7. Call-control icons and token-based call styles
  Design-system integration groundwork the surfaces depend on: SVG icons and token-first CSS (no hardcoded hex).

  - [x] 7.1 Add call-control icons to `web/src/components/icons.tsx`
    - Add `phoneIcon`, `phoneOffIcon`, `micIcon`, `micOffIcon`, `dialpadIcon`, `volumeIcon` built via the existing `iconSvg(children, size)` helper (24px viewBox, `stroke="currentColor"`, `aria-hidden`), replacing the old `📞` glyph usage
    - _Requirements: 19.3_

  - [x] 7.2 Add token-based call surface styles to `web/src/styles/main.css`
    - Add call-surface rules referencing only design tokens (`--md-primary`, `--md-success*`, `--md-error*`, `--md-surface*`, `--md-on-surface*`, `--md-outline*`, `--md-scrim`, `--md-elevation-3/4`, `--md-radius-button/md/lg/full`, 8px `--md-space-*`) — no hardcoded hex
    - Monospace treatment for the duration timer and phone numbers; `--min-touch-target` (48px) on touch/small screens; ringing pulse/attention motion gated by `@media (prefers-reduced-motion: reduce)`
    - _Requirements: 19.1, 19.2, 19.4, 19.5_

- [x] 8. Call UI surfaces
  Three distinct surfaces rendered from `CallController` state, styled entirely with tokens and SVG icons, fully accessible and theme-aware.

  - [x] 8.1 Implement the Dialer popover/sheet (`web/src/components/dialer.tsx`)
    - Destination input (1–20 chars) gated by the E.164 validator (Task 1.1); show validation error and send nothing on invalid/empty/no-selected-from
    - Populate the "from" selector from the **default** `GET /api/numbers` (live-provider numbers only; do NOT pass `?includeOrphaned=true`); if none available, disable outbound calling and show "no calling number configured"
    - On submit call `CallController.placeCall(from, to)`; disable placing while a call is active and indicate a call is in progress
    - Present as a nav-launched popover/modal on desktop (`--md-surface` on `--md-scrim`, `--md-radius-lg`, `--md-elevation-4`) and a full-width sheet on mobile (`≤640px`/`pointer: coarse`); accept a pre-filled destination for "call back"
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.9, 2.10, 14.2, 17.2, 19.1, 19.2, 19.4_

  - [x] 8.2 Implement the IncomingCallSurface modal (`web/src/components/incoming-call-surface.tsx`)
    - Centered modal + `--md-scrim` backdrop (full-width sheet on mobile) showing caller number or "Unknown caller", with Answer (`--md-success`/`.btn-success-outline`) and Decline (`--md-error`/`.btn-danger`)
    - Answer→`CallController.answer(callId)`, Decline→`CallController.decline(callId)`; dismiss on answer/decline/cancel/terminal event
    - Accessibility: announce the incoming call via an ARIA live region and move keyboard focus to the Answer/Decline actions; controls keyboard-operable with accessible names/roles; touch-target sizing on touch/small screens
    - _Requirements: 3.1, 3.4, 3.7, 3.9, 16.1, 18.1, 18.2, 19.1, 19.2, 19.3_

  - [x] 8.3 Implement the InCallSurface compact overlay with expandable keypad (`web/src/components/call-banner.tsx`)
    - Upgrade the passive banner into a compact anchored overlay (`--md-elevation-3`) showing caller/number (monospace), status (Connecting/Ringing/Connected), running duration (monospace `mm:ss`/`hh:mm:ss`), and controls for mute (`micIcon`/`micOffIcon`), hang up (`phoneOffIcon`), keypad toggle (`dialpadIcon`), and volume (`volumeIcon`)
    - Keypad toggle expands the same overlay to reveal the 12-key DTMF grid (`0`–`9`, `*`, `#`) and the volume slider; keys are non-interactive while not Connected and drive `CallController.sendDtmf`; volume drives `setVolume`
    - Mute reflects state within 200ms; show a "could not apply" indicator when the track is ended (Req 6.7); when autoplay blocks playback, surface a gesture-tied resume control that resumes call audio
    - Accessibility: all controls keyboard-operable with accessible names/roles; announce Connecting/Connected/Failed/ended state changes to assistive tech; `--min-touch-target` on touch/small screens; full-width/full-screen on mobile
    - _Requirements: 4.12, 4.13, 5.2, 5.9, 6.1, 6.2, 6.3, 6.4, 6.5, 6.7, 7.1, 7.2, 8.1, 8.2, 8.5, 9.2, 18.2, 18.3, 19.1, 19.2, 19.3, 19.4, 19.5_

  - [ ]* 8.4 Write unit tests for the call surfaces (`web/src/components/dialer.test.ts`, `incoming-call-surface.test.ts`, `call-banner.test.ts`)
    - Dialer validation gating and "from" population/empty state; IncomingCallSurface ARIA live region + focus movement and Answer/Decline wiring (Req 18.1); InCallSurface keypad non-interactive until Connected, mute-state indicator timing, state-change announcements (Req 18.3), autoplay resume control
    - _Requirements: 2.3, 2.10, 6.4, 7.2, 18.1, 18.2, 18.3, 4.12_

- [x] 9. Wire call surfaces and the nav "dial" affordance into the app
  Single `CallController` per tab, rendered by the App shell; a new nav affordance launches the Dialer.

  - [x] 9.1 Instantiate `CallController` and render surfaces from `main.tsx` (`web/src/main.tsx`)
    - Create one `CallController` for the app; add a `useCallState()` hook subscribing components to its store; call `start()` at boot and gate the calling UI on `capabilityGuard`
    - Render the Dialer popover, IncomingCallSurface modal, and InCallSurface overlay as state-driven overlays (never a shared container; at most one InCallSurface per tab); mount the remote `HTMLAudioElement` for playback
    - Wire `deviceLifecycle.ensureRegistered()` / `reconcileOnReconnect()` on `ws_connected`, `deregisterOnUnload()` on `pagehide`, and `logout()` into the existing logout path
    - _Requirements: 1.9, 1.10, 1.11, 1.13, 1.14, 4.8, 14.3, 15.2, 15.3_

  - [x] 9.2 Add the "dial" affordance and call-back entry points (`web/src/components/nav.tsx`, `web/src/components/call-history.tsx`)
    - Add a "dial" nav item (using `phoneIcon` via `iconSvg`, with an `aria-label`) alongside existing nav items that opens the Dialer popover/sheet
    - Add a "call back" affordance from `call-history.tsx` that opens the Dialer pre-filled with the selected number
    - _Requirements: 17.2, 18.2, 19.3_

- [x] 10. Server-side stale Web_Device reaper
  The one new server component plus two small read accessors. Backs Property 6.

  - [x] 10.1 Add broadcaster and orchestrator read accessors
    - `WebSocketBroadcaster` (`src/websocket/broadcaster.ts`): add `isDeviceConnected(deviceId): boolean` and `getConnectedDeviceIds(): Set<string>` reading over the existing private `connections` map (read-only, no new state)
    - `CallOrchestrator` (`src/services/call-orchestrator.ts`): add `getActiveDeviceIds(): Set<string>` returning the set of non-null `answeredByDevice` values across all active calls
    - _Requirements: 13.1, 13.7_

  - [x] 10.2 Implement the `WebDeviceReaper` sweep (`src/services/web-device-reaper.ts`)
    - Compose `DeviceRegistryManager` (`listActiveDevices`, `updateLastSeen`, `deactivateDevice`), the broadcaster accessors, and `orchestrator.getActiveDeviceIds()`; accept `stalenessMs` (default 90_000)
    - While a Web_Device has a live socket, refresh last-seen via `updateLastSeen` (Req 13.1)
    - `sweep()`: deactivate a device only when it is web-registered (`Web Browser` / `skipDeviceLimit`) AND has no live socket AND is stale beyond the staleness interval AND its id is NOT in `getActiveDeviceIds()`; never touch Android/push devices; leave every other device and in-progress call unaffected
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7_

  - [x] 10.3 Wire the reaper at server bootstrap (`src/server.ts`)
    - Construct the `WebDeviceReaper` with the registry, broadcaster, and orchestrator, and schedule `sweep()` on the broadcaster's existing 30s ping cycle (`PING_INTERVAL_MS`) or an equivalent `setInterval`
    - _Requirements: 13.1, 13.2, 13.3_

  - [ ]* 10.4 Write property test for the reaper-safety invariant (`src/services/web-device-reaper.test.ts`)
    - **Property 6: Reaper-safety invariant**
    - Comment tag: `// Feature: web-calling-voice, Property 6: Reaper-safety invariant`
    - Generate device populations (`fc.record` of `{ deviceName, lastSeenAgeMs, hasSocket, inActiveCall }`, web and Android) against mocked registry/broadcaster/orchestrator; assert a device is deactivated only when web-registered AND socket-less AND stale AND not on an active call, and every other device and active call is untouched
    - **Validates: Requirements 13.2, 13.3, 13.4, 13.6, 13.7**
    - _Requirements: 13.2, 13.3, 13.4, 13.6, 13.7 / Properties: P6_

  - [ ]* 10.5 Write unit tests for the reaper and accessors (`src/services/web-device-reaper.test.ts`)
    - Last-seen refresh while a socket is live; the reconnect-in-window race leaves the invariant intact (deactivation does not force-close sockets); broadcaster accessors reflect the `connections` map; orchestrator `getActiveDeviceIds()` excludes null `answeredByDevice`
    - _Requirements: 13.1, 13.5, 13.6, 13.7_

- [x] 11. Checkpoint - Client, surfaces, and reaper integrated
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Integration verification and final wiring
  Verify behaviors that lean on existing, server-covered infrastructure, then a final end-to-end regression pass.

  - [ ]* 12.1 Verify completed web calls appear in call history (`web/src/components/call-history.test.ts`)
    - With a representative example, assert a call placed/received in the Web_Client, once completed, appears via `GET /api/calls/history` consistently with other devices (verification against existing server behavior, not a property test)
    - _Requirements: 17.1_

  - [ ]* 12.2 Verify mid-call far-party release on abrupt browser close (`src/services/call-orchestrator.test.ts`)
    - With a representative example, assert that a MediaBridge `client_disconnected` during an active call routes to `endCall`, releasing the provider/far-party leg (verification of the already-handled path; no new server code)
    - _Requirements: 9.8_

  - [x] 12.3 Final end-to-end wiring and regression pass
    - Confirm the full outbound and inbound flows are wired end to end through `main.tsx` (Dialer→placeCall→offer→answer→Connected; inbound call_event→IncomingCallSurface→answer→Connected→hangup/teardown), the single-call guard, reconnect reconciliation, and the reaper at bootstrap
    - Run the full `vitest` suite and resolve any regressions in the browser client and server modules
    - _Requirements: 3.2, 9.1, 11.7, 14.3_

- [x] 13. Final checkpoint - All components integrated and tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP; they are unit/property/integration tests (never core implementation), and MUST NOT be implemented when running the non-test tasks.
- Each task references specific requirement sub-clauses for traceability, and property-implementing/testing tasks additionally cite the design Correctness Properties (P1–P9).
- Checkpoints ensure incremental validation; ask the user if questions arise.

### Property-Based Testing

- One fast-check property test per correctness property (P1–P9), each running ≥100 iterations, colocated as `*.test.ts` next to the module under test, and tagged with the required comment format, e.g. `// Feature: web-calling-voice, Property 1: Single-call invariant`.
- Properties 1–4 drive the `CallController` (mocked `WebRtcCallClient`/`RTCPeerConnection`/`getUserMedia`) with generated event sequences; Property 5 drives `deviceLifecycle` with a mocked registry; Property 6 drives the reaper sweep over generated device populations; Properties 7–9 are pure-function generators over the validator/formatter/DTMF guard.
- Tooling: Vitest + fast-check (both already `devDependencies`), Vitest `jsdom` environment for browser modules, with lightweight fakes for `RTCPeerConnection`, `RTCDTMFSender`, `getUserMedia`, and `HTMLAudioElement.play()` recording `close()`/`stop()`/`insertDTMF()`.
- Backend call routes and `CallOrchestrator` already have coverage; new tests focus on the browser client, the reaper, and the validators/formatters.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3", "1.5", "1.7", "2.1", "7.1", "7.2", "10.1"] },
    { "id": 1, "tasks": ["1.2", "1.4", "1.6", "1.8", "2.2", "5.1", "6.1", "10.2"] },
    { "id": 2, "tasks": ["2.3", "3.1", "5.2", "6.2", "10.3"] },
    { "id": 3, "tasks": ["2.4", "3.2", "5.3", "10.4"] },
    { "id": 4, "tasks": ["2.5", "5.4", "10.5"] },
    { "id": 5, "tasks": ["2.6", "3.3"] },
    { "id": 6, "tasks": ["3.4"] },
    { "id": 7, "tasks": ["3.5"] },
    { "id": 8, "tasks": ["3.6"] },
    { "id": 9, "tasks": ["3.7"] },
    { "id": 10, "tasks": ["3.8"] },
    { "id": 11, "tasks": ["3.9"] },
    { "id": 12, "tasks": ["8.1", "8.2", "8.3"] },
    { "id": 13, "tasks": ["8.4", "9.1"] },
    { "id": 14, "tasks": ["9.2", "12.1", "12.2"] },
    { "id": 15, "tasks": ["12.3"] }
  ]
}
```
