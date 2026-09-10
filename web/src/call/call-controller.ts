/**
 * CallController — the call-session state machine and single source of truth
 * for the web calling stack. Preact surfaces (Dialer, IncomingCallSurface,
 * InCallSurface) render from its observable store; they never own call state
 * themselves.
 *
 * The controller owns the observable `CallPhase` (Idle/Connecting/Ringing/
 * Connected/Failed), the active/incoming `CallMetadata`, the single-call
 * guard, the Outbound_No_Answer_Timeout timer, and the `ws.ts` subscriptions
 * (`call_event`, `call_cancelled`, `ws_connected`). It drives a single
 * `WebRtcCallClient` (one `RTCPeerConnection` + one mic track per tab) and
 * reconciles displayed state against `GET /api/calls/active`.
 *
 * This is the Task 3.1 foundation: it establishes the store, the phase model,
 * the `WebRtcState`->`CallPhase` mapping, the ws-subscription wiring skeleton
 * (`start`/`stop`), the user-facing error message keys, and `setMuted`/
 * `setVolume` delegation to the `WebRtcCallClient`. The imperative call flows
 * owned by the later tasks build on it:
 *
 *   - Task 3.2: `placeCall` / `answer` (mic-first ordering).
 *   - Task 3.3: Ringing progress + Outbound_No_Answer_Timeout.
 *   - Task 3.4: inbound presentation, `decline` / `hangup`, duration, DTMF.
 *   - Task 3.6: `call_cancelled`/answered_elsewhere handling, reconnect
 *     reconciliation against `GET /api/calls/active`, and WS-lost handling
 *     (keep audio while Connected; terminate a not-yet-Connected attempt).
 *
 * Task 3.5 (single-call guard + terminal-event teardown, callId-keyed and
 * idempotent) is implemented inline in `onCallEvent`: it auto-declines a second
 * inbound call while busy (Requirements 14.1, 14.3, 3.3), tears down the active
 * call on a terminal `completed`/`failed`/`busy` event within 2s citing the
 * cause (Requirements 9.1, 9.2), and ignores unknown-`callId`/duplicate
 * terminal events (Requirements 9.3, 9.4). `blocked_call` is a distinct ws
 * event type the controller never subscribes to, so it is inherently ignored
 * (Requirement 9.9).
 *
 * Requirements (3.1): 5.1, 5.2, 5.3, 5.6, 6.1, 6.4, 6.5.
 */

import { api } from "../api";
import { createStore, type Store } from "../state";
import {
  createWebRtcCallClient,
  type WebRtcCallClient,
  type WebRtcState,
  type WebRtcFailureReason,
} from "./webrtc-call-client";
import type { Alerting } from "./alerting";
import { isDtmfDigit } from "./dtmf-validation";

/**
 * Client-side cap on `POST /api/calls/make`. If the request neither succeeds
 * nor fails within this window the controller treats the calling service as
 * unavailable, surfaces the service-unavailable message, and returns to idle
 * (Requirement 2.7).
 */
const MAKE_TIMEOUT_MS = 10_000;

/**
 * Client-side cap on `POST /api/calls/webrtc/offer`. The server enforces its
 * own 5s signaling timeout (returning HTTP 504), but the client applies its
 * own 10s deadline so a hung request still ends the attempt (Requirements 4.4,
 * 4.5, 11.3).
 */
const OFFER_TIMEOUT_MS = 10_000;

/**
 * Inbound WebRTC establishment cap. If the answered call has not reached
 * Connected within this window after the user answers, the controller ends the
 * attempt, surfaces an error, and returns to idle (Requirement 3.6). This is a
 * controller-level cap layered above the transport-level ICE/connecting caps in
 * `WebRtcCallClient`.
 */
const INBOUND_ESTABLISH_CAP_MS = 15_000;

/**
 * Client-side cap on the hang-up teardown request
 * (`POST /api/calls/decline/:callId`). If the request neither succeeds nor
 * fails within this window the controller still tears down locally, returns to
 * idle, and surfaces "call ended locally" (Requirement 8.4).
 */
const HANGUP_TIMEOUT_MS = 5_000;

/**
 * Client-side cap on the fallback DTMF request
 * (`POST /api/calls/:callId/dtmf`). If the request neither succeeds nor fails
 * within this window (or returns a non-success response) the controller
 * preserves the Connected state and surfaces "DTMF not delivered"
 * (Requirement 7.5).
 */
const DTMF_TIMEOUT_MS = 5_000;

/**
 * Default {@link CallControllerOptions.outboundNoAnswerTimeoutMs}. The
 * Outbound_No_Answer_Timeout is a client-side safety cap on how long an
 * outbound call may sit in Ringing (far party not yet answered) without a
 * terminal `call_event` before the controller declines it and returns to idle
 * (Requirement 5.12). Suggested default: 60 seconds.
 */
const DEFAULT_OUTBOUND_NO_ANSWER_TIMEOUT_MS = 60_000;

/**
 * Client-side cap on the reconciliation request (`GET /api/calls/active`). The
 * controller must reconcile displayed state against the active-call list within
 * 2s of a (re)connect (Requirements 10.5, 11.7); if the request neither
 * succeeds nor fails within this window the current state is left untouched.
 */
const RECONCILE_TIMEOUT_MS = 2_000;

/**
 * The observable UI-facing call phase. This is the controller-level state the
 * surfaces render from; it is distinct from the transport-level
 * `WebRtcState`. `Ringing` is a controller-only outbound progress state (far
 * party not yet answered) with no `WebRtcState` analog.
 */
export enum CallPhase {
  Idle = "idle",
  Connecting = "connecting",
  /** Outbound only: call placed, far party has not yet answered. */
  Ringing = "ringing",
  Connected = "connected",
  Failed = "failed",
}

/** Per-call data carried alongside the phase. */
export interface CallMetadata {
  callId: string;
  direction: "outbound" | "inbound";
  /** Peer number: `from` for inbound, `to` for outbound. */
  peerNumber?: string;
  /** Originating provider number (outbound). */
  fromNumber?: string;
  /** Epoch ms when the call reached Connected (duration-timer basis). */
  startedAt?: number;
  muted: boolean;
  /** Remote playback volume in `[0,1]`. */
  volume: number;
  /** Machine-readable termination cause, set on an end transition. */
  endedReason?: string;
}

/** The full observable controller state the UI subscribes to. */
export interface CallControllerState {
  phase: CallPhase;
  /** The active/most-recent call (outbound or answered inbound). */
  call: CallMetadata | null;
  /** An inbound call awaiting answer/decline (only meaningful while Idle). */
  incoming: CallMetadata | null;
  /** User-facing message key, or `null` when there is nothing to surface. */
  error: string | null;
  /**
   * A non-fatal diagnostic warning key, or `null`. Distinct from {@link error}
   * because a warning is advisory (the call still proceeds) and must SURVIVE the
   * teardown that a subsequent failure triggers — `error` is overwritten/cleared
   * by `resetToIdle`, but the warning explains WHY that failure happened, so it
   * needs to persist until the next call attempt. See {@link CallWarningKey}.
   */
  warning: string | null;
}

export interface CallController {
  /** The observable store the Preact surfaces render from. */
  readonly store: Store<CallControllerState>;

  /**
   * Place an outbound call: `POST /api/calls/make {from,to}`, then establish
   * the WebRTC session (mic acquired at/before `createOffer`). (Task 3.2)
   */
  placeCall(from: string, to: string): Promise<void>;
  /**
   * Answer an inbound call. The microphone is acquired as a PRECONDITION: on
   * grant, `POST /api/calls/answer/:callId` then establish the WebRTC session
   * with the already-acquired track; on denial/unavailable, decline and
   * surface the mic error (never answered-but-silent). (Task 3.2)
   */
  answer(callId: string): Promise<void>;
  /** `POST /api/calls/decline/:callId`; dismiss the incoming surface. (Task 3.4) */
  decline(callId: string): Promise<void>;
  /**
   * Hang up the active call: `POST /api/calls/decline/:callId` (shared route),
   * then tear down. (Task 3.4)
   */
  hangup(): Promise<void>;
  /**
   * Send a DTMF digit: validate, prefer in-band via `WebRtcCallClient`, fall
   * back to `POST /api/calls/:callId/dtmf`. (Task 3.4)
   */
  sendDtmf(digit: string): Promise<void>;

  /**
   * Whether a live WebRTC session (peer connection + mic track) currently
   * exists — i.e. audio may be flowing. The UI uses this as a hard safety net:
   * a live session MUST always surface a visible in-call indicator, so audio
   * can never flow with no on-screen indication. Independent of `phase` so an
   * unexpected state gap cannot hide the fact that a call is live.
   */
  hasActiveSession(): boolean;

