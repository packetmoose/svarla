import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { CallController, CallControllerState } from "../call/call-controller";
import { phoneIcon, phoneOffIcon } from "./icons";

/**
 * IncomingCallSurface — the ringing answer/decline modal (Task 8.2).
 *
 * A centered modal over a `--md-scrim` backdrop (a full-width sheet on mobile,
 * per the `.incoming-call-*` rules in `web/src/styles/main.css`) presenting an
 * inbound call awaiting answer/decline. It renders purely from
 * `CallController` state: it is shown exactly when `state.incoming` is
 * non-null and disappears the instant the controller clears it — which the
 * controller does on answer, decline, `call_cancelled`
 * (`answered_elsewhere`), or a terminal `call_event`
 * (`completed`/`failed`/`busy`). The surface therefore never owns dismissal
 * logic of its own; it is a projection of the single source of truth
 * (Requirements 3.1, 3.9).
 *
 * Actions delegate straight to the controller:
 *   - Answer  -> `CallController.answer(callId)`  (Requirement 3.4)
 *   - Decline -> `CallController.decline(callId)` (Requirement 3.7)
 *
 * Accessibility (Requirements 18.1, 18.2):
 *   - The incoming call is announced via an ARIA live region (a visually
 *     hidden `role="status"` / `aria-live="assertive"` node) when the surface
 *     is presented.
 *   - Keyboard focus is moved to the Answer action on presentation so a
 *     keyboard/AT user lands directly on the primary control.
 *   - Both controls are ordinary `<button>`s with explicit accessible names,
 *     making them fully keyboard-operable with correct roles.
 *   - Touch-target sizing on touch/small screens is handled by the
 *     `.incoming-call-actions button` rule under the `--min-touch-target`
 *     media query in `main.css` (Requirement 19.2).
 *
 * Theming/visuals (Requirements 19.1, 19.3): all styling is token-driven via
 * the `.incoming-call-*` classes; Answer uses the success role
 * (`.btn-success-outline`) with the `phoneIcon`, Decline the destructive role
 * (`.btn-danger`) with the `phoneOffIcon` — inline SVG icons, no emoji glyphs.
 */

/** Visually-hidden style for the ARIA live region (no `.sr-only` class exists yet). */
const VISUALLY_HIDDEN = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: "0",
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: "0",
} as const;

/**
 * Subscribe a component to a `CallController` store. Mirrors the small
 * `useCallState()` hook that Task 9.1 wires into `main.tsx`; kept local so this
 * surface renders from live controller state without depending on 9.1 landing
 * first. Re-renders on every store change and unsubscribes on unmount.
 */
function useControllerState(controller: CallController): CallControllerState {
  const [state, setState] = useState<CallControllerState>(() =>
    controller.store.getState()
  );

  useEffect(() => {
    // Sync once on (re)subscribe in case the state changed between the initial
    // render and the effect running, then track subsequent changes.
    setState(controller.store.getState());
    return controller.store.subscribe(setState);
  }, [controller]);

  return state;
}

export interface IncomingCallSurfaceProps {
  controller: CallController;
}

export function IncomingCallSurface({ controller }: IncomingCallSurfaceProps) {
  const state = useControllerState(controller);
  const incoming = state.incoming;

  const answerRef = useRef<HTMLButtonElement>(null);

  // Move keyboard focus to the Answer action whenever a new inbound call is
  // presented (Requirement 18.1). Keyed on the callId so focus is (re)asserted
  // for each distinct incoming call, not on unrelated re-renders.
  const callId = incoming?.callId;
  useEffect(() => {
    if (callId) {
      answerRef.current?.focus();
    }
  }, [callId]);

  if (!incoming) {
    return null;
  }

  const callerLabel = incoming.peerNumber?.trim()
    ? incoming.peerNumber
    : "Unknown caller";

  return (
    <div
      class="incoming-call-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Incoming call"
    >
      {/* ARIA live region: announces the incoming call to assistive tech the
          moment the surface is presented (Requirement 18.1). */}
      <div role="status" aria-live="assertive" style={VISUALLY_HIDDEN}>
        {`Incoming call from ${callerLabel}`}
      </div>

      <div class="incoming-call-surface">
        <div class="incoming-call-avatar" aria-hidden="true">
          {phoneIcon(28)}
        </div>

        <span class="incoming-call-label">Incoming call</span>
        <span class="call-number">{callerLabel}</span>

        <div class="incoming-call-actions">
          <button
            type="button"
            ref={answerRef}
            class="btn btn-success-outline incoming-call-answer"
            aria-label={`Answer call from ${callerLabel}`}
            onClick={() => {
              void controller.answer(incoming.callId);
            }}
          >
            {phoneIcon(18)}
            <span>Answer</span>
          </button>
          <button
            type="button"
            class="btn btn-danger"
            aria-label={`Decline call from ${callerLabel}`}
            onClick={() => {
              void controller.decline(incoming.callId);
            }}
          >
            {phoneOffIcon(18)}
            <span>Decline</span>
          </button>
        </div>
      </div>
    </div>
  );
}
