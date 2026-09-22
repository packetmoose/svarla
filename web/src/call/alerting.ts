/**
 * `alerting` — audible inbound ringtone, outbound ringback, and out-of-tab
 * attention signals for the web calling stack.
 *
 * Three concerns, one small service:
 *
 *   1. Ringtone — an audible loop played while the Incoming_Call_Surface is
 *      presented and the call has not yet been answered or declined
 *      (Requirement 16.1). Stopped on answer/decline/cancel/dismiss
 *      (Requirement 16.2). Browser autoplay policy may suppress it until a user
 *      gesture occurs; the visible Incoming_Call_Surface remains the primary
 *      guaranteed alert, so the ringtone is strictly best-effort and never
 *      throws.
 *
 *   2. Ringback — the outbound-call progress tone. The MediaBridge mixes the
 *      Ringback into the client leg's *received* audio (it arrives in-band on
 *      the WebRTC remote track, played by the `WebRtcCallClient`'s remote audio
 *      element), so this service does not synthesize it. `playRingback` /
 *      `stopRingback` record the Ringing-progress intent and unmute/mute the
 *      remote audio element the received Ringback plays through, where one is
 *      provided (Requirement 5.10).
 *
 *   3. Attention_Signal — a non-audio alert raised when the tab is hidden or
 *      unfocused: a document-title change and, where the user has granted
 *      permission, a browser Notification (Requirement 16.3). Cleared on
 *      dismissal.
 *
 * There is no bundled audio asset, so the ringtone is synthesized with the Web
 * Audio API (a periodic dual-tone burst). This keeps the module dependency-free
 * and avoids shipping/decoding a media file. Every browser interaction is
 * guarded so a missing/blocked API (no `AudioContext`, autoplay suppression, no
 * `Notification`, denied permission) degrades gracefully instead of throwing.
 *
 * Requirements: 5.10, 16.1, 16.2, 16.3.
 */

export interface Alerting {
  /** Play the ringtone loop; subject to autoplay policy (Requirement 16.1). */
  startRingtone(): void;
  /** Stop the ringtone on answer/decline/cancel/dismiss (Requirement 16.2). */
  stopRingtone(): void;
  /** Title change and/or Notification when the tab is hidden/unfocused (Requirement 16.3). */
  raiseAttention(callerLabel: string): void;
  /** Clear the attention signal (restore title, close Notification). */
  clearAttention(): void;
  /** Begin outbound Ringback during the Ringing progress state (Requirement 5.10). */
  playRingback(): void;
  /** Stop outbound Ringback when Ringing ends. */
  stopRingback(): void;
}

export interface AlertingOptions {
  /**
   * The remote audio element the WebRTC received audio (including any
   * MediaBridge-mixed Ringback) plays through. When provided, `playRingback` /
   * `stopRingback` ensure it is audible / muted for the Ringing window. When
   * omitted, ringback state is tracked but no element is toggled (the received
   * Ringback, if any, still plays through whatever element the call client
   * owns).
   */
  remoteAudio?: HTMLAudioElement;
}

/** The two frequencies (Hz) mixed into the synthesized ringtone burst. */
const RINGTONE_TONE_A_HZ = 440;
const RINGTONE_TONE_B_HZ = 480;
/** Ringtone cadence: 2s of tone followed by 4s of silence (repeats). */
const RINGTONE_ON_MS = 2000;
const RINGTONE_CADENCE_MS = 6000;
/** Peak gain for the synthesized ringtone (kept well below clipping). */
const RINGTONE_GAIN = 0.15;
/** Short attack/release (seconds) to avoid audible clicks at burst edges. */
const RINGTONE_RAMP_S = 0.05;

type AudioContextCtor = typeof AudioContext;

/**
 * Resolve an `AudioContext` constructor across browsers, including the older
 * `webkitAudioContext` prefix. Returns `null` when the Web Audio API is
 * unavailable (e.g. jsdom without a shim), so the caller can no-op.
 */
function resolveAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

class AlertingImpl implements Alerting {
  private readonly remoteAudio: HTMLAudioElement | null;

  // --- ringtone (synthesized) ---
  private audioContext: AudioContext | null = null;
  private ringtoneTimer: ReturnType<typeof setInterval> | null = null;
  private ringtoneActive = false;

  // --- ringback ---
  private ringbackActive = false;

  // --- attention ---
  private originalTitle: string | null = null;
  private notification: Notification | null = null;
  private attentionActive = false;

  constructor(options: AlertingOptions = {}) {
    this.remoteAudio = options.remoteAudio ?? null;
  }

  // --- Ringtone -----------------------------------------------------------

  startRingtone(): void {
    // Idempotent: a repeat `call_event` for the same inbound call must not
    // layer a second ringtone loop.
    if (this.ringtoneActive) return;
    this.ringtoneActive = true;

    const ctx = this.ensureAudioContext();
    if (!ctx) return; // Web Audio unavailable — visual surface is the alert.

    // Play the first burst immediately, then repeat on the cadence. Each burst
    // is scheduled independently so a suspended/failed context simply produces
    // no sound rather than throwing.
    this.playRingtoneBurst();
    this.ringtoneTimer = setInterval(() => {
      this.playRingtoneBurst();
    }, RINGTONE_CADENCE_MS);
  }

  stopRingtone(): void {
    if (!this.ringtoneActive) return;
    this.ringtoneActive = false;

    if (this.ringtoneTimer !== null) {
      clearInterval(this.ringtoneTimer);
      this.ringtoneTimer = null;
    }
    // The scheduled oscillators stop themselves; suspend the context so no
    // further audio is produced while the surface is dismissed.
    if (this.audioContext) {
      try {
        void this.audioContext.suspend();
      } catch {
        /* ignore — best-effort */
      }
    }
  }