  /** Set mute on the active call, delegating to the `WebRtcCallClient`. */
  setMuted(muted: boolean): void;
  /** Set remote playback volume `[0,1]`, delegating to the `WebRtcCallClient`. */
  setVolume(level: number): void;

  /**
   * Reconcile displayed state against `GET /api/calls/active` (on
   * `ws_connected`). (Task 3.6)
   */
  reconcile(): Promise<void>;

  /**
   * Wire the `ws.ts` subscriptions
   * (`call_event`/`call_cancelled`/`ws_connected`/`ws_disconnected`).
   */
  start(): void;
  /** Tear down subscriptions and any in-flight session. */
  stop(): void;
}

/**
 * User-facing message keys surfaced on `CallControllerState.error`. Kept as a
 * small stable set so the UI can map them to copy (and, later, i18n). The
 * WebRTC failure reasons are translated to these keys via
 * {@link failureReasonToErrorKey} so the controller's error surface is
 * decoupled from the transport-level reason vocabulary.
 */
export const CallErrorKey = {
  /** `getUserMedia` denied — microphone permission required. */
  MicDenied: "mic-denied",
  /** No microphone device available. */
  NoMicrophone: "no-microphone",
  /** WebRTC offer/answer/ICE/media failure — the call could not connect or was lost. */
  ConnectionFailed: "connection-failed",
  /** The calling service (make) was unavailable or did not respond. */
  ServiceUnavailable: "service-unavailable",
  /** The media/signaling service was unavailable. */
  MediaUnavailable: "media-unavailable",
  /** Signaling timed out. */
  SignalingTimeout: "signaling-timeout",
  /** The referenced call was not found. */
  CallNotFound: "call-not-found",
  /** The call is no longer available (answer 409 / already ended). */
  CallUnavailable: "call-unavailable",
  /** A call is already in progress (single-call guard). */
  CallInProgress: "call-in-progress",
  /** The call was ended locally because a teardown request failed. */
  EndedLocally: "call-ended-locally",
  /** A DTMF digit could not be delivered. */
  DtmfNotDelivered: "dtmf-not-delivered",
  /** WS signaling disconnected while the call remained connected. */
  SignalingDisconnected: "signaling-disconnected",
  /** The outbound call was rejected/ended before answer (terminal `failed`). */
  CallFailed: "call-failed",
  /** The far party was busy (terminal `busy` while Ringing). */
  Busy: "busy",
  /**
   * The outbound call was not answered — surfaced when the
   * Outbound_No_Answer_Timeout safety cap elapses in Ringing (Requirement 5.12).
   */
  NoAnswer: "no-answer",
  /**
   * The active call ended normally — surfaced when a terminal `call_event`
   * with status `completed` arrives for the active call and the controller
   * tears down and returns to idle citing the cause (Requirements 9.1, 9.2).
   */
  CallEnded: "call-ended",
} as const;

export type CallErrorKey = (typeof CallErrorKey)[keyof typeof CallErrorKey];

/**
 * Map a transport-level {@link WebRtcFailureReason} to the user-facing
 * {@link CallErrorKey} the UI surfaces. The mic-specific reasons keep their
 * dedicated keys (so the UI can show a permission-oriented message); every
 * other reason collapses to the generic connection-failed key.
 */
export function failureReasonToErrorKey(
  reason: WebRtcFailureReason,
): CallErrorKey {
  switch (reason) {
    case "mic-denied":
      return CallErrorKey.MicDenied;
    case "no-microphone":
      return CallErrorKey.NoMicrophone;
    case "offer-failed":
    case "answer-failed":
    case "ice-timeout":
    case "ice-failed":
    case "connecting-timeout":
    case "connection-lost":
    case "media-inactive":
      return CallErrorKey.ConnectionFailed;
  }
}

/**
 * Non-fatal diagnostic warning keys surfaced on {@link CallControllerState.warning}.
 * Advisory only — the call still proceeds — so they live in their own vocabulary
 * separate from {@link CallErrorKey} and persist across the teardown that a
 * later failure triggers.
 */
export const CallWarningKey = {
  /**
   * The SDP answer from the server advertised a loopback (127.0.0.1) ICE
   * candidate. Browsers will not pair against a loopback remote candidate, so
   * the call will almost certainly fail to connect. This is a dev
   * misconfiguration hint: the MediaBridge `PUBLIC_IP` must be an address the
   * browser can reach (the host's LAN IP), not `127.0.0.1`, when the MediaBridge
   * runs in a container / on another host.
   */
  LoopbackIceCandidate: "loopback-ice-candidate",
} as const;

export type CallWarningKey = (typeof CallWarningKey)[keyof typeof CallWarningKey];

/**
 * True when an SDP answer advertises a loopback (127.0.0.1) ICE candidate.
 * Matches the address on an `a=candidate` line or the media/session connection
 * line (`c=IN IP4 127.0.0.1`), rather than a bare substring, to avoid false
 * positives from unrelated fields.
 */
export function sdpHasLoopbackCandidate(sdp: string): boolean {
  return /^a=candidate:\S+ \S+ \S+ \S+ 127\.0\.0\.1 /im.test(sdp) ||
    /^c=IN IP4 127\.0\.0\.1\b/im.test(sdp);
}

/**
 * The `call_event` payload as broadcast by the server over `ws.ts`
 * (`{ callId, status, from?, digit? }`). Terminal statuses are
 * `completed`/`failed`/`busy`; `connected` marks the two-way session live for
 * the active call and presents the surface for an inbound call.
 */
export interface CallEventData {
  callId?: string;
  status?: string;
  from?: string;
  digit?: string;
}

/**
 * The `call_cancelled` payload (`{ callId, reason }`). The `answered_elsewhere`
 * reason means another device on the same account answered a displayed inbound
 * call (Task 3.6).
 */
export interface CallCancelledData {
  callId?: string;
  reason?: string;
}

/** The subset of the singleton `ws.ts` client the controller depends on. */
export interface CallWebSocket {
  subscribe(event: string, handler: (data: unknown) => void): () => void;
}

export interface CallControllerOptions {
  /** The singleton WebSocket client (`initWebSocket()` result). */
  ws: CallWebSocket;
  /**
   * The audio element the remote track plays through. Passed to the
   * `WebRtcCallClient` created per call.
   */
  remoteAudio: HTMLAudioElement;
  /** Alerting service (ringtone/ringback/attention). Optional for tests. */
  alerting?: Alerting;
  /**
   * The Outbound_No_Answer_Timeout in milliseconds — the client-side safety cap
   * on how long an outbound call may remain in Ringing without a terminal
   * `call_event` before the controller declines it and returns to idle
   * (Requirement 5.12). Defaults to
   * {@link DEFAULT_OUTBOUND_NO_ANSWER_TIMEOUT_MS} (60s).
   */
  outboundNoAnswerTimeoutMs?: number;
  /**
   * Factory for the per-call WebRTC client. Injectable so tests can supply a
   * fake without a real `RTCPeerConnection`. Defaults to
   * {@link createWebRtcCallClient}.
   */
  createClient?: (remoteAudio: HTMLAudioElement) => WebRtcCallClient;
}

const INITIAL_STATE: CallControllerState = {
  phase: CallPhase.Idle,
  call: null,
  incoming: null,
  error: null,
  warning: null,
};

class CallControllerImpl implements CallController {
  readonly store: Store<CallControllerState>;

  private readonly ws: CallWebSocket;
  private readonly remoteAudio: HTMLAudioElement;
  private readonly alerting: Alerting | null;
  private readonly outboundNoAnswerTimeoutMs: number;
  private readonly createClient: (
    remoteAudio: HTMLAudioElement,
  ) => WebRtcCallClient;

  /** The active WebRTC client, or `null` when there is no session. */
  private client: WebRtcCallClient | null = null;
  /** Unsubscribe from the active client's state store, if subscribed. */
  private unsubscribeClientState: (() => void) | null = null;

  /** ws.ts subscription teardowns, populated by `start()` and cleared by `stop()`. */
  private wsUnsubscribers: Array<() => void> = [];
  private started = false;

  /**
   * Inbound `callId`s that have been answered/held on another endpoint
   * (an `answered_elsewhere` `call_cancelled` arrived) and must NOT be
   * re-presented while still held there (Requirement 10.2). An entry is added
   * on `answered_elsewhere` and cleared on a subsequent terminal `call_event`
   * for that `callId` (the call has truly ended, so a future offer with the
   * same identifier — unusual, but harmless — could present again).
   */
  private heldElsewhere = new Set<string>();

