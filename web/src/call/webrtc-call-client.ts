/**
 * WebRtcCallClient — the browser analog of the Android `WebRtcAudioClientImpl`
 * (`android/app/src/main/kotlin/app/svarla/domain/call/WebRtcAudioClientImpl.kt`).
 *
 * Owns exactly one `RTCPeerConnection` and one local microphone track and
 * drives the WebRTC audio-session lifecycle against the MediaBridge:
 *
 *   getUserMedia -> new RTCPeerConnection -> addTrack -> createOffer ->
 *   setLocalDescription -> (POST offer, handled by the caller) ->
 *   applyAnswer(setRemoteDescription) -> remote-track playback -> Connected.
 *
 * The MediaBridge uses ICE Lite and bundles all ICE candidates into the SDP
 * answer, so this client does NOT perform trickle ICE — applying the answer as
 * the remote description is sufficient (Requirement 4.11). The MediaBridge
 * negotiates a PCM audio codec via SDP; because `RTCPeerConnection` handles the
 * codec through SDP, this client does not special-case it (Requirement 5.8).
 *
 * Task 2.1 implemented the CORE lifecycle: state model, offer creation, answer
 * application, remote-track playback, the Connected transition, and volume.
 * Task 2.2 added mute (`setMuted`), in-band DTMF (`sendDtmf`), idempotent
 * teardown (`close`), and the establishment/connection timers (ICE timeout,
 * connecting cap, and connection-lost detection). Task 2.3 (this iteration)
 * adds the media-inactivity watchdog: `getInboundStats()` reads the
 * `inbound-rtp` counters via `getStats()`, and while Connected the client polls
 * them at intervals not exceeding 1s, exposing the `mediaReceiving` store and
 * failing with `media-inactive` after a continuous 5s with no inbound delta
 * (Requirements 9.6, 9.7).
 *
 * Requirements: 4.1, 4.3, 4.4, 4.6, 4.8, 4.9, 4.11, 4.13, 5.1, 5.3, 5.8,
 * 12.1, 12.2, 12.4.
 */

import { createStore, type Store } from "../state";

/**
 * ICE establishment timeout, measured from the start of ICE gathering. If ICE
 * neither reaches a usable (`connected`/`completed`) nor a terminal (`failed`)
 * state within this window, the session is failed with `ice-timeout`. This is
 * the ICE-specific cap that fires before the coarser connecting cap below
 * (Requirements 4.10, 5.5).
 */
const ICE_TIMEOUT_MS = 20_000;

/**
 * Absolute cap on the `connecting` phase. If the client is still `connecting`
 * beyond this window (for any reason not already caught by the ICE timeout),
 * the session is failed with `connecting-timeout` (Requirement 5.4).
 */
const CONNECTING_CAP_MS = 30_000;

/**
 * Media-inactivity watchdog polling interval. While Connected the client polls
 * `RTCPeerConnection.getStats()` at this cadence and compares the `inbound-rtp`
 * `packetsReceived`/`bytesReceived` counters against the previous snapshot. The
 * interval MUST NOT exceed 1s so the 5s inactivity window is evaluated with
 * adequate resolution (Requirement 9.6).
 */
const WATCHDOG_POLL_MS = 1_000;

/**
 * Continuous inbound-media inactivity, measured from the last observed inbound
 * delta, after which the session is failed with `media-inactive`. This is the
 * last-resort teardown for a remote hangup where ICE remains nominally
 * connected but audio has stopped (Requirement 9.7).
 */
const MEDIA_INACTIVITY_MS = 5_000;

/**
 * The WebRTC connection state. Mirrors the Android `WebRtcState` sealed class:
 * a discriminated union so the failed state can carry a machine-readable
 * reason without a separate field.
 *
 * The mapping to the controller-level `CallPhase` is:
 * `connecting`->Connecting, `connected`->Connected, `failed`->Failed,
 * `disconnected`->Idle.
 */
export type WebRtcState =
  | { kind: "disconnected" }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "failed"; reason: WebRtcFailureReason };

