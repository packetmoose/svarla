export interface ValidationResult {
  valid: boolean;
  error?: string;
}

const E164_REGEX = /^\+[1-9]\d{1,14}$/;
const LOCAL_NUMBER_REGEX = /^[0-9]{3,15}$/;

/**
 * Validates a phone number.
 * Accepts E.164 format (+[country][number]) or local format (digits only, 3-15 chars).
 */
export function validatePhoneNumber(phone: string): ValidationResult {
  if (!phone) {
    return { valid: false, error: 'Phone number is required' };
  }

  const trimmed = phone.trim();

  if (E164_REGEX.test(trimmed) || LOCAL_NUMBER_REGEX.test(trimmed)) {
    return { valid: true };
  }

  return {
    valid: false,
    error: 'Phone number must be in E.164 format (e.g., +14155552671) or local format (e.g., 0701234567)',
  };
}

/**
 * Normalizes a local phone number to E.164 by extracting the country code from the `from` number.
 * If already E.164, returns as-is. If local (starts with 0), strips leading 0 and prepends country code.
 * If local (no leading 0), prepends country code directly.
 *
 * @param to - The destination number (may be local or E.164)
 * @param from - The sender number in E.164 format (used to derive country code)
 * @returns The normalized E.164 number, or the original if normalization isn't possible
 */
export function normalizeToE164(to: string, from: string): string {
  const trimmedTo = to.trim();

  // Already E.164
  if (E164_REGEX.test(trimmedTo)) {
    return trimmedTo;
  }

  // Extract country code from the `from` number
  // E.164: +[country_code][subscriber_number]
  // Country codes are 1-3 digits. We use a simple heuristic:
  // - +1 → North America (1 digit)
  // - +7 → Russia/Kazakhstan (1 digit)
  // - +2x, +3x, +4x, +5x, +6x, +8x, +9x → 2-3 digit country codes
  if (!E164_REGEX.test(from)) {
    return trimmedTo; // Can't normalize without a valid from number
  }

  const countryCode = extractCountryCode(from);
  if (!countryCode) {
    return trimmedTo;
  }

  // If local number starts with 0 (trunk prefix), strip it and prepend country code
  if (trimmedTo.startsWith('0')) {
    return `+${countryCode}${trimmedTo.slice(1)}`;
  }

  // Numbers not starting with 0 are short codes — return as-is without country code prefix
  return trimmedTo;
}

/**
 * Extracts the country calling code from an E.164 number.
 * Uses ITU-T E.164 assignment rules for country code length.
 */
function extractCountryCode(e164: string): string | null {
  if (!e164.startsWith('+') || e164.length < 3) return null;

  const digits = e164.slice(1); // Remove '+'

  // 1-digit country codes
  if (digits[0] === '1' || digits[0] === '7') {
    return digits[0];
  }

  // 2-digit country codes (most common)
  const twoDigit = digits.slice(0, 2);
  const twoDigitCodes = [
    '20', '27', '30', '31', '32', '33', '34', '36', '39',
    '40', '41', '43', '44', '45', '46', '47', '48', '49',
    '51', '52', '53', '54', '55', '56', '57', '58',
    '60', '61', '62', '63', '64', '65', '66',
    '70', '71', '72', '73', '74', '75', '76', '77', '78', '79',
    '81', '82', '84', '86',
    '90', '91', '92', '93', '94', '95', '98',
  ];

  if (twoDigitCodes.includes(twoDigit)) {
    return twoDigit;
  }

  // 3-digit country codes (remaining)
  return digits.slice(0, 3);
}

/**
 * Normalizes an inbound number from a telephony provider for storage.
 * - Already E.164 (starts with +): returns as-is
 * - Non-numeric string (custom sender name like "MyBrand"): returns as-is
 * - Short code (all digits, does not start with 0, ≤6 digits): returns as-is
 * - Full international number (all digits, 7+ digits): prepends +
 * - Local number (starts with 0): prepends + (will need country code normalization later)
 */
export function normalizeInboundNumber(value: string): string {
  if (!value) return value;
  if (value.startsWith('+')) return value;
  // Non-numeric: custom sender name — return as-is
  if (!/^\d+$/.test(value)) return value;
  // Short code: digits only, doesn't start with 0, 6 or fewer digits
  if (!value.startsWith('0') && value.length <= 6) return value;
  // Full number: prepend +
  return `+${value}`;
}