  /**
   * The inbound WebRTC establishment cap timer (Requirement 3.6), started when
   * an answered call begins establishing and cleared once it reaches Connected,
   * fails, or is torn down. Typed environment-agnostically (browser `number`
   * vs. Node `Timeout`).
   */
  private establishCap: ReturnType<typeof setTimeout> | null = null;

  /**
   * The Outbound_No_Answer_Timeout timer (Requirement 5.12), started on
   * entering Ringing and cleared on any terminal `call_event`/`call_cancelled`
   * or state exit. On expiry the controller declines the still-ringing call and
   * returns to idle. Typed environment-agnostically (browser `number` vs. Node
   * `Timeout`).
   */
  private noAnswerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: CallControllerOptions) {
    this.ws = options.ws;
    this.remoteAudio = options.remoteAudio;
    this.alerting = options.alerting ?? null;
    this.outboundNoAnswerTimeoutMs =
      options.outboundNoAnswerTimeoutMs ??
      DEFAULT_OUTBOUND_NO_ANSWER_TIMEOUT_MS;
    this.createClient =
      options.createClient ??
      ((remoteAudio) => createWebRtcCallClient({ remoteAudio }));

    this.store = createStore<CallControllerState>({ ...INITIAL_STATE });
  }

  // --- lifecycle / subscriptions (Task 3.1) -------------------------------

  /**
   * Wire the `ws.ts` subscriptions. Idempotent: a second `start()` is a no-op
   * while already started. The individual event handlers dispatch to the
   * routing methods below; the full routing logic for each is filled in by
   * Tasks 3.2-3.6.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.wsUnsubscribers.push(
      this.ws.subscribe("call_event", (data) => {
        this.onCallEvent(data as CallEventData);
      }),
    );
    this.wsUnsubscribers.push(
      this.ws.subscribe("call_cancelled", (data) => {
        this.onCallCancelled(data as CallCancelledData);
      }),
    );
    this.wsUnsubscribers.push(
      this.ws.subscribe("ws_connected", () => {
        this.onWsConnected();
      }),
    );
    this.wsUnsubscribers.push(
      this.ws.subscribe("ws_disconnected", () => {
        this.onWsDisconnected();
      }),
    );
  }

  /**
   * Tear down subscriptions and any in-flight session. Idempotent. Closing the
   * client stops the mic track and closes the peer connection (Requirement
   * 5.6); teardown is safe to call repeatedly.
   */
  stop(): void {
    for (const unsub of this.wsUnsubscribers) {
      try {
        unsub();
      } catch {
        /* ignore */
      }
    }
    this.wsUnsubscribers = [];
    this.started = false;
    this.heldElsewhere.clear();

    this.teardownClient();
  }

  // --- mute / volume delegation (Task 3.1) --------------------------------

  /**
   * Set mute on the active call, delegating to the `WebRtcCallClient`
   * (`track.enabled = !muted`, Requirements 6.1, 6.2). The client returns the
   * effective mute state actually applied — if the local track is
   * unavailable/ended it retains the last state and makes no change
   * (Requirement 6.7); the controller reflects that effective value in
   * `CallMetadata.muted` so the UI shows the true state (Requirement 6.4).
   */
  setMuted(muted: boolean): void {
    const client = this.client;
    const call = this.store.getState().call;
    if (!client || !call) return;

    const effective = client.setMuted(muted);
    this.patchCall({ muted: effective });
  }

  /**
   * Set the remote playback volume in `[0,1]`, delegating to the
   * `WebRtcCallClient` (Requirement 6.5). The requested level is clamped by the
   * client; the controller records it on `CallMetadata.volume` for the UI.
   */
  setVolume(level: number): void {
    const client = this.client;
    const call = this.store.getState().call;
    if (!client || !call) return;

    client.setVolume(level);
    const clamped = Number.isFinite(level)
      ? Math.min(1, Math.max(0, level))
      : call.volume;
    this.patchCall({ volume: clamped });
  }

  // --- imperative call flows (Task 3.2) -----------------------------------

  /**
   * Place an outbound call (Requirements 2.5, 2.6, 2.7, 2.8, 4.1, 4.2, 4.4,
   * 4.5, 11.1-11.4, 15.4, 15.5).
   *
   * Flow: `POST /api/calls/make {from,to}` (capped at {@link MAKE_TIMEOUT_MS});
   * on a `{callId}` response, establish the WebRTC session — the mic is
   * acquired at/before `createOffer()` (mic-first ordering) — and exchange the
   * offer with the MediaBridge. Terminal outcomes:
   *
   *   - make 503 / no response within 10s -> ServiceUnavailable, idle (2.7)
   *   - make 400 -> the Calling_API validation error, idle (2.8)
   *   - mic denied / no mic -> the mic error, idle (4.2, 15.4, 15.5)
   *   - offer 503/504/404 / server-5s timeout -> the mapped error, idle (11.*)
   *
   * The single-call guard rejects a placement while a call is already active
   * (Requirement 14 / Task 3.5 surface): the "call in progress" message is set
   * and no request is sent.
   */
  async placeCall(from: string, to: string): Promise<void> {
    if (this.isBusy()) {
      this.store.setState({ error: CallErrorKey.CallInProgress });
      return;
    }

    // Clear any stale error/warning from a prior attempt as we begin a new one.
    this.store.setState({ error: null, warning: null });

    // 1) Place the call on the server, capped at the client-side make timeout.
    let makeResult: Awaited<ReturnType<typeof api.post<MakeCallResponse>>>;
    try {
      makeResult = await withTimeout(
        api.post<MakeCallResponse>("/api/calls/make", { from, to }),
        MAKE_TIMEOUT_MS,
      );
    } catch {
      // No response within 10s — treat as calling-service-unavailable (2.7).
      this.resetToIdle(CallErrorKey.ServiceUnavailable);
      return;
    }

    if (!makeResult.ok) {
      if (makeResult.status === 400) {
        // Surface the Calling_API validation error verbatim where available (2.8).
        this.resetToIdle(
          extractApiError(makeResult.data) ?? CallErrorKey.ServiceUnavailable,
        );
      } else {
        // 503 (and any other non-2xx) -> calling-service-unavailable (2.7).
        this.resetToIdle(CallErrorKey.ServiceUnavailable);
      }
      return;
    }

    const callId = makeResult.data?.callId;
    if (!callId) {
      this.resetToIdle(CallErrorKey.ServiceUnavailable);
      return;
    }

    // 2) Present the active outbound call and establish the WebRTC session
    //    (mic acquired at/before createOffer). A mic denial fails cleanly.
    this.store.setState({
      call: {
        callId,
        direction: "outbound",
        peerNumber: makeResult.data.to ?? to,
        fromNumber: makeResult.data.from ?? from,
        muted: false,
        volume: 1,
      },
      incoming: null,
      error: null,
    });

    await this.establishSession(callId);
  }

  /**
   * Answer an inbound call with mic-first ordering (Requirements 3.4, 3.5, 3.6,
   * 3.8, 4.1, 4.2, 11.1-11.4, 15.4, 15.5).
   *
   * The microphone is acquired as a PRECONDITION of a successful answer: the
   * client is created and `createOffer()` (which does `getUserMedia`) runs
   * BEFORE the answer is committed on the server. This guarantees the surfaced
   * state is either a genuinely connected call or a clean decline — never
   * answered-but-silent:
   *
   *   - mic denied / no mic -> `POST /api/calls/decline/:callId`, surface the
   *     mic error, idle (4.2 / 15.4 / 15.5 / design mic-first ordering)
   *   - mic granted -> `POST /api/calls/answer/:callId`; 409 -> dismiss the
   *     incoming surface + "call no longer available" (3.8); 200 -> exchange the
   *     already-created offer with the MediaBridge and drive to Connected
   *   - not Connected within 15s -> end the attempt, surface an error, idle (3.6)
   */
  async answer(callId: string): Promise<void> {
    if (this.isBusy()) {
      this.store.setState({ error: CallErrorKey.CallInProgress });
      return;
    }

    const incoming = this.store.getState().incoming;

    // Answering dismisses the incoming ringtone (Requirement 16.2).
    this.stopRingtone();

    // Promote the inbound call to the active call up front so the surfaces
    // render the connecting state and teardown is keyed correctly.
    this.store.setState({
      call: {
        callId,
        direction: "inbound",
        peerNumber: incoming?.callId === callId ? incoming.peerNumber : undefined,
        muted: false,
        volume: 1,
      },
      incoming: null,
      error: null,
      warning: null,
    });

    // 1) Mic-first: create the client and acquire the mic via createOffer
    //    BEFORE committing the answer on the server.
    const client = this.createClient(this.remoteAudio);
    this.client = client;
    this.bindClientState(client);

    let sdpOffer: string;
    try {
      sdpOffer = await client.createOffer();
    } catch (err) {
      // Mic denied / unavailable: never leave the call answered-but-silent —
      // decline it and surface the mic error (design mic-first ordering).
      const reason = webRtcReasonFromClient(client);
      void this.postDecline(callId);
      this.resetToIdle(
        reason
          ? failureReasonToErrorKey(reason)
          : CallErrorKey.MicDenied,
      );
      return;
    }

    // 2) Mic granted — commit the answer on the server.
    let answerResult: Awaited<ReturnType<typeof api.post<unknown>>>;
    try {
      answerResult = await api.post(`/api/calls/answer/${callId}`);
    } catch {
      this.resetToIdle(CallErrorKey.CallUnavailable);
      return;
    }

    if (!answerResult.ok) {
      if (answerResult.status === 409) {
        // The call is no longer available (answered/ended elsewhere): dismiss
        // the incoming surface and surface the message (Requirement 3.8).
        this.resetToIdle(CallErrorKey.CallUnavailable);
      } else {
        this.resetToIdle(CallErrorKey.ServiceUnavailable);
      }
      return;
    }

    // 3) Arm the inbound establishment cap (Requirement 3.6), then exchange the
    //    already-created offer with the MediaBridge.
    this.armEstablishCap(callId);
    await this.exchangeOffer(callId, sdpOffer);
  }

  /**
   * Decline an inbound call (Requirement 3.7): send
   * `POST /api/calls/decline/:callId` for the displayed call identifier and
   * dismiss the Incoming_Call_Surface. The visual dismissal happens
   * immediately and unconditionally — declining is a user intent that must not
   * be blocked on the network — while the decline request is best-effort. The
   * ringtone (if playing) is stopped as part of the dismissal (Requirement
   * 16.2).
   *
   * Dismissal only clears the incoming surface when it still matches `callId`,
   * so a stale/duplicate decline never disturbs an unrelated inbound call or an
   * already-active call.
   */
  async decline(callId: string): Promise<void> {
    this.stopRingtone();

    const incoming = this.store.getState().incoming;
    if (incoming && incoming.callId === callId) {
      this.store.setState({ incoming: null });
    }

    await this.postDecline(callId);
  }

  /**
   * Hang up the active call (Requirements 8.3, 8.4). The hang-up shares the
   * decline route: `POST /api/calls/decline/:callId` for the active call
   * identifier, then tear down the WebRTC session and return to idle.
   *
   * The request is capped at {@link HANGUP_TIMEOUT_MS}: if it fails or does not
   * respond within 5s the controller STILL tears down locally, returns to idle,
   * and surfaces "call ended locally" (Requirement 8.4). On a clean hang-up the
   * teardown returns to idle with no error. Teardown is idempotent, so the
   * happy path and the failure path converge on the same idle state.
   */
  async hangup(): Promise<void> {
    const call = this.store.getState().call;
    if (!call) {
      // No active call metadata. Normally a no-op, but if a WebRTC session is
      // somehow still alive (the safety-net path), force a local teardown so
      // the hang-up control can never leave audio flowing.
      if (this.client) {
        this.resetToIdle(CallErrorKey.EndedLocally);
      }
      return;
    }

    const callId = call.callId;

    let endedLocally = false;
    try {
      const result = await withTimeout(
        api.post(`/api/calls/decline/${callId}`),
        HANGUP_TIMEOUT_MS,
      );
      // A non-success response is treated the same as a failure: we still tear
      // down locally and note that the call was ended locally (Requirement 8.4).
      if (!result.ok) {
        endedLocally = true;
      }
    } catch {
      // Request failed or exceeded the 5s cap — tear down locally anyway.
      endedLocally = true;
    }

    // Tear down the session, release the mic, clear the timers, and return to
    // idle (Requirements 8.3, 8.5). Only surface an error on the local-teardown
    // path; a clean hang-up returns to idle silently.
    this.resetToIdle(endedLocally ? CallErrorKey.EndedLocally : null);
  }

  /**
   * Send a DTMF digit (Requirements 7.3, 7.4, 7.5, 7.6). The digit is first
   * validated by the shared DTMF guard: a non-digit is rejected with no signal
   * on either path and no state change (Requirement 7.6). DTMF is only sent
   * while Connected with an active call.
   *
   * Delivery prefers the in-band path via the `WebRtcCallClient`
   * (`RTCDTMFSender.insertDTMF`, Requirement 7.3). When no `RTCDTMFSender` is
   * available the client returns `false` and the controller falls back to
   * `POST /api/calls/:callId/dtmf` (Requirement 7.4). If the fallback returns a
   * non-success response or does not respond within {@link DTMF_TIMEOUT_MS},
   * the Connected state is preserved and a "DTMF not delivered" indication is
   * surfaced (Requirement 7.5). The fallback never tears the call down.
   */
  async sendDtmf(digit: string): Promise<void> {
    // Guard: reject non-digits with no signal on either path (Requirement 7.6).
    if (!isDtmfDigit(digit)) return;

    const state = this.store.getState();
    const call = state.call;
    // Only send DTMF for an active, Connected call.
    if (!call || state.phase !== CallPhase.Connected) return;

    // Prefer the in-band RTCDTMFSender path (Requirement 7.3).
    const client = this.client;
    if (client && client.sendDtmf(digit)) return;

    // Fallback: POST /api/calls/:callId/dtmf, capped at 5s (Requirement 7.4).
    let delivered = false;
    try {
      const result = await withTimeout(
        api.post(`/api/calls/${call.callId}/dtmf`, { digit }),
        DTMF_TIMEOUT_MS,
      );
      delivered = result.ok;
    } catch {
      delivered = false;
    }

    if (!delivered) {
      // Preserve Connected; surface a DTMF-not-delivered indication (7.5). The
      // active call and phase are intentionally left untouched.
      this.store.setState({ error: CallErrorKey.DtmfNotDelivered });
    }
  }

  /**
   * Reconcile displayed call state against the authoritative
   * `GET /api/calls/active` list (Requirements 3.2, 9.5, 10.5, 11.7). Invoked on
   * every `ws_connected` (initial connect and reconnect) so a WS drop, a
   * sibling tab answering on the same device, or missed signaling never leaves
   * the displayed state desynchronized. The request is capped at
   * {@link RECONCILE_TIMEOUT_MS} (2s); a failure/timeout leaves the current
   * state untouched.
   *
   * The reconciliation, given the returned set of active `callId`s:
   *
   *   - PRESENT an Incoming_Call_Surface for any active inbound (`ringing`) call
   *     that is not already displayed, not the active call, and not held on
   *     another endpoint, for which the user has not yet answered/declined
   *     (Requirement 3.2). This recovers an inbound offer whose `call_event` was
   *     missed while the socket was down.
   *   - END the displayed call state when the currently-displayed inbound call
   *     or the active call is NOT in the active list — the call ended or was
   *     answered elsewhere (e.g. a sibling tab on the same device, which is
   *     excluded from the `answered_elsewhere` fan-out), so dismiss the surface
   *     / end the call and return to idle (Requirements 10.5, 11.7). An active
   *     Connected call is only ended when the server no longer lists it.
   */
  async reconcile(): Promise<void> {
    let result: Awaited<ReturnType<typeof api.get<ActiveCallsResponse>>>;
    try {
      result = await withTimeout(
        api.get<ActiveCallsResponse>("/api/calls/active"),
        RECONCILE_TIMEOUT_MS,
      );
    } catch {
      // No response within the 2s cap — leave displayed state untouched rather
      // than tear down a possibly-fine call on a transient reconcile failure.
      return;
    }

    if (!result.ok) return;

    const calls = result.data?.calls ?? [];
    const byId = new Map<string, ActiveCall>();
    for (const call of calls) {
      if (call && call.callId) byId.set(call.callId, call);
    }

    const state = this.store.getState();

    // 1) End the displayed active call if the server no longer lists it
    //    (Requirements 10.5, 11.7). This covers a call answered/ended on a
    //    sibling tab on the same device (excluded from the cancellation fan-out)
    //    as well as any call that ended while signaling was down.
    if (state.call && !byId.has(state.call.callId)) {
      this.resetToIdle(null);
    }

    // 2) End a displayed inbound surface if the server no longer lists it
    //    (answered/declined elsewhere or expired) — dismiss it (Requirement
    //    10.5). Re-read state in case step 1 changed it.
    const afterActive = this.store.getState();
    if (afterActive.incoming && !byId.has(afterActive.incoming.callId)) {
      this.stopRingtone();
      this.store.setState({ incoming: null });
    }

    // 3) Present an Incoming_Call_Surface for any active inbound (`ringing`)
    //    call not yet displayed/handled (Requirement 3.2). Only while Idle with
    //    nothing already displayed, skipping held-elsewhere identifiers. At most
    //    one surface is presented (single-surface invariant).
    const afterDismiss = this.store.getState();
    if (
      afterDismiss.phase === CallPhase.Idle &&
      !afterDismiss.call &&
      !afterDismiss.incoming
    ) {
      for (const call of calls) {
        if (!call || !call.callId) continue;
        // Only inbound, still-ringing calls are presentable; a `connected`
        // active call the server lists is one already in progress elsewhere.
        if (call.status !== "ringing") continue;
        if (this.heldElsewhere.has(call.callId)) continue;
        this.presentIncoming(call.callId, call.from);
        break;
      }
    }
  }

  // --- ws event routing (skeleton — Tasks 3.2-3.6) ------------------------

  /**
   * Route an inbound `call_event`. Task 3.1 wires the subscription and defines
   * the routing seam; the inbound presentation (Task 3.4), single-call guard
   * (Task 3.5), and Ringing/terminal handling (Tasks 3.3/3.5) fill in the body.
   */
  private onCallEvent(data: CallEventData): void {
    // --- Task 3.4: inbound presentation -----------------------------------
    //
    // An inbound-offer `call_event` whose `callId` matches neither the active
    // call nor a currently-displayed inbound call is an inbound call being
    // offered to this Web_Device: present the Incoming_Call_Surface within
    // 500ms with the caller number (or "Unknown caller" when absent),
    // Requirement 3.1. An inbound offer is signaled with status `ringing` (the
    // canonical unanswered-inbound status shared with the Android client and
    // the `GET /api/calls/active` reconcile contract). `connected` is still
    // accepted here for backward compatibility, but only when it does not match
    // the active call (a `connected` for the active call is the outbound/active
    // answer path handled further below). A repeat inbound event for an ALREADY-displayed inbound
    // `callId` updates that surface in place rather than opening a second one
    // (Requirement 3.3). This slice deliberately handles ONLY presentation of a
    // not-yet-displayed / already-displayed inbound offer while Idle — the
    // single-call guard for a DIFFERENT inbound `callId` while a call is active,
    // and the general terminal teardown, are Task 3.5.
    if ((data.status === "ringing" || data.status === "connected") && data.callId) {
      const s = this.store.getState();
      const active = s.call;

      // If this event belongs to the active call, it is not a new inbound
      // offer — leave it to the outbound/active handling below. (A `ringing`
      // status never applies to the active call in this client; only inbound
      // offers use it, so this guard only ever fires for a stray `connected`.)
      const isActiveCall = active?.callId === data.callId;
      if (!isActiveCall) {
        const displayed = s.incoming;
        if (displayed && displayed.callId === data.callId) {
          // Repeat event for the already-displayed inbound call: UPDATE the
          // existing surface (never duplicate it), Requirement 3.3. Refresh the
          // caller number if the event now carries one.
          const peerNumber = data.from ?? displayed.peerNumber;
          this.store.setState({
            incoming: { ...displayed, peerNumber },
          });
          return;
        }

        // A not-yet-displayed inbound offer. Present it only while Idle (with no
        // active call and no other inbound displayed) AND only when the call is
        // not currently held on another endpoint. While a `callId` is held
        // elsewhere (an `answered_elsewhere` cancellation arrived and no
        // subsequent terminal `call_event`), the surface must NOT be re-opened
        // for it (Requirement 10.2) — a repeat/late `connected` offer for that
        // identifier is dropped without a state change.
        if (!active && !displayed && !this.heldElsewhere.has(data.callId)) {
          this.presentIncoming(data.callId, data.from);
          return;
        }

        // Held-elsewhere (or otherwise not presentable): consume without opening
        // a surface. Falling through to `autoDeclineSecondInbound` for a
        // held-elsewhere call would be wrong (there is no local call to protect
        // and the call is already handled elsewhere), so return here.
        if (this.heldElsewhere.has(data.callId)) {
          return;
        }

        // --- Task 3.5: single-call guard (Requirements 14.1, 14.3, 3.3) -----
        //
        // A `connected` event for a DIFFERENT inbound `callId` arrives while a
        // call is already active (Connecting/Ringing/Connected) or while another
        // inbound call is already displayed. Call waiting is a v1 non-goal, so
        // the second call is auto-declined (`POST /api/calls/decline/:callId`)
        // and NO second In_Call_Surface / Incoming_Call_Surface is opened,
        // preserving at most one active WebRTC session and one surface per tab.
        // The active call and the already-displayed inbound surface are left
        // untouched.
        this.autoDeclineSecondInbound(data.callId);
        return;
      }
    }

    // --- active-call routing (Tasks 3.3 + 3.5) ----------------------------
    //
    // From here on we route `call_event`s that concern the ACTIVE call. Any
    // event whose `callId` matches neither the active call nor a displayed
    // inbound call is ignored, leaving state unchanged (Requirement 9.3): the
    // inbound-presentation / single-call-guard slice above already consumed
    // every event addressed to an inbound `callId` (present, update, or
    // auto-decline), so an event that reaches here without matching the active
    // call is a stray/unknown identifier — including a duplicate terminal event
    // for an already-torn-down call (we are back in Idle with no active call,
    // Requirement 9.4).
    const state = this.store.getState();
    const active = state.call;
    if (!active || !data.callId || data.callId !== active.callId) {
      // A terminal `call_event` for a `callId` held on another endpoint means
      // that call has truly ended everywhere: drop the held-elsewhere guard so
      // the identifier is no longer suppressed (Requirement 10.2 only holds
      // WHILE the call is held). No surface exists for it, so there is no other
      // state to change (Requirement 10.1).
      if (
        data.callId &&
        (data.status === "completed" ||
          data.status === "failed" ||
          data.status === "busy")
      ) {
        this.heldElsewhere.delete(data.callId);
      }
      return;
    }

    const status = data.status;

    // --- Task 3.5: terminal teardown for the active call ------------------
    //
    // A terminal `call_event` (`completed`/`failed`/`busy`) for the ACTIVE
    // `callId`, in ANY phase (Connecting/Ringing/Connected), tears down the
    // WebRTC session, releases the mic, and returns to idle within 2s while
    // displaying a call-ended indication that cites the cause (Requirements
    // 9.1, 9.2). Teardown is idempotent and callId-keyed: `resetToIdle` clears
    // the active call, so any duplicate terminal event that follows no longer
    // matches an active `callId` and is ignored above (Requirements 9.3, 9.4)
    // — the underlying `WebRtcCallClient.close()` is itself idempotent, so the
    // mic stop / peer-connection close run at most once.
    if (status === "completed" || status === "failed" || status === "busy") {
      this.clearNoAnswerTimer();
      this.resetToIdle(terminalStatusToErrorKey(status));
      return;
    }

    // Far party answered: advance to Connected. This is meaningful for an
    // outbound call progressing Ringing/Connecting -> Connected; the transport
    // `connected` may also arrive independently (handled in `applyWebRtcState`),
    // and both paths are idempotent — `clearNoAnswerTimer`/`stopRingback` are
    // safe when inactive and `setPhase` no-ops if already Connected.
    if (status === "connected") {
      this.clearNoAnswerTimer();
      this.stopRingback();
      if (
        state.phase === CallPhase.Ringing ||
        state.phase === CallPhase.Connecting
      ) {
        const startedAt = active.startedAt ?? Date.now();
        this.patchCall({ startedAt });
        this.setPhase(CallPhase.Connected);
      }
      return;
    }

    // Any other status for the active call carries no state change (e.g. a
    // `blocked_call` is a distinct ws event type never routed here at all —
    // the controller only subscribes to `call_event`/`call_cancelled`/
    // `ws_connected`, so `blocked_call` is inherently ignored, Requirement 9.9).
  }

  /**
   * Auto-decline a second inbound call while the tab is busy (Requirements
   * 14.1, 14.3, 3.3). Call waiting is a v1 non-goal, so a `call_event:
   * connected` for an inbound `callId` other than the active/displayed call is
   * declined via `POST /api/calls/decline/:callId` WITHOUT opening a second
   * surface or disturbing the active session. Best-effort: the decline request
   * failing must not affect the in-progress call.
   */
  private autoDeclineSecondInbound(callId: string): void {
    void this.postDecline(callId);
  }

  /**
   * Route a `call_cancelled` event. Task 3.6 handles `answered_elsewhere`
   * dismissal and other cancellation reasons.
   */
  private onCallCancelled(data: CallCancelledData): void {
    const callId = data.callId;
    if (!callId) return;

    // `answered_elsewhere` means another endpoint on the same account answered
    // this call; the identifier is HELD there and must not be re-presented
    // while held (Requirements 3.9, 10.1, 10.2). Any other cancellation reason
    // (`declined`, `caller_disconnect`, timeout, etc.) is a genuine end of the
    // call — the inbound offer is no longer valid, so dismiss the surface but
    // do NOT hold the identifier (a fresh call could legitimately reuse it).
    const isHeldElsewhere = data.reason === "answered_elsewhere";

    // Remember the call is held elsewhere so a late/duplicate inbound
    // `call_event` for the same identifier does not re-open the surface
    // (Requirement 10.2). Cleared on a subsequent terminal `call_event`.
    if (isHeldElsewhere) {
      this.heldElsewhere.add(callId);
    }

    const s = this.store.getState();

    // Dismiss a displayed inbound surface for this call within 1s (Requirement
    // 10.1). Presentation/dismissal is synchronous, so this is immediate. This
    // is what tears the ringing Incoming_Call_Surface down when the call ends
    // or is declined elsewhere (e.g. this same call was declined on another
    // device, or the caller hung up before anyone answered).
    if (s.incoming && s.incoming.callId === callId) {
      this.stopRingtone();
      this.store.setState({ incoming: null });
    }

    // If the cancelled call is somehow the ACTIVE call (e.g. an in-flight
    // answer that lost the race to another endpoint, or a remote hang-up), end
    // the attempt and return to idle — the call is no longer ours to run.
    if (s.call && s.call.callId === callId) {
      this.resetToIdle(null);
    }
  }

  /**
   * Handle `ws_connected` (initial connect and every reconnect). Task 3.6
   * triggers reconciliation; a WS drop/reconnect must not desynchronize the
   * displayed state.
   */
  private onWsConnected(): void {
    // A (re)connect may have missed signaling while the socket was down, so
    // reconcile displayed state against the authoritative active-call list
    // (Requirements 10.5, 11.7). Best-effort and fire-and-forget.
    void this.reconcile();
  }

  /**
   * Handle a lost `ws.ts` connection (Requirements 11.5, 11.6). The response
   * depends on the current phase:
   *
   *   - Connected: the two-way WebRTC PCM_Audio session is independent of the
   *     signaling socket, so KEEP playing the established call audio and just
   *     surface a signaling-disconnected indication (Requirement 11.5). The
   *     call is not torn down; when the socket reconnects, `reconcile()` re-syncs
   *     displayed state.
   *   - Connecting/Ringing (a call not yet Connected): signaling is required to
   *     finish establishing, so terminate the attempt and return to idle
   *     (Requirement 11.6).
   *   - An inbound offer awaiting answer: dismiss it and return to idle — we can
   *     no longer act on it reliably (also covered by 11.6's "not Connected").
   *   - Idle: nothing to do.
   */
  private onWsDisconnected(): void {
    const state = this.store.getState();

    if (state.phase === CallPhase.Connected) {
      // Keep the established audio; only mark signaling as disconnected.
      this.store.setState({ error: CallErrorKey.SignalingDisconnected });
      return;
    }

    // A call still being set up (Connecting/Ringing) cannot proceed without
    // signaling: terminate the attempt and return to idle (Requirement 11.6).
    if (
      state.phase === CallPhase.Connecting ||
      state.phase === CallPhase.Ringing
    ) {
      this.resetToIdle(CallErrorKey.ConnectionFailed);
      return;
    }

    // An inbound offer awaiting answer/decline can no longer be acted upon
    // reliably while signaling is down: dismiss it and return to idle.
    if (state.incoming) {
      this.resetToIdle(null);
    }
  }

  // --- WebRtcState -> CallPhase mapping (Task 3.1) ------------------------

  /**
   * Subscribe to a WebRTC client's state store and map each `WebRtcState` to a
   * `CallPhase` transition. Called when a session is established (Tasks
   * 3.2/3.4). The mapping (Requirements 5.1, 5.2, 5.3, 5.6):
   *
   *   connecting  -> Connecting
   *   connected   -> Connected (records `startedAt` for the duration timer)
   *   failed      -> Failed (surfaces the mapped error key)
   *   disconnected-> Idle (resting state after teardown)
   *
   * A late `connected` while the controller is in `Ringing` also advances to
   * `Connected`. The controller never regresses `Connected`->`Connecting`.
   */
  private bindClientState(client: WebRtcCallClient): void {
    this.applyWebRtcState(client.state.getState());
    this.unsubscribeClientState = client.state.subscribe((state) => {
      this.applyWebRtcState(state);
    });
  }

  /** Apply a single `WebRtcState` to the controller phase (see {@link bindClientState}). */
  private applyWebRtcState(state: WebRtcState): void {
    const current = this.store.getState();
    // Only a live session drives phase from WebRTC state; ignore stray updates
    // once the session has been torn down.
    if (!this.client) return;

    switch (state.kind) {
      case "connecting": {
        // Do not regress from Connected/Ringing back to Connecting.
        if (
          current.phase === CallPhase.Connected ||
          current.phase === CallPhase.Ringing
        ) {
          return;
        }
        this.setPhase(CallPhase.Connecting);
        return;
      }
      case "connected": {
        // Establishment succeeded: clear the inbound establishment cap
        // (Requirement 3.6) and start the duration-timer basis (Requirement 8.1).
        // A transport-level `connected` reaching us while Ringing also ends the
        // Ringing progress state: stop Ringback and clear the
        // Outbound_No_Answer_Timeout safety cap (Requirements 5.10, 5.12).
        this.clearEstablishCap();
        this.clearNoAnswerTimer();
        this.stopRingback();
        const startedAt = current.call?.startedAt ?? Date.now();
        this.patchCall({ startedAt });
        this.setPhase(CallPhase.Connected);
        return;
      }
      case "failed": {
        // A transport-level failure ends the attempt: surface the mapped error,
        // clear the establishment cap, tear down the client (releasing the mic),
        // and return to idle (Requirements 4.5, 4.7, 4.10, 5.5, 5.7).
        this.clearEstablishCap();
        this.store.setState({
          error: failureReasonToErrorKey(state.reason),
        });
        this.patchCall({ endedReason: state.reason });
        this.setPhase(CallPhase.Failed);
        return;
      }
      case "disconnected": {
        // The resting UI state. Teardown/reset to Idle is owned by the
        // terminal-event / teardown paths (Task 3.5); here we only reflect the
        // disconnected transport state without clobbering an in-flight setup.
        if (current.phase === CallPhase.Failed) {
          this.setPhase(CallPhase.Idle);
        }
        return;
      }
    }
  }

  // --- Task 3.2 helpers ---------------------------------------------------

  /**
   * True when a call is in flight (Connecting/Ringing/Connected), used by the
   * single-call guard on `placeCall`/`answer` so a second attempt is rejected
   * rather than opening a second session (Requirement 14).
   */
  private isBusy(): boolean {
    const phase = this.store.getState().phase;
    return (
      phase === CallPhase.Connecting ||
      phase === CallPhase.Ringing ||
      phase === CallPhase.Connected
    );
  }

  /**
   * Establish the WebRTC session for the ACTIVE outbound call: create the
   * client, bind its state, acquire the mic and create the offer, then exchange
   * it with the MediaBridge. A mic denial (or any offer-creation failure) ends
   * the attempt and returns to idle with the mapped error; the offer exchange
   * itself is delegated to {@link exchangeOffer} (Requirements 4.1, 4.2, 4.4).
   */
  private async establishSession(callId: string): Promise<void> {
    const client = this.createClient(this.remoteAudio);
    this.client = client;
    this.bindClientState(client);

    let sdpOffer: string;
    try {
      sdpOffer = await client.createOffer();
    } catch {
      // createOffer already set the client state to failed{reason}; the bound
      // state handler surfaces the error, but the async ordering means we also
      // reset to idle here so a mic denial ends the attempt deterministically.
      const reason = webRtcReasonFromClient(client);
      this.resetToIdle(
        reason ? failureReasonToErrorKey(reason) : CallErrorKey.ConnectionFailed,
      );
      return;
    }

    const exchanged = await this.exchangeOffer(callId, sdpOffer);

    // Outbound: the media leg to the MediaBridge is negotiated, but the far
    // party has not yet answered. Enter the Ringing progress state (distinct
    // from Connecting and Connected, Requirement 5.9) and await the far-party
    // `call_event: connected`. A late transport-level `connected` from the
    // WebRtcCallClient still advances to Connected via `applyWebRtcState`
    // (which never regresses Ringing). If the exchange failed the controller
    // has already reset to idle, so only enter Ringing on success and only
    // while this outbound call is still the active one and not yet Connected.
    if (exchanged) {
      this.enterRinging(callId);
    }
  }

  // --- Task 3.3: Ringing progress + Outbound_No_Answer_Timeout ------------

  /**
   * Enter the outbound Ringing progress state for `callId` (Requirements 5.9,
   * 5.10, 5.12). Ringing means the outbound call's media leg is established but
   * the far party has not yet answered; it is rendered distinct from Connecting
   * and Connected by the surfaces.
   *
   * On entry the controller:
   *   - transitions the phase to Ringing (unless the far party already answered
   *     and drove the phase to Connected, or the attempt already ended),
   *   - delegates Ringback playback to the alerting service, which unmutes the
   *     remote audio element the MediaBridge-mixed Ringback plays through
   *     (Requirement 5.10), and
   *   - starts the Outbound_No_Answer_Timeout safety cap (Requirement 5.12).
   *
   * The far-party `call_event: connected` for this call advances Ringing ->
   * Connected (handled in `onCallEvent`); a terminal `failed`/`busy`
   * `call_event`, a `call_cancelled`, hang-up, or timer expiry all clear the
   * Ringing state and its Ringback/timer.
   */
  private enterRinging(callId: string): void {
    const state = this.store.getState();
    // Guard: only the active outbound call may enter Ringing, and only from a
    // pre-Connected phase (a far-party answer or transport `connected` may have
    // already advanced us; never regress Connected -> Ringing).
    if (
      state.call?.callId !== callId ||
      state.call.direction !== "outbound" ||
      state.phase === CallPhase.Connected ||
      state.phase === CallPhase.Idle ||
      state.phase === CallPhase.Failed
    ) {
      return;
    }

    this.setPhase(CallPhase.Ringing);
    this.startRingback();
    this.startNoAnswerTimer(callId);
  }

  /** Begin Ringback playback via the alerting service (best-effort, Requirement 5.10). */
  private startRingback(): void {
    this.alerting?.playRingback();
  }

  /** Stop Ringback playback via the alerting service (safe to call when inactive). */
  private stopRingback(): void {
    this.alerting?.stopRingback();
  }

  // --- Task 3.4: inbound presentation + ringtone --------------------------

  /**
   * Present the Incoming_Call_Surface for a not-yet-displayed inbound call
   * (Requirement 3.1). The incoming call is recorded on `state.incoming` — the
   * single surface the IncomingCallSurface renders from — with the caller
   * number where the `call_event` provides one and `undefined` when absent (the
   * surface renders "Unknown caller" for the empty case). Presentation is
   * synchronous so the surface appears well within the 500ms budget. The
   * ringtone is started, tied to the presented surface (Requirement 16.1).
   */
  private presentIncoming(callId: string, from?: string): void {
    this.store.setState({
      incoming: {
        callId,
        direction: "inbound",
        peerNumber: from,
        muted: false,
        volume: 1,
      },
      error: null,
    });
    this.startRingtone();
  }

  /** Begin the inbound ringtone via the alerting service (best-effort, Requirement 16.1). */
  private startRingtone(): void {
    this.alerting?.startRingtone();
  }

  /**
   * Stop the inbound ringtone via the alerting service on
   * answer/decline/cancel/dismiss (Requirement 16.2). Safe to call when no
   * ringtone is playing.
   */
  private stopRingtone(): void {
    this.alerting?.stopRingtone();
  }

  /**
   * Start the Outbound_No_Answer_Timeout timer for `callId` (Requirement 5.12).
   * On expiry — only while this same outbound call is still in Ringing (no
   * terminal `call_event` arrived) — the controller sends
   * `POST /api/calls/decline/:callId`, tears down the WebRTC session, surfaces
   * the no-answer outcome, and returns to idle. Any prior timer is cleared
   * first so re-entry never layers two timers.
   */
  private startNoAnswerTimer(callId: string): void {
    this.clearNoAnswerTimer();
    this.noAnswerTimer = setTimeout(() => {
      this.noAnswerTimer = null;
      const state = this.store.getState();
      // Only act if this outbound call is still ringing (no terminal event
      // superseded it). The client never decides "no answer" on the terminal
      // path (5.11); this is the explicit client-side safety cap (5.12).
      if (
        state.call?.callId === callId &&
        state.phase === CallPhase.Ringing
      ) {
        void this.postDecline(callId);
        this.stopRingback();
        this.resetToIdle(CallErrorKey.NoAnswer);
      }
    }, this.outboundNoAnswerTimeoutMs);
  }

  /**
   * Clear the Outbound_No_Answer_Timeout timer if armed. Called on any terminal
   * `call_event`/`call_cancelled`, on entering Connected, and on every teardown
   * so the safety cap never fires against a settled call. Safe to call
   * repeatedly.
   */
  private clearNoAnswerTimer(): void {
    if (this.noAnswerTimer !== null) {
      clearTimeout(this.noAnswerTimer);
      this.noAnswerTimer = null;
    }
  }

  /**
   * Exchange the SDP offer with the MediaBridge via
   * `POST /api/calls/webrtc/offer {sdpOffer,callId}` (capped at
   * {@link OFFER_TIMEOUT_MS}) and apply the returned SDP answer. Signaling
   * failures end the attempt and return to idle within ~1s (Requirements 4.4,
   * 4.6, 11.1-11.4):
   *
   *   - 503 -> MediaUnavailable
   *   - 504 / no response within the client cap -> SignalingTimeout
   *   - 404 -> CallNotFound
   *   - applyAnswer failure -> ConnectionFailed
   */
  private async exchangeOffer(
    callId: string,
    sdpOffer: string,
  ): Promise<boolean> {
    let offerResult: Awaited<ReturnType<typeof api.post<OfferResponse>>>;
    try {
      offerResult = await withTimeout(
        api.post<OfferResponse>("/api/calls/webrtc/offer", {
          sdpOffer,
          callId,
        }),
        OFFER_TIMEOUT_MS,
      );
    } catch {
      // No response within the client cap -> treat as a signaling timeout /
      // failure and end the attempt (Requirements 11.2, 11.3).
      this.resetToIdle(CallErrorKey.SignalingTimeout);
      return false;
    }

    if (!offerResult.ok) {
      this.resetToIdle(offerStatusToErrorKey(offerResult.status));
      return false;
    }

    const sdpAnswer = offerResult.data?.sdpAnswer;
    if (!sdpAnswer) {
      this.resetToIdle(CallErrorKey.ConnectionFailed);
      return false;
    }

    // Apply the answer as the remote description. On failure the client sets
    // failed{answer-failed}; reset to idle deterministically as well (4.7).
    const client = this.client;
    if (!client) {
      this.resetToIdle(CallErrorKey.ConnectionFailed);
      return false;
    }
    try {
      await client.applyAnswer(sdpAnswer);
    } catch {
      this.resetToIdle(CallErrorKey.ConnectionFailed);
      return false;
    }

    // Diagnostic: a loopback (127.0.0.1) ICE candidate in the answer means the
    // browser has no reachable remote candidate to pair against, so the call
    // will almost certainly fail to connect (ICE never completes). Surface a
    // non-fatal warning explaining the likely dev misconfiguration (MediaBridge
    // PUBLIC_IP), but let the call proceed — the warning persists past the
    // teardown that the ensuing ICE failure triggers, so the user sees why the
    // call dropped.
    if (sdpHasLoopbackCandidate(sdpAnswer)) {
      this.store.setState({ warning: CallWarningKey.LoopbackIceCandidate });
    }
    return true;
  }

  /**
   * Arm the inbound establishment cap for `callId` (Requirement 3.6). On expiry
   * — only while the same call is still establishing (not yet Connected) — end
   * the attempt with a connection-failed error and return to idle.
   */
  private armEstablishCap(callId: string): void {
    this.clearEstablishCap();
    this.establishCap = setTimeout(() => {
      this.establishCap = null;
      const state = this.store.getState();
      if (
        state.call?.callId === callId &&
        state.phase !== CallPhase.Connected &&
        state.phase !== CallPhase.Idle
      ) {
        // The call never reached Connected within the cap. End it EVERYWHERE,
        // not just locally: `resetToIdle` tears down our WebRTC client (stops
        // the mic + closes the peer connection), but the server may consider
        // the call answered and keep its media leg alive — leaving the far end
        // able to hear us. Decline the server leg too so no audio can outlive
        // the UI. (Best-effort; local teardown happens regardless.)
        void this.postDecline(callId);
        this.resetToIdle(CallErrorKey.ConnectionFailed);
      }
    }, INBOUND_ESTABLISH_CAP_MS);
  }

  /** Best-effort `POST /api/calls/decline/:callId`, swallowing any error. */
  private async postDecline(callId: string): Promise<void> {
    try {
      await api.post(`/api/calls/decline/${callId}`);
    } catch {
      /* best-effort */
    }
  }

  /**
   * End the current attempt: tear down any client (releasing the mic and
   * closing the peer connection), clear the active/incoming call, surface the
   * given error key, and return to Idle. Idempotent via the client's own
   * idempotent `close()`.
   */
  private resetToIdle(error: string | null): void {
    // Returning to idle dismisses any inbound surface, so stop the ringtone
    // tied to it (Requirement 16.2). Safe to call when none is playing.
    this.stopRingtone();
    this.teardownClient();
    this.store.setState({
      phase: CallPhase.Idle,
      call: null,
      incoming: null,
      error,
      // NOTE: `warning` is intentionally NOT cleared here. A diagnostic warning
      // (e.g. a loopback ICE candidate) explains WHY this teardown is happening,
      // so it must outlive the reset and stay visible until the next call
      // attempt clears it (see `placeCall`/`answer`).
    });
  }

  // --- state helpers ------------------------------------------------------

  /** Set the observable phase without disturbing the rest of the state. */
  private setPhase(phase: CallPhase): void {
    if (this.store.getState().phase === phase) return;
    this.store.setState({ phase });
    // Guard the no-silent-audio invariant on every phase change: if this left a
    // live client with no visible surface, tear the session down.
    this.enforceSessionVisibility();
  }

  /**
   * Patch fields on the active `CallMetadata`. A no-op when there is no active
   * call (e.g. an inbound-only awaiting-answer state), so callers can patch
   * unconditionally.
   */
  private patchCall(partial: Partial<CallMetadata>): void {
    const call = this.store.getState().call;
    if (!call) return;
    this.store.setState({ call: { ...call, ...partial } });
  }

  /** Clear the inbound establishment cap timer if armed. Safe to call repeatedly. */
  private clearEstablishCap(): void {
    if (this.establishCap !== null) {
      clearTimeout(this.establishCap);
      this.establishCap = null;
    }
  }

  /**
   * Whether a live WebRTC session currently exists (see the interface doc).
   * True from the moment the client is created (mic capture / peer connection)
   * until {@link teardownClient} closes it.
   */
  hasActiveSession(): boolean {
    return this.client !== null;
  }

  /**
   * SAFETY INVARIANT: a live WebRTC client must always be reflected by a
   * visible, active call state — audio must NEVER flow with no on-screen
   * indication. This enforces the invariant after a state write: if a client is
   * alive but the state would render no in-call surface (Idle/Failed phase or a
   * null `call`), that is a violation. We recover on the side of safety by
   * tearing the session down (stopping the mic + closing the peer connection),
   * so the failure mode is "call unexpectedly ends" — never "audio with no UI".
   *
   * This is a backstop, not the primary path: legitimate teardowns go through
   * {@link resetToIdle} (which closes the client and clears the state together).
   * The guard only fires if some other path desynchronizes the two.
   */
  private enforceSessionVisibility(): void {
    if (!this.client) return;
    const { phase, call } = this.store.getState();
    const visibleActive =
      call !== null &&
      (phase === CallPhase.Connecting ||
        phase === CallPhase.Ringing ||
        phase === CallPhase.Connected);
    if (!visibleActive) {
      // A client is alive with no visible call surface — close the session so
      // no audio can outlive the UI.
      this.teardownClient();
      // Normalize the store to a clean Idle so the UI is coherent.
      if (this.store.getState().phase !== CallPhase.Idle) {
        this.store.setState({ phase: CallPhase.Idle, call: null });
      }
    }
  }

  /**
   * Close and release the active WebRTC client and its state subscription.
   * Idempotent (the client's own `close()` is idempotent), so it is safe to
   * call from `stop()` and from the terminal/teardown paths (Task 3.5).
   */
  private teardownClient(): void {
    this.clearEstablishCap();
    // Any session teardown exits Ringing: clear the Outbound_No_Answer_Timeout
    // safety cap and stop Ringback (Requirements 5.10, 5.12).
    this.clearNoAnswerTimer();
    this.stopRingback();
    if (this.unsubscribeClientState) {
      try {
        this.unsubscribeClientState();
      } catch {
        /* ignore */
      }
      this.unsubscribeClientState = null;
    }
    if (this.client) {
      try {
        this.client.close();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
  }
}

/** The `POST /api/calls/make` success payload (`{ callId, from, to }`). */
interface MakeCallResponse {
  callId: string;
  from?: string;
  to?: string;
}

/** The `POST /api/calls/webrtc/offer` success payload. */
interface OfferResponse {
  sdpAnswer: string;
  iceCandidates?: unknown;
}

/**
 * A single entry in the `GET /api/calls/active` response used by
 * {@link CallController.reconcile}. `status` is `ringing` (inbound offer not yet
 * answered) or `connected` (a call already in progress). Additional server
 * fields (`to`, `direction`, `providerNumber`, `startedAt`) are ignored here.
 */
interface ActiveCall {
  callId: string;
  status: string;
  from?: string;
}

/** The `GET /api/calls/active` success payload (`{ calls: ActiveCall[] }`). */
interface ActiveCallsResponse {
  calls: ActiveCall[];
}

/**
 * Map an offer-exchange HTTP status to the user-facing error key
 * (Requirements 11.1, 11.2, 11.4): 503 -> media unavailable, 504 -> signaling
 * timed out, 404 -> call not found; any other non-2xx collapses to a generic
 * connection failure.
 */
function offerStatusToErrorKey(status: number): CallErrorKey {
  switch (status) {
    case 503:
      return CallErrorKey.MediaUnavailable;
    case 504:
      return CallErrorKey.SignalingTimeout;
    case 404:
      return CallErrorKey.CallNotFound;
    default:
      return CallErrorKey.ConnectionFailed;
  }
}

/**
 * Map a terminal `call_event` status (`completed`/`failed`/`busy`) for the
 * active call to the user-facing call-ended indication key that cites the
 * termination cause (Requirements 9.1, 9.2, 5.11): `busy` -> the far party was
 * busy, `failed` -> the call failed/was rejected, `completed` -> the call ended
 * normally. This unifies the terminal cause mapping across the Ringing
 * (no-answer/busy/failed) and Connected paths.
 */
function terminalStatusToErrorKey(status: string): CallErrorKey {
  switch (status) {
    case "busy":
      return CallErrorKey.Busy;
    case "failed":
      return CallErrorKey.CallFailed;
    case "completed":
    default:
      return CallErrorKey.CallEnded;
  }
}

/**
 * Extract a human-readable error message from an `api` error payload
 * (`{ error, details? }`), used to surface the Calling_API validation message
 * on a make 400 (Requirement 2.8). Returns `null` when no usable message is
 * present so the caller can fall back to a generic key.
 */
function extractApiError(data: unknown): string | null {
  if (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof (data as { error: unknown }).error === "string"
  ) {
    const message = (data as { error: string }).error.trim();
    return message.length > 0 ? message : null;
  }
  return null;
}

/**
 * Read the machine-readable {@link WebRtcFailureReason} off a client whose
 * state is `failed`, so the controller can map a mic/offer failure to the right
 * user-facing key. Returns `null` when the client is not in a failed state.
 */
function webRtcReasonFromClient(
  client: WebRtcCallClient,
): WebRtcFailureReason | null {
  const state = client.state.getState();
  return state.kind === "failed" ? state.reason : null;
}

/**
 * Race `work` against a `timeoutMs` deadline. If the deadline wins the returned
 * promise rejects; the pending `work` is left to settle on its own. Used to cap
 * the make and offer requests (Requirements 2.7, 4.4/4.5/11.3).
 */
function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`request exceeded ${timeoutMs}ms`));
    }, timeoutMs);

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Create a {@link CallController}. Inject `ws`, the remote `HTMLAudioElement`,
 * and optionally an `alerting` service and a `createClient` factory (the
 * latter for tests).
 */
export function createCallController(
  options: CallControllerOptions,
): CallController {
  return new CallControllerImpl(options);
}