/**
 * Machine-readable failure reasons surfaced on `WebRtcState.failed` so the
 * controller can pick the right user-facing message and end the call
 * (Requirements 5.4, 5.5, 12.4).
 */
export type WebRtcFailureReason =
  /** `getUserMedia` rejected with `NotAllowedError` (user denied the mic). */
  | "mic-denied"
  /** `getUserMedia` rejected with `NotFoundError` (no microphone device). */
  | "no-microphone"
  /** Offer creation / `setLocalDescription` failed. */
  | "offer-failed"
  /** `setRemoteDescription(answer)` threw. */
  | "answer-failed"
  /** ICE gathering/checking exceeded the ICE timeout (Task 2.2). */
  | "ice-timeout"
  /** ICE reached the `failed` state (Task 2.2). */
  | "ice-failed"
  /** Stayed in Connecting beyond the connecting cap (Task 2.2). */
  | "connecting-timeout"
  /** Connectivity was lost after Connected (Task 2.2). */
  | "connection-lost"
  /** Inbound media stopped while Connected (watchdog, Task 2.3). */
  | "media-inactive";

/** Snapshot of `inbound-rtp` counters used by the media-inactivity watchdog. */
export interface InboundStats {
  packetsReceived: number;
  bytesReceived: number;
}

export interface WebRtcCallClientOptions {
  /**
   * ICE servers for the `RTCPeerConnection`. Defaults to `[]` because the
   * MediaBridge uses ICE Lite and advertises its own reachable candidates in
   * the SDP answer; STUN/TURN are an optional enhancement for NAT-restricted
   * deployments (Requirements 12.1, 12.2).
   */
  iceServers?: RTCIceServer[];
  /** The audio element the remote track is attached to for playback. */
  remoteAudio: HTMLAudioElement;
}

export interface WebRtcCallClient {
  /** Observable connection state (mirrors the Android `connectionState` flow). */
  readonly state: Store<WebRtcState>;
  /** True while inbound RTP is arriving; drives the watchdog (Task 2.3). */
  readonly mediaReceiving: Store<boolean>;

  /**
   * Acquire the microphone, build the peer connection, add the local track,
   * create the SDP offer, and set it as the local description. Returns the SDP
   * offer string the caller POSTs to `/api/calls/webrtc/offer`.
   */
  createOffer(): Promise<string>;
  /** Apply the SDP answer as the remote description (ICE Lite, no trickle). */
  applyAnswer(sdpAnswer: string): Promise<void>;
  /** Set the local audio track enabled state; returns the effective mute (Task 2.2). */
  setMuted(muted: boolean): boolean;
  /** Send an in-band DTMF digit; false if no `RTCDTMFSender` is available (Task 2.2). */
  sendDtmf(digit: string): boolean;
  /** Set the remote audio element volume, clamped to `[0,1]`. */
  setVolume(level: number): void;
  /** Snapshot of inbound-rtp stats for the watchdog (Task 2.3). */
  getInboundStats(): Promise<InboundStats | null>;
  /** Stop the local track and close the peer connection. Idempotent (Task 2.2). */
  close(): void;
}

/**
 * A `Store` for a non-object value (the `Store` factory in `state.ts` requires
 * `T extends object`, but the public `WebRtcCallClient` API exposes a
 * `Store<boolean>` for `mediaReceiving`). This adapter wraps the value in an
 * object internally while presenting the plain-value `Store<T>` surface.
 */
function createValueStore<T>(initial: T): Store<T> & { set(value: T): void } {
  const inner = createStore<{ value: T }>({ value: initial });
  return {
    getState: () => inner.getState().value,
    // `setState` on the value store replaces the whole value.
    setState: (partial: Partial<T>) => {
      inner.setState({ value: partial as T });
    },
    subscribe: (listener) => inner.subscribe((s) => listener(s.value)),
    set: (value: T) => inner.setState({ value }),
  };
}

class WebRtcCallClientImpl implements WebRtcCallClient {
  readonly state: Store<WebRtcState>;
  readonly mediaReceiving: Store<boolean>;

