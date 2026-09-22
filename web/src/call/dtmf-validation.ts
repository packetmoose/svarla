/**
 * DTMF digit validation.
 *
 * A DTMF_Digit is a single dual-tone multi-frequency character: one of
 * `0`-`9`, `*`, or `#`. This module provides the shared guard used by both
 * the in-band (RTCDTMFSender) and fallback (POST /api/calls/:callId/dtmf)
 * DTMF paths so that a non-digit produces no signal on either path.
 *
 * Requirement 7.6 / Property 9.
 */

/**
 * A single DTMF digit: `0`-`9`, `*`, or `#`.
 */
export type DtmfDigit =
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "*"
  | "#";

/**
 * The complete set of valid DTMF digits, in keypad order.
 */
export const DTMF_DIGITS: readonly DtmfDigit[] = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "*",
  "0",
  "#",
];

const DTMF_DIGIT_SET: ReadonlySet<string> = new Set(DTMF_DIGITS);

/**
 * Returns true only when `value` is a single valid DTMF_Digit (`0`-`9`, `*`,
 * or `#`). Every other input — multi-character strings, whitespace, letters,
 * other punctuation, the empty string, or non-string values — returns false.
 *
 * This is the guard both DTMF paths consult before emitting a tone, so a
 * rejected input yields no signal on either the in-band or the fallback path.
 */
export function isDtmfDigit(value: unknown): value is DtmfDigit {
  return typeof value === "string" && DTMF_DIGIT_SET.has(value);
}
