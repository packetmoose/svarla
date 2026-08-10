export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates an SMS message body.
 * Requirements:
 * - Between 1 and 1600 characters
 * - Must not be whitespace-only
 */
export function validateMessage(body: string): ValidationResult {
  if (!body) {
    return { valid: false, error: 'Message body is required' };
  }

  if (body.trim().length === 0) {
    return { valid: false, error: 'Message body must not be whitespace-only' };
  }

  if (body.length > 1600) {
    return { valid: false, error: 'Message body must not exceed 1600 characters' };
  }

  return { valid: true };
}
