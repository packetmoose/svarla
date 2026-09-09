import { h, Fragment } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import {
  CallPhase,
  CallErrorKey,
  type CallController,
  type CallControllerState,
} from "../call/call-controller";
import { formatDuration } from "../call/duration-format";
import { DTMF_DIGITS } from "../call/dtmf-validation";
import {
  micIcon,
  micOffIcon,
  phoneOffIcon,
  dialpadIcon,
  volumeIcon,
} from "./icons";

/**
 * InCallSurface — the active in-call overlay (Task 8.3), upgraded in place from
 * the former passive `CallBanner`. It is rendered by the App shell from
 * {@link CallController} state (never from its own ws subscriptions) and is the
 * single per-tab in-call surface (Property 1 / Requirement 14).
 *
 * At rest it is a compact anchored overlay (`--md-elevation-3`) showing the
 * caller/number (monospace), the call status (Connecting / Ringing / Connected),
 * the running call duration (monospace `mm:ss` / `hh:mm:ss`), and the controls
 * for mute, hang up, a keypad toggle, and volume. Activating the keypad toggle
 * expands the SAME overlay to reveal the 12-key DTMF grid and the volume slider
 * (Requirements 4.13, 5.2, 5.9, 6.*, 7.1, 7.2, 8.1, 8.2, 8.5, 9.2).
 *
 * Accessibility (Requirements 18.2, 18.3, 19.*): every control is a real
 * keyboard-operable `<button>`/`<input>` with an accessible name; call-state
 * changes (Connecting/Connected/Failed/ended) are announced through an
 * `aria-live` region; the keypad keys are non-interactive until Connected; and
 * the styling is entirely token-driven with SVG icons (no emoji glyphs).
 *
 * The export name (`CallBanner`) is preserved so `main.tsx` (Task 9.1) can
 * mount it as before, but it now takes the `CallController` (and an optional
 * remote `HTMLAudioElement` for the autoplay-resume affordance) as props.
 */
export interface CallBannerProps {
  /** The single per-tab call controller; the surface renders from its store. */
  controller: CallController;
  /**
   * The remote-audio element the call plays through (mounted by `main.tsx`).
   * When the browser autoplay policy blocks playback, the surface offers a
   * gesture-tied resume control that calls `remoteAudio.play()` (Requirement
   * 4.12). Optional so the surface degrades gracefully when it is absent.
   */
  remoteAudio?: HTMLAudioElement | null;
}

/**
 * Human-readable copy for the controller's terminal/error message keys, so a
 * call-ended / failure reason can be announced and shown. Only the keys that
 * are meaningful on the in-call surface are mapped; anything unmapped falls
 * back to a neutral "Call ended" string.
 */
const ERROR_COPY: Partial<Record<string, string>> = {
  [CallErrorKey.MicDenied]: "Microphone access is required",
  [CallErrorKey.NoMicrophone]: "No microphone available",
  [CallErrorKey.ConnectionFailed]: "Call connection failed",
  [CallErrorKey.ServiceUnavailable]: "Calling service unavailable",
  [CallErrorKey.MediaUnavailable]: "Media service unavailable",
  [CallErrorKey.SignalingTimeout]: "Signaling timed out",
  [CallErrorKey.CallNotFound]: "Call not found",
  [CallErrorKey.CallUnavailable]: "Call no longer available",
  [CallErrorKey.CallInProgress]: "A call is already in progress",
  [CallErrorKey.EndedLocally]: "Call ended locally",
  [CallErrorKey.DtmfNotDelivered]: "Touch tone not delivered",
  [CallErrorKey.SignalingDisconnected]: "Signaling disconnected",
  [CallErrorKey.CallFailed]: "Call failed",
  [CallErrorKey.Busy]: "The line was busy",
  [CallErrorKey.NoAnswer]: "No answer",
  [CallErrorKey.CallEnded]: "Call ended",
};

