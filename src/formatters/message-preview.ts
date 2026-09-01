/**
 * Truncates a message to the specified length for preview display.
 * Appends "…" if the message was truncated, keeping total within maxLength.
 */
function truncate(message: string, maxLength: number): string {
  if (message.length <= maxLength) {
    return message;
  }

  return message.slice(0, maxLength - 1) + '…';
}

/**
 * Generates a message preview for push notifications.
 * Truncates to 100 characters with "…" appended if truncated.
 */
export function notificationPreview(message: string): string {
  return truncate(message, 100);
}

/**
 * Generates a message preview for the conversation thread list.
 * Truncates to 50 characters total (49 + "…") to fit the database column.
 */
export function threadListPreview(message: string): string {
  return truncate(message, 50);
}
