/**
 * Destination validation and E.164 normalization for the Dialer.
 *
 * Pure, dependency-free input->output logic that the Dialer uses to gate
 * outbound-call submission: a `POST /api/calls/make` request is issued only
 * when a destination normalizes to a valid E164_Number. Everything else
 * yields a validation error and sends nothing (Requirements 2.1, 2.2, 2.3).
 */

/** A phone number in E.164 form: a leading `+`, then 1-15 digits (no leading zero). */
export type E164Number = string;

/** Machine-readable validation failure reasons surfaced to the Dialer. */
export type DestinationError =
  | "empty"
  | "too-long"
  | "invalid-characters"
  | "not-e164";

/**
 * Discriminated result of validating/normalizing a destination string.
 * `ok: true` carries the normalized E164_Number; `ok: false` carries a reason.
 */
export type DestinationResult =
  | { ok: true; e164: E164Number }
  | { ok: false; error: DestinationError };

/** Maximum length of the raw destination input accepted by the Dialer (Requirement 2.1). */
export const MAX_DESTINATION_LENGTH = 20;

/** Minimum length of the raw destination input accepted by the Dialer (Requirement 2.1). */
export const MIN_DESTINATION_LENGTH = 1;

/**
 * Characters permitted in raw destination input. These are the usual dialing
 * characters (digits, a leading `+`, and common visual separators) that a user
 * may type; separators are stripped during normalization. Any character outside
 * this set makes the input invalid (Requirement 2.3).
 */
const ALLOWED_INPUT = /^[0-9+()\-.\s]+$/;

/** Matches a fully normalized E.164 number: `+`, a non-zero leading digit, then up to 14 more digits. */
const E164_PATTERN = /^\+[1-9]\d{0,14}$/;

/**
 * Validate a raw destination string and normalize it to an E164_Number.
 *
 * The input must be a 1-20 character string containing only allowed dialing
 * characters, and must normalize to a valid E.164 number. Visual separators
 * (spaces, hyphens, parentheses, dots) are removed; a single leading `+` is
 * preserved. Empty input, over-length input, disallowed characters, and any
 * value that does not normalize to E.164 all yield a validation error.
 *
 * @param raw The user-entered destination string.
 * @returns A discriminated result: `{ ok: true, e164 }` or `{ ok: false, error }`.
 */
export function validateDestination(raw: string): DestinationResult {
  const trimmed = raw.trim();

  if (trimmed.length < MIN_DESTINATION_LENGTH) {
    return { ok: false, error: "empty" };
  }

  // Length is measured against the raw (trimmed) input the user supplied,
  // matching the 1-20 character input constraint (Requirement 2.1).
  if (trimmed.length > MAX_DESTINATION_LENGTH) {
    return { ok: false, error: "too-long" };
  }

  if (!ALLOWED_INPUT.test(trimmed)) {
    return { ok: false, error: "invalid-characters" };
  }

  const e164 = normalizeToE164(trimmed);
  if (e164 === null) {
    return { ok: false, error: "not-e164" };
  }

  return { ok: true, e164 };
}

/**
 * Normalize an allowed-character destination string to E.164, or return `null`
 * if it cannot be represented as a valid E.164 number.
 *
 * A single optional leading `+` is preserved (and, when absent, prepended);
 * all other non-digit separators are stripped. Any `+` that is not the leading
 * character makes the value invalid.
 */
function normalizeToE164(input: string): E164Number | null {
  const hasPlus = input.startsWith("+");
  const body = hasPlus ? input.slice(1) : input;

  // A `+` may only appear as the very first character.
  if (body.includes("+")) {
    return null;
  }

  const digits = body.replace(/[()\-.\s]/g, "");
  if (digits.length === 0 || !/^\d+$/.test(digits)) {
    return null;
  }

  const candidate = `+${digits}`;
  return E164_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Helper the Dialer uses to gate submission: returns `true` only when the
 * destination normalizes to a valid E164_Number, so the call request is sent
 * exclusively for inputs that pass validation (Requirements 2.2, 2.3).
 *
 * @param raw The user-entered destination string.
 * @returns Whether the destination is safe to submit.
 */
export function canSubmitDestination(raw: string): boolean {
  return validateDestination(raw).ok;
}
