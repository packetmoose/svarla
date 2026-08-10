/**
 * Formats a call duration in seconds to HH:MM:SS format.
 * Used for the active call timer display.
 */
export function formatDurationHHMMSS(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Formats a call duration for the call history display.
 * - For calls under 1 hour: "Xm Ys" format
 * - For calls >= 1 hour: "HH:MM:SS" format
 */
export function formatDurationForHistory(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));

  if (totalSeconds >= 3600) {
    return formatDurationHHMMSS(totalSeconds);
  }

  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;

  return `${minutes}m ${secs}s`;
}