  private readonly iceServers: RTCIceServer[];
  private readonly remoteAudio: HTMLAudioElement;

  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private localTrack: MediaStreamTrack | null = null;

  /**
   * Last mute state the client applied. `false` (unmuted) is the initial state
   * because a freshly captured mic track is enabled. Retained so that a mute
   * attempt against an unavailable/ended track can return the effective
   * (unchanged) state (Requirement 6.6, 6.7).
   */
  private muted = false;

  /**
   * Set once `close()` has fully torn down the session. Guards the idempotent
   * teardown so repeated `close()` calls stop the track / close the peer
   * connection at most once (Requirement 8.3 / Property 3).
   */
  private closed = false;

  /**
   * Establishment timers. `iceTimeout` fires `ice-timeout` if ICE never becomes
   * usable/terminal within {@link ICE_TIMEOUT_MS}; `connectingCap` fires
   * `connecting-timeout` if the client is still `connecting` after
   * {@link CONNECTING_CAP_MS}. Both are cleared once the client leaves the
   * `connecting` phase (Connected, Failed, or teardown). Typed as the
   * environment-agnostic return of `setTimeout` (browser `number` vs. Node
   * `Timeout`).
   */
  private iceTimeout: ReturnType<typeof setTimeout> | null = null;
  private connectingCap: ReturnType<typeof setTimeout> | null = null;

  /**
   * Media-inactivity watchdog. `watchdogTimer` is the repeating poll (interval
   * {@link WATCHDOG_POLL_MS}) that runs only while Connected; it is armed on the
   * transition into Connected and cleared on any transition out of it (including
   * teardown). `lastInboundStats` is the previous `getStats()` snapshot used to
   * detect a per-poll delta, and `lastActivityAt` is the timestamp of the last
   * poll at which inbound growth was observed — the anchor from which
   * {@link MEDIA_INACTIVITY_MS} is measured (Requirements 9.6, 9.7).
   */
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastInboundStats: InboundStats | null = null;
  private lastActivityAt = 0;
  /** Guard against overlapping async polls (a `getStats()` outlasting the tick). */
  private watchdogPolling = false;

  private readonly stateStore: Store<WebRtcState> & {
    set(value: WebRtcState): void;
  };
  private readonly mediaReceivingStore: Store<boolean> & {
    set(value: boolean): void;
  };

  /**
   * Backing setter for the state store. `WebRtcState` is a discriminated union,
   * so the whole value is REPLACED (not merged) to avoid a stale `reason`
   * field lingering when transitioning out of the `failed` state.
   */
  private setState(next: WebRtcState): void {
    const prevKind = this.stateStore.getState().kind;

    // The establishment timers (ICE timeout + connecting cap) are only relevant
    // while `connecting`. Clear them on any transition out of `connecting` so a
    // late timer cannot fail an already-Connected or already-torn-down session.
    if (next.kind !== "connecting") {
      this.clearEstablishmentTimers();
    }

    // The media-inactivity watchdog runs only while Connected. Start it on the
    // transition INTO `connected`; stop it on any transition OUT of `connected`
    // (Failed, disconnected, or a re-entry that is not `connected`). This keeps
    // polling bounded to the Connected phase (Requirements 9.6, 9.7).
    if (next.kind === "connected" && prevKind !== "connected") {
      this.startWatchdog();
    } else if (next.kind !== "connected" && prevKind === "connected") {
      this.stopWatchdog();
    }

    this.stateStore.set(next);
  }

  constructor(options: WebRtcCallClientOptions) {
    this.iceServers = options.iceServers ?? [];
    this.remoteAudio = options.remoteAudio;

    this.stateStore = createValueStore<WebRtcState>({ kind: "disconnected" });
    this.state = this.stateStore;
    this.mediaReceivingStore = createValueStore<boolean>(false);
    this.mediaReceiving = this.mediaReceivingStore;
  }

