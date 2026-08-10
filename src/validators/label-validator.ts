export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates a Vonage number label.
 * Requirements:
 * - Between 1 and 30 characters
 * - Any printable characters are valid
 */
export function validateLabel(label: string): ValidationResult {
  if (!label) {
    return { valid: false, error: 'Label is required' };
  }

  if (label.length < 1 || label.length > 30) {
    return { valid: false, error: 'Label must be between 1 and 30 characters' };
  }

  return { valid: true };
}