  /**
   * Lazily create (and, if the browser suspended it pending a gesture, resume)
   * the shared `AudioContext`. Returns `null` when Web Audio is unavailable.
   * A blocked/suspended context does not throw here — playback is best-effort.
   */
  private ensureAudioContext(): AudioContext | null {
    if (this.audioContext) {
      if (this.audioContext.state === "suspended") {
        try {
          void this.audioContext.resume();
        } catch {
          /* ignore — autoplay policy may keep it suspended until a gesture */
        }
      }
      return this.audioContext;
    }

    const Ctor = resolveAudioContextCtor();
    if (!Ctor) return null;

    try {
      this.audioContext = new Ctor();
      return this.audioContext;
    } catch {
      this.audioContext = null;
      return null;
    }
  }

  /**
   * Schedule a single dual-tone ringtone burst on the shared context. All Web
   * Audio calls are guarded: if the context is unavailable or throws, the burst
   * is silently skipped.
   */
  private playRingtoneBurst(): void {
    const ctx = this.audioContext;
    if (!ctx) return;

    try {
      const now = ctx.currentTime;
      const onSeconds = RINGTONE_ON_MS / 1000;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(RINGTONE_GAIN, now + RINGTONE_RAMP_S);
      gain.gain.setValueAtTime(RINGTONE_GAIN, now + onSeconds - RINGTONE_RAMP_S);
      gain.gain.linearRampToValueAtTime(0, now + onSeconds);
      gain.connect(ctx.destination);

      for (const freq of [RINGTONE_TONE_A_HZ, RINGTONE_TONE_B_HZ]) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, now);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + onSeconds);
      }
    } catch {
      /* ignore — best-effort synthesis */
    }
  }

  // --- Ringback -----------------------------------------------------------

  playRingback(): void {
    // The MediaBridge mixes Ringback into the received WebRTC audio, so there
    // is nothing to synthesize here. Record the Ringing-progress intent and,
    // where a remote audio element is provided, ensure it is audible so the
    // received Ringback is heard during Ringing (Requirement 5.10).
    if (this.ringbackActive) return;
    this.ringbackActive = true;

    if (this.remoteAudio) {
      try {
        this.remoteAudio.muted = false;
        const played = this.remoteAudio.play();
        if (played && typeof played.catch === "function") {
          played.catch(() => {
            // Autoplay blocked — the received Ringback resumes with the same
            // gesture-tied resume the call audio uses (Requirement 4.12).
          });
        }
      } catch {
        /* ignore — best-effort */
      }
    }
  }

  stopRingback(): void {
    if (!this.ringbackActive) return;
    this.ringbackActive = false;
    // The remote audio element continues playing the (now connected) call
    // audio, so it is intentionally NOT paused here — only the Ringing-progress
    // intent is cleared. Pausing/teardown of the remote element is owned by the
    // WebRtcCallClient on call end.
  }

  // --- Attention ----------------------------------------------------------

  raiseAttention(callerLabel: string): void {
    // Only raise the attention signal when the tab is actually hidden or
    // unfocused — a visible, focused tab already shows the Incoming_Call_Surface
    // (Requirement 16.3).
    if (!this.isTabInattentive()) return;
    if (this.attentionActive) return;
    this.attentionActive = true;

    const label = callerLabel && callerLabel.trim() ? callerLabel : "Unknown caller";

    // Title change — always available where `document` exists, and the most
    // reliable attention signal.
    if (typeof document !== "undefined") {
      if (this.originalTitle === null) {
        this.originalTitle = document.title;
      }
      document.title = `\u{1F4DE} Incoming call \u2014 ${label}`;
    }

    // Browser Notification — only where the API exists and permission is
    // already granted. Never prompt for permission here (that requires a user
    // gesture and would be intrusive); a denied/default permission simply falls
    // back to the title change.
    this.raiseNotification(label);
  }

  clearAttention(): void {
    if (!this.attentionActive) return;
    this.attentionActive = false;

    if (typeof document !== "undefined" && this.originalTitle !== null) {
      document.title = this.originalTitle;
    }
    this.originalTitle = null;

    if (this.notification) {
      try {
        this.notification.close();
      } catch {
        /* ignore */
      }
      this.notification = null;
    }
  }

  /**
   * Whether the tab is hidden or unfocused (i.e. the user is not currently
   * looking at the calling surface). Uses `document.visibilityState` and
   * `document.hasFocus()`, both guarded for non-DOM environments.
   */
  private isTabInattentive(): boolean {
    if (typeof document === "undefined") return false;
    const hidden = document.visibilityState === "hidden";
    const unfocused =
      typeof document.hasFocus === "function" ? !document.hasFocus() : false;
    return hidden || unfocused;
  }

  /**
   * Raise a browser Notification when the API is present and permission is
   * granted. All access is guarded so an unavailable API or a constructor that
   * throws degrades to the title-change signal.
   */
  private raiseNotification(label: string): void {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;

    try {
      this.notification = new Notification("Incoming call", {
        body: label,
        tag: "svarla-incoming-call",
        renotify: true,
      } as NotificationOptions);
    } catch {
      // Some browsers throw when constructing a Notification outside a service
      // worker; the title change remains the fallback attention signal.
      this.notification = null;
    }
  }
}

/**
 * Create an {@link Alerting} instance. Pass the remote audio element so the
 * received (MediaBridge-mixed) Ringback is unmuted during outbound Ringing.
 */
export function createAlerting(options: AlertingOptions = {}): Alerting {
  return new AlertingImpl(options);
}
