export interface ValidationResult {
  valid: boolean;
  error?: string;
}

const SPECIAL_CHARACTERS = "!@#$%^&*()-_+=[]{}|;:',.<>?/~`";

/**
 * Validates password strength.
 * Requirements:
 * - At least 12 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one digit
 * - At least one special character from: !@#$%^&*()-_+=[]{}|;:',.<>?/~`
 */
export function validatePassword(password: string): ValidationResult {
  if (!password) {
    return { valid: false, error: 'Password is required' };
  }

  if (password.length < 12) {
    return { valid: false, error: 'Password must be at least 12 characters long' };
  }

  if (!/[A-Z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one uppercase letter' };
  }

  if (!/[a-z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one lowercase letter' };
  }

  if (!/\d/.test(password)) {
    return { valid: false, error: 'Password must contain at least one digit' };
  }

  const hasSpecial = password.split('').some((char) => SPECIAL_CHARACTERS.includes(char));
  if (!hasSpecial) {
    return {
      valid: false,
      error: 'Password must contain at least one special character (!@#$%^&*()-_+=[]{}|;:\',.<>?/~`)',
    };
  }

  return { valid: true };
}
