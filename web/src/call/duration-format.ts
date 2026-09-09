/**
 * Call-duration formatting for the In_Call_Surface.
 *
 * Formats a non-negative elapsed-seconds value as `mm:ss` below 60 minutes and
 * `hh:mm:ss` at or beyond 60 minutes, preserving the underlying elapsed value
 * (no rounding that changes the number of seconds).
 *
 * Backs Requirement 8.2 / Property 8 (Duration formatting).
 */

/** The number of seconds at/beyond which the `hh:mm:ss` form is used. */
const ONE_HOUR_SECONDS = 3600;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Format non-negative elapsed seconds as a call-duration string.
 *
 * - Below 60 minutes (`< 3600s`): `mm:ss` (minutes are not zero-padded to two
 *   digits beyond what the value requires, but are always at least two digits).
 * - At/beyond 60 minutes (`>= 3600s`): `hh:mm:ss`.
 *
 * The elapsed value is preserved exactly: the input is expected to be a
 * whole, non-negative number of seconds and is not rounded. Non-integer or
 * negative inputs are normalized defensively (floored, clamped to zero) so the
 * timer never renders a nonsensical value.
 *
 * @param elapsedSeconds Non-negative whole number of elapsed seconds.
 * @returns The formatted duration string.
 */
export function formatDuration(elapsedSeconds: number): string {
  const total = Number.isFinite(elapsedSeconds)
    ? Math.max(0, Math.floor(elapsedSeconds))
    : 0;

  const seconds = total % 60;
  const totalMinutes = Math.floor(total / 60);

  if (total < ONE_HOUR_SECONDS) {
    return `${pad2(totalMinutes)}:${pad2(seconds)}`;
  }

  const hours = Math.floor(total / ONE_HOUR_SECONDS);
  const minutes = totalMinutes % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

/**
 * Parse a duration string produced by {@link formatDuration} back into elapsed
 * seconds. This is the inverse of {@link formatDuration} for well-formed input
 * and is used to assert the round-trip property.
 *
 * Accepts both `mm:ss` and `hh:mm:ss` forms.
 *
 * @param formatted A duration string in `mm:ss` or `hh:mm:ss` form.
 * @returns The elapsed seconds, or `null` if the input is malformed.
 */
export function parseDuration(formatted: string): number | null {
  const parts = formatted.split(":");
  if (parts.length !== 2 && parts.length !== 3) {
    return null;
  }

  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    numbers.push(Number(part));
  }

  if (parts.length === 2) {
    const [minutes, seconds] = numbers;
    return minutes * 60 + seconds;
  }

  const [hours, minutes, seconds] = numbers;
  return hours * ONE_HOUR_SECONDS + minutes * 60 + seconds;
}
