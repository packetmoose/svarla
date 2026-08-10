/**
 * Truncates a message to the specified length for preview display.
 * Appends "…" if the message was truncated.
 */
function truncate(message: string, maxLength: number): string {
  if (message.length <= maxLength) {
    return message;
  }

  return message.slice(0, maxLength) + '…';
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
 * Truncates to 50 characters with "…" appended if truncated.
 */
export function threadListPreview(message: string): string {
  return truncate(message, 50);
}
