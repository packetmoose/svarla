import { h } from "preact";
import { useState, useEffect, useMemo } from "preact/hooks";
import { api } from "../api";
import {
  type CallController,
  type CallControllerState,
  CallPhase,
} from "../call/call-controller";
import {
  validateDestination,
  MAX_DESTINATION_LENGTH,
  type DestinationError,
} from "../call/dialer-validation";
import { phoneIcon } from "./icons";

/**
 * Dialer — the outbound-call compose surface.
 *
 * A nav-launched popover/modal on desktop and a full-width sheet on mobile
 * (the responsive behavior is driven entirely by the `.dialer-*` CSS in
 * `main.css`). It lets the user pick an originating "from" number, type a
 * destination, and place a call. It is a *distinct* overlay rendered by the
 * App shell from `CallController` state (Task 9.1 wires it in); it never owns
 * call state itself and delegates placement to `CallController.placeCall`.
 *
 * Behavior (Requirements 2.1-2.5, 2.9, 2.10, 14.2, 17.2, 19.1/19.2/19.4):
 *
 *   - The destination input accepts 1-20 characters and is gated by the shared
 *     E.164 validator (`dialer-validation.ts`). A validation error is shown and
 *     NOTHING is sent on invalid/empty input, or when no "from" is selected
 *     (Requirements 2.2, 2.3).
 *   - The "from" selector is populated from the DEFAULT `GET /api/numbers`
 *     (live-provider numbers only — it does NOT pass `?includeOrphaned=true`,
 *     so orphaned numbers never appear as a call origin). When none are
 *     available, outbound calling is disabled and a "no calling number
 *     configured" message is shown (Requirements 2.4, 2.9).
 *   - Submitting calls `CallController.placeCall(from, to)`. Placing is disabled
 *     while a call is already active and the surface indicates a call is in
 *     progress (Requirements 2.5, 14.2).
 *   - Accepts a pre-filled destination for "call back" from call history /
 *     conversations (Requirement 17.2).
 */

/** A single origin number offered by the "from" selector. */
interface DialerNumber {
  number: string;
  label: string | null;
  isActive: boolean;
}

/** The default `GET /api/numbers` response shape (see `number-routes.ts`). */
interface NumbersResponse {
  numbers: Array<{
    number: string;
    label: string | null;
    isActive: boolean;
  }>;
  defaultNumber: string | null;
}

export interface DialerProps {
  /** The single per-tab call controller. */
  controller: CallController;
  /** Whether the Dialer is open (rendered). */
  open: boolean;
  /** Close the Dialer (dismiss the overlay). */
  onClose: () => void;
  /** Optional destination to pre-fill (e.g. "call back"). */
  prefilledDestination?: string;
}

/** Human-readable copy for each destination validation failure. */
function destinationErrorMessage(error: DestinationError): string {
  switch (error) {
    case "empty":
      return "Enter a number to call";
    case "too-long":
      return `Number must be at most ${MAX_DESTINATION_LENGTH} characters`;
    case "invalid-characters":
      return "Number contains invalid characters";
    case "not-e164":
      return "Enter a valid phone number";
  }
}