  /**
   * getUserMedia -> RTCPeerConnection -> addTrack -> createOffer ->
   * setLocalDescription. Sets state to `connecting` once mic capture succeeds
   * (Requirement 5.1) and returns the SDP offer string.
   *
   * On failure the state is set to `failed{reason}` with a machine-readable
   * reason: `NotAllowedError`->`mic-denied`, `NotFoundError`->`no-microphone`
   * (Requirement 4.2 / 5.4), and any other offer/local-description failure maps
   * to `offer-failed`. The error is rethrown so the controller can end the
   * call.
   */
  async createOffer(): Promise<string> {
    // Acquire the microphone BEFORE creating the offer (Requirement 4.1). This
    // is the mic-first ordering shared by outbound and inbound (answer) paths:
    // a denied mic fails cleanly rather than establishing a silent session.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const reason = mapGetUserMediaError(err);
      this.setState({ kind: "failed", reason });
      throw err;
    }

    this.localStream = stream;
    const [track] = stream.getAudioTracks();
    this.localTrack = track ?? null;

    // Mic capture succeeded: we are now Connecting (Requirement 5.1).
    this.setState({ kind: "connecting" });

    try {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      this.pc = pc;

      // Add the captured local audio track to enable two-way audio
      // (Requirement 4.3).
      if (this.localTrack) {
        pc.addTrack(this.localTrack, stream);
      }

      // Attach the remote track to the audio element for playback and begin
      // playback when it arrives (Requirement 4.8).
      pc.ontrack = (event: RTCTrackEvent) => {
        this.attachRemoteTrack(event);
      };

      // Drive the Connected transition off ICE connection state
      // (Requirements 4.9, 5.3). `connected`/`completed` mean the ICE+DTLS
      // path is usable. Task 2.2 adds the disconnected/failed handling
      // (`connection-lost`).
      pc.oniceconnectionstatechange = () => {
        this.onIceConnectionStateChange(pc.iceConnectionState);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // `setLocalDescription` starts ICE gathering, so this is the "gather
      // start" the ICE timeout is measured from. Arm the establishment timers
      // now (Requirements 4.10, 5.4, 5.5).
      this.startEstablishmentTimers();

      const sdp = pc.localDescription?.sdp ?? offer.sdp;
      if (!sdp) {
        throw new Error("createOffer produced an empty SDP");
      }
      return sdp;
    } catch (err) {
      this.setState({ kind: "failed", reason: "offer-failed" });
      throw err;
    }
  }

  /**
   * Apply the SDP answer returned by `POST /api/calls/webrtc/offer` as the
   * remote description (Requirement 4.6). The ICE candidates are bundled in the
   * answer by the ICE Lite MediaBridge, so no trickle exchange is required
   * (Requirement 4.11). On failure the state is set to `failed{answer-failed}`
   * (Requirement 4.7) and the error is rethrown.
   */
  async applyAnswer(sdpAnswer: string): Promise<void> {
    const pc = this.pc;
    if (!pc) {
      this.setState({ kind: "failed", reason: "answer-failed" });
      throw new Error("applyAnswer called before createOffer");
    }

    try {
      await pc.setRemoteDescription({ type: "answer", sdp: sdpAnswer });
    } catch (err) {
      this.setState({ kind: "failed", reason: "answer-failed" });
      throw err;
    }
  }

  /**
   * Set the remote audio element volume, clamped to `[0,1]` (Requirement 4.13).
   */
  setVolume(level: number): void {
    const clamped = Number.isFinite(level)
      ? Math.min(1, Math.max(0, level))
      : this.remoteAudio.volume;
    this.remoteAudio.volume = clamped;
  }

  // --- mute / DTMF / teardown (Task 2.2) ---

  /**
   * Toggle the local microphone by setting `MediaStreamTrack.enabled = !muted`
   * (Requirements 6.2, 6.3). The assignment is synchronous, so the effect is
   * immediate — well within the 200ms budget the UI mirrors.
   *
   * If the local audio track is unavailable (never captured) or has ended, the
   * client makes NO change and retains the last known mute state, returning it
   * so the UI can show that the action could not be applied (Requirement 6.7).
   * Otherwise it records and returns the newly applied mute state (which the UI
   * uses to render the muted/unmuted indicator, Requirement 6.6).
   */
  setMuted(muted: boolean): boolean {
    const track = this.localTrack;
    if (!track || track.readyState === "ended") {
      // Track unavailable/ended: retain last state, make no change.
      return this.muted;
    }
    track.enabled = !muted;
    this.muted = muted;
    return this.muted;
  }