/** Subscribe a component to the controller store and re-render on change. */
function useControllerState(
  controller: CallController,
): CallControllerState {
  const [state, setState] = useState<CallControllerState>(() =>
    controller.store.getState(),
  );
  useEffect(() => {
    // Re-sync in case the state changed between the initial read and subscribe.
    setState(controller.store.getState());
    return controller.store.subscribe(setState);
  }, [controller]);
  return state;
}

/** Present the human-readable phase label for the status line. */
function phaseLabel(phase: CallPhase): string {
  switch (phase) {
    case CallPhase.Connecting:
      return "Connecting";
    case CallPhase.Ringing:
      return "Ringing";
    case CallPhase.Connected:
      return "Connected";
    case CallPhase.Failed:
      return "Call failed";
    default:
      return "";
  }
}

export function CallBanner({ controller, remoteAudio }: CallBannerProps) {
  const state = useControllerState(controller);
  const { phase, call, error } = state;

  const [keypadOpen, setKeypadOpen] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // True when the last mute toggle could not be applied (track ended, Req 6.7).
  const [muteBlocked, setMuteBlocked] = useState(false);
  // True while the browser autoplay policy is holding the remote audio paused.
  const [audioBlocked, setAudioBlocked] = useState(false);

  const connected = phase === CallPhase.Connected;
  const active =
    call !== null &&
    (phase === CallPhase.Connecting ||
      phase === CallPhase.Ringing ||
      phase === CallPhase.Connected);

  // --- running duration timer (Requirements 8.1, 8.2) ---------------------
  //
  // While Connected, tick once a second and compute the elapsed seconds from
  // `CallMetadata.startedAt`. Any exit from Connected clears the interval and
  // resets the displayed duration to zero (Requirement 8.5).
  useEffect(() => {
    if (!connected || !call?.startedAt) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = call.startedAt;
    const compute = () =>
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    compute();
    const timer = window.setInterval(compute, 1000);
    return () => window.clearInterval(timer);
  }, [connected, call?.startedAt]);

  // Collapse the keypad and clear the transient notices whenever the call ends
  // so a fresh call always starts from the compact, clean state.
  useEffect(() => {
    if (!active) {
      setKeypadOpen(false);
      setMuteBlocked(false);
      setAudioBlocked(false);
    }
  }, [active]);

  // --- autoplay-blocked detection (Requirement 4.12) ----------------------
  //
  // The WebRtcCallClient swallows the `play()` rejection, so detect the blocked
  // state here by observing that the remote audio has a source but is paused
  // while the call is active. A poll (rather than a one-shot check) catches the
  // track arriving slightly after Connected.
  useEffect(() => {
    if (!active || !remoteAudio) {
      setAudioBlocked(false);
      return;
    }
    const check = () => {
      setAudioBlocked(Boolean(remoteAudio.srcObject) && remoteAudio.paused);
    };
    check();
    const timer = window.setInterval(check, 500);
    remoteAudio.addEventListener("play", check);
    remoteAudio.addEventListener("pause", check);
    return () => {
      window.clearInterval(timer);
      remoteAudio.removeEventListener("play", check);
      remoteAudio.removeEventListener("pause", check);
    };
  }, [active, remoteAudio]);

  // A live ref to the current call so the mute handler reads the freshest
  // effective mute value the controller wrote back.
  const callRef = useRef(call);
  callRef.current = call;

  if (!active || !call) {
    return null;
  }

  const numberLabel = call.peerNumber?.trim() || "Unknown";
  const statusClass =
    phase === CallPhase.Connecting
      ? "connecting"
      : phase === CallPhase.Ringing
        ? "ringing"
        : phase === CallPhase.Connected
          ? "connected"
          : "";

  // The status line drives the aria-live announcement (Requirement 18.3). The
  // signaling-disconnected error is informational while Connected, so surface
  // it as a notice without changing the status label.
  const statusText = phaseLabel(phase);

  function handleMuteToggle() {
    const current = callRef.current;
    if (!current) return;
    const requested = !current.muted;
    controller.setMuted(requested);
    // The controller reflects the EFFECTIVE mute (unchanged when the track is
    // ended, Requirement 6.7). If it did not move to what we requested, the
    // action could not be applied — surface the indicator.
    const effective = controller.store.getState().call?.muted ?? current.muted;
    setMuteBlocked(effective !== requested);
  }

  function handleVolume(e: Event) {
    const target = e.currentTarget as HTMLInputElement;
    const level = Number(target.value) / 100;
    controller.setVolume(level);
  }

  function handleResume() {
    if (!remoteAudio) return;
    const result = remoteAudio.play();
    if (result && typeof result.then === "function") {
      result.then(() => setAudioBlocked(false)).catch(() => {
        /* still blocked — leave the control in place */
      });
    } else {
      setAudioBlocked(false);
    }
  }

  const volumePercent = Math.round((call.volume ?? 1) * 100);
  const durationText = formatDuration(elapsedSeconds);

  return (
    <section
      class="in-call-surface"
      role="region"
      aria-label="Call in progress"
    >
      <div class="in-call-info">
        <span class="call-number" title={numberLabel}>
          {numberLabel}
        </span>
        <span class={`in-call-status ${statusClass}`}>
          <span class="in-call-status-dot" aria-hidden="true" />
          {/* Live region announces Connecting/Connected/Failed/ended (18.3). */}
          <span role="status" aria-live="polite">
            {statusText}
          </span>
        </span>
        {connected ? (
          <span class="call-duration" aria-label={`Call duration ${durationText}`}>
            {durationText}
          </span>
        ) : null}
      </div>

      {audioBlocked ? (
        <button
          type="button"
          class="btn in-call-resume"
          onClick={handleResume}
        >
          Tap to resume call audio
        </button>
      ) : null}

      {muteBlocked ? (
        <span class="in-call-notice" role="alert">
          Mute could not be applied
        </span>
      ) : null}

      {error === CallErrorKey.SignalingDisconnected ? (
        <span class="in-call-notice" role="status" aria-live="polite">
          {ERROR_COPY[error]}
        </span>
      ) : null}

      {error === CallErrorKey.DtmfNotDelivered ? (
        <span class="in-call-notice" role="status" aria-live="polite">
          {ERROR_COPY[error]}
        </span>
      ) : null}

      <div class="in-call-controls">
        <button
          type="button"
          class={`btn-icon${call.muted ? " active" : ""}`}
          aria-pressed={call.muted}
          aria-label={call.muted ? "Unmute microphone" : "Mute microphone"}
          onClick={handleMuteToggle}
        >
          {call.muted ? micOffIcon() : micIcon()}
        </button>

        <button
          type="button"
          class={`btn-icon${keypadOpen ? " active" : ""}`}
          aria-pressed={keypadOpen}
          aria-expanded={keypadOpen}
          aria-label={keypadOpen ? "Hide keypad" : "Show keypad"}
          onClick={() => setKeypadOpen((open) => !open)}
        >
          {dialpadIcon()}
        </button>

        <span class="in-call-spacer" aria-hidden="true" />

        <button
          type="button"
          class="btn-icon in-call-hangup"
          aria-label="Hang up"
          onClick={() => {
            void controller.hangup();
          }}
        >
          {phoneOffIcon()}
        </button>
      </div>

      {keypadOpen ? (
        <Fragment>
          <div class="in-call-keypad" role="group" aria-label="Dialpad">
            {DTMF_DIGITS.map((digit) => (
              <button
                key={digit}
                type="button"
                class="in-call-key"
                aria-label={`Send ${digit}`}
                disabled={!connected}
                onClick={() => {
                  void controller.sendDtmf(digit);
                }}
              >
                {digit}
              </button>
            ))}
          </div>

          <div class="in-call-volume">
            <span class="in-call-volume-icon" aria-hidden="true">
              {volumeIcon()}
            </span>
            <input
              type="range"
              min={0}
              max={100}
              value={volumePercent}
              aria-label="Call volume"
              onInput={handleVolume}
            />
          </div>
        </Fragment>
      ) : null}
    </section>
  );
}