export function Dialer({
  controller,
  open,
  onClose,
  prefilledDestination,
}: DialerProps) {
  const [destination, setDestination] = useState("");
  const [from, setFrom] = useState("");
  const [numbers, setNumbers] = useState<DialerNumber[]>([]);
  const [numbersLoaded, setNumbersLoaded] = useState(false);
  // Surfaces a validation error only after a submit attempt, so the field
  // doesn't scold the user before they've tried to place the call.
  const [showValidation, setShowValidation] = useState(false);

  // Subscribe to controller state so the surface reflects whether a call is
  // already active (single-call guard, Requirement 14.2) and any error the
  // controller surfaced from a placement attempt.
  const [callState, setCallState] = useState<CallControllerState>(
    controller.store.getState()
  );
  useEffect(
    () => controller.store.subscribe(setCallState),
    [controller]
  );

  // Load the "from" numbers from the DEFAULT /api/numbers (live-provider only;
  // deliberately no includeOrphaned) when the Dialer opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setNumbersLoaded(false);
    api.get<NumbersResponse>("/api/numbers").then((res) => {
      if (cancelled) return;
      if (res.ok) {
        // Only active numbers can originate a call.
        const available = res.data.numbers
          .filter((n) => n.isActive)
          .map((n) => ({
            number: n.number,
            label: n.label,
            isActive: n.isActive,
          }));
        setNumbers(available);
        // Prefer the account default; otherwise the first available number.
        const def =
          available.find((n) => n.number === res.data.defaultNumber) ??
          available[0];
        setFrom((prev) => (prev && available.some((n) => n.number === prev) ? prev : def?.number ?? ""));
      } else {
        setNumbers([]);
      }
      setNumbersLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Apply a pre-filled destination (e.g. "call back") each time the Dialer is
  // opened with one; reset the validation banner on (re)open.
  useEffect(() => {
    if (!open) return;
    setDestination(prefilledDestination ?? "");
    setShowValidation(false);
  }, [open, prefilledDestination]);

  const validation = useMemo(
    () => validateDestination(destination),
    [destination]
  );

  const callActive = callState.phase !== CallPhase.Idle;
  const hasNumbers = numbers.length > 0;
  const canSubmit = validation.ok && !!from && hasNumbers && !callActive;

  function handleSubmit(e: Event) {
    e.preventDefault();
    setShowValidation(true);
    // Send nothing on invalid/empty input, no selected "from", or while a call
    // is active (Requirements 2.3, 2.5, 14.2).
    if (!validation.ok || !from || !hasNumbers || callActive) return;
    void controller.placeCall(from, validation.e164);
    onClose();
  }

  if (!open) return null;

  const validationMessage =
    showValidation && !validation.ok
      ? destinationErrorMessage(validation.error)
      : null;

  return (
    <div
      class="dialer-overlay"
      role="presentation"
      onClick={onClose}
    >
      <div
        class="dialer-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Place a call"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="dialer-header">
          <h3>Place a call</h3>
          <button
            type="button"
            class="btn-secondary btn-sm"
            onClick={onClose}
            aria-label="Close dialer"
          >
            Close
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <div class="form-group">
            <label htmlFor="dialer-destination">To</label>
            <input
              id="dialer-destination"
              type="tel"
              class="input-field dialer-input"
              value={destination}
              maxLength={MAX_DESTINATION_LENGTH}
              autoComplete="off"
              placeholder="+15551234567"
              onInput={(e) =>
                setDestination((e.target as HTMLInputElement).value)
              }
              aria-invalid={validationMessage ? "true" : undefined}
              aria-describedby={
                validationMessage ? "dialer-destination-error" : undefined
              }
              disabled={callActive}
            />
            {validationMessage && (
              <p
                id="dialer-destination-error"
                class="dialer-error"
                role="alert"
                aria-live="assertive"
              >
                {validationMessage}
              </p>
            )}
          </div>

          <div class="dialer-from">
            <label class="dialer-from-label" htmlFor="dialer-from">
              From
            </label>
            {numbersLoaded && !hasNumbers ? (
              <p class="dialer-empty" role="status" aria-live="polite">
                No calling number configured
              </p>
            ) : (
              <select
                id="dialer-from"
                class="input-field"
                value={from}
                onChange={(e) =>
                  setFrom((e.target as HTMLSelectElement).value)
                }
                disabled={!hasNumbers || callActive}
                aria-label="Call from number"
              >
                {numbers.map((n) => (
                  <option key={n.number} value={n.number}>
                    {n.label ? `${n.label} (${n.number})` : n.number}
                  </option>
                ))}
              </select>
            )}
          </div>

          {callActive && (
            <p class="dialer-empty" role="status" aria-live="polite">
              A call is already in progress
            </p>
          )}

          <div class="dialer-actions">
            <button
              type="submit"
              class="btn dialer-call-btn"
              disabled={!canSubmit}
              aria-label="Place call"
            >
              <span aria-hidden="true">{phoneIcon()}</span>
              Call
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