  /**
   * Send a single DTMF digit in-band via the audio sender's `RTCDTMFSender`
   * (Requirement 7.3). Returns `false` when no `RTCDTMFSender` is available on
   * the local audio track (e.g. no sender, no track, or the browser did not
   * expose `.dtmf`), signalling the controller to use the
   * `POST /api/calls/:callId/dtmf` fallback (Requirement 7.4).
   *
   * Digit validation lives in the controller / `dtmf-validation` guard; this
   * method only performs the in-band send and reports its availability. It does
   * not throw: an `insertDTMF` failure is treated as "unavailable" so the
   * caller falls back rather than tearing down the call.
   */
  sendDtmf(digit: string): boolean {
    const pc = this.pc;
    if (!pc) {
      return false;
    }
    const sender = pc
      .getSenders()
      .find((s) => s.track?.kind === "audio");
    const dtmf = sender?.dtmf;
    if (!dtmf) {
      return false;
    }
    try {
      dtmf.insertDTMF(digit);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Snapshot the aggregate `inbound-rtp` counters from
   * `RTCPeerConnection.getStats()` (Requirement 9.6). Returns the summed
   * `packetsReceived`/`bytesReceived` across all inbound-rtp reports (there is
   * a single audio stream in v1, but summing is robust to any extra reports),
   * or `null` when there is no peer connection or `getStats()` is unavailable /
   * throws. The watchdog compares successive snapshots to detect inbound
   * growth; a `null` snapshot is treated as "no reading this poll" and does not
   * by itself count as activity.
   */
  async getInboundStats(): Promise<InboundStats | null> {
    const pc = this.pc;
    if (!pc || typeof pc.getStats !== "function") {
      return null;
    }

    let report: RTCStatsReport;
    try {
      report = await pc.getStats();
    } catch {
      return null;
    }

    let sawInbound = false;
    let packetsReceived = 0;
    let bytesReceived = 0;
    report.forEach((entry) => {
      if ((entry as RTCStats).type !== "inbound-rtp") {
        return;
      }
      sawInbound = true;
      const rtp = entry as RTCInboundRtpStreamStats;
      if (typeof rtp.packetsReceived === "number") {
        packetsReceived += rtp.packetsReceived;
      }
      if (typeof rtp.bytesReceived === "number") {
        bytesReceived += rtp.bytesReceived;
      }
    });

    if (!sawInbound) {
      return null;
    }
    return { packetsReceived, bytesReceived };
  }

  /**
   * Tear down the session: clear establishment timers, stop the local track
   * (releasing the microphone), close the `RTCPeerConnection`, and set the
   * state to `disconnected` (Requirements 5.6, 8.3).
   *
   * Idempotent: after the first full teardown the `closed` guard makes repeated
   * calls a no-op, so `track.stop()` / `pc.close()` run at most once
   * (Property 3). Every step is wrapped so a throw in one does not prevent the
   * others from running.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;

    this.clearEstablishmentTimers();
    this.stopWatchdog();

    if (this.localTrack) {
      try {
        this.localTrack.stop();
      } catch {
        /* ignore */
      }
    }
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      }
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        /* ignore */
      }
    }

    this.localTrack = null;
    this.localStream = null;
    this.pc = null;
    this.setState({ kind: "disconnected" });
  }

  // --- internals ---

  /**
   * Attach the received remote track to the provided audio element and start
   * playback (Requirement 4.8). Playback may be blocked by the browser autoplay
   * policy; the returned promise rejection is swallowed here so a blocked
   * autoplay does not surface as an unhandled rejection. The controller/UI is
   * responsible for offering a gesture-tied resume control (Requirement 4.12,
   * handled at the surface layer).
   */
  private attachRemoteTrack(event: RTCTrackEvent): void {
    const [remoteStream] = event.streams;
    this.remoteAudio.srcObject = remoteStream ?? new MediaStream([event.track]);

    const playResult = this.remoteAudio.play();
    if (playResult && typeof playResult.catch === "function") {
      playResult.catch(() => {
        // Autoplay blocked — surfaced as a gesture-tied resume at the UI layer.
      });
    }
  }

  /**
   * Drive the Connected transition. When ICE reaches `connected` or `completed`
   * the two-way path is usable, so we report Connected (Requirements 4.9, 5.3).
   * The `disconnected`/`failed` transitions (`connection-lost`) are added in
   * Task 2.2.
   */
  private onIceConnectionStateChange(iceState: RTCIceConnectionState): void {
    const current = this.state.getState().kind;

    if (iceState === "connected" || iceState === "completed") {
      if (current === "connecting") {
        // Usable ICE+DTLS path: report Connected and let `setState` clear the
        // establishment timers (Requirements 4.9, 5.3).
        this.setState({ kind: "connected" });
      }
      return;
    }

    if (iceState === "failed") {
      // ICE failed outright. While still connecting this is an establishment
      // failure (`ice-failed`, Requirement 5.5); after Connected it means the
      // established path was lost (`connection-lost`).
      if (current === "connecting") {
        this.setState({ kind: "failed", reason: "ice-failed" });
      } else if (current === "connected") {
        this.setState({ kind: "failed", reason: "connection-lost" });
      }
      return;
    }

    if (iceState === "disconnected") {
      // A `disconnected` ICE state after Connected means connectivity was lost.
      // Treat it as `connection-lost` so the controller tears down and cites
      // the loss (Requirement 5.5). `disconnected` can be transient, but v1
      // (matching the Android reference) does not attempt an ICE restart.
      if (current === "connected") {
        this.setState({ kind: "failed", reason: "connection-lost" });
      }
    }
  }

  // --- establishment timers ---

  /**
   * Arm the ICE-timeout and connecting-cap timers. Any previously armed timers
   * are cleared first so re-entry cannot leak a timer. Both fire only while the
   * client is still `connecting`; once Connected/Failed/torn-down they are
   * cleared by {@link setState} / {@link close}.
   */
  private startEstablishmentTimers(): void {
    this.clearEstablishmentTimers();

    this.iceTimeout = setTimeout(() => {
      this.iceTimeout = null;
      if (this.state.getState().kind === "connecting") {
        this.setState({ kind: "failed", reason: "ice-timeout" });
      }
    }, ICE_TIMEOUT_MS);

    this.connectingCap = setTimeout(() => {
      this.connectingCap = null;
      if (this.state.getState().kind === "connecting") {
        this.setState({ kind: "failed", reason: "connecting-timeout" });
      }
    }, CONNECTING_CAP_MS);
  }

  /** Clear both establishment timers if armed. Safe to call repeatedly. */
  private clearEstablishmentTimers(): void {
    if (this.iceTimeout !== null) {
      clearTimeout(this.iceTimeout);
      this.iceTimeout = null;
    }
    if (this.connectingCap !== null) {
      clearTimeout(this.connectingCap);
      this.connectingCap = null;
    }
  }

  // --- media-inactivity watchdog ---

  /**
   * Start the media-inactivity watchdog on entering Connected. Seeds the
   * activity anchor to "now" (so the 5s inactivity window is measured from the
   * Connected transition, not from an arbitrary earlier snapshot), clears any
   * stale baseline, marks media as receiving, and begins polling
   * `getStats()` at {@link WATCHDOG_POLL_MS}. Idempotent: any existing poll is
   * cleared first (Requirements 9.6, 9.7).
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.lastInboundStats = null;
    this.lastActivityAt = now();
    // Optimistically report media as arriving until an inactivity window
    // actually elapses; the UI treats `true` as the healthy state.
    this.mediaReceivingStore.set(true);
    this.watchdogTimer = setInterval(() => {
      void this.pollWatchdog();
    }, WATCHDOG_POLL_MS);
  }

  /**
   * Stop the watchdog poll and reset its baseline. Safe to call repeatedly and
   * when the watchdog was never started. Also resets `mediaReceiving` to
   * `false` since inbound media is no longer being tracked.
   */
  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.lastInboundStats = null;
    this.watchdogPolling = false;
    this.mediaReceivingStore.set(false);
  }

  /**
   * One watchdog tick. Reads the current `inbound-rtp` snapshot and compares it
   * against the previous one: any growth in `packetsReceived`/`bytesReceived`
   * counts as activity, refreshes the anchor, and marks media as receiving.
   * When no growth has been observed for a continuous {@link MEDIA_INACTIVITY_MS}
   * while still Connected, the session is failed with `media-inactive` so the
   * controller tears down and cites loss of media (Requirement 9.7).
   *
   * The `getStats()` call is async; `watchdogPolling` guards against a slow
   * poll overlapping the next tick. A poll that resolves after the watchdog was
   * stopped (state left Connected) is ignored.
   */
  private async pollWatchdog(): Promise<void> {
    if (this.watchdogPolling) {
      return;
    }
    this.watchdogPolling = true;
    try {
      const stats = await this.getInboundStats();

      // The state may have left Connected (or the client torn down) while the
      // async `getStats()` was in flight — if so, this tick is stale.
      if (
        this.watchdogTimer === null ||
        this.state.getState().kind !== "connected"
      ) {
        return;
      }

      if (stats && this.hasInboundGrowth(stats)) {
        this.lastActivityAt = now();
        this.mediaReceivingStore.set(true);
      }
      if (stats) {
        this.lastInboundStats = stats;
      }

      const inactiveFor = now() - this.lastActivityAt;
      const receiving = inactiveFor < MEDIA_INACTIVITY_MS;
      this.mediaReceivingStore.set(receiving);

      if (!receiving) {
        // Continuous inactivity beyond the window while Connected with no
        // termination signal: fail with `media-inactive`. `setState` stops the
        // watchdog as part of leaving Connected (Requirement 9.7).
        this.setState({ kind: "failed", reason: "media-inactive" });
      }
    } finally {
      this.watchdogPolling = false;
    }
  }

  /**
   * True when either inbound counter has grown since the previous snapshot. A
   * missing previous snapshot (the first reading) counts as growth so the
   * anchor advances once inbound stats first appear.
   */
  private hasInboundGrowth(current: InboundStats): boolean {
    const prev = this.lastInboundStats;
    if (!prev) {
      return true;
    }
    return (
      current.packetsReceived > prev.packetsReceived ||
      current.bytesReceived > prev.bytesReceived
    );
  }
}

/**
 * Monotonic-ish current time in milliseconds. Uses `performance.now()` when
 * available (monotonic, immune to wall-clock adjustments) and falls back to
 * `Date.now()` otherwise.
 */
function now(): number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }
  return Date.now();
}

/**
 * Map a `getUserMedia` rejection to a machine-readable failure reason.
 * `NotAllowedError` (permission denied) -> `mic-denied`; `NotFoundError`
 * (no capture device) -> `no-microphone`; anything else is treated as a mic
 * denial for the purpose of ending the call cleanly.
 */
function mapGetUserMediaError(err: unknown): WebRtcFailureReason {
  const name =
    typeof err === "object" && err !== null && "name" in err
      ? String((err as { name: unknown }).name)
      : "";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "no-microphone";
  }
  // NotAllowedError, SecurityError, PermissionDeniedError, and unknowns.
  return "mic-denied";
}

/**
 * Create a `WebRtcCallClient`. Defaults `iceServers` to `[]` (ICE Lite
 * MediaBridge); pass STUN/TURN servers for NAT-restricted deployments.
 */
export function createWebRtcCallClient(
  options: WebRtcCallClientOptions,
): WebRtcCallClient {
  return new WebRtcCallClientImpl(options);
}
