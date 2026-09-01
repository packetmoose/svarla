/**
 * Utility for masking sensitive configuration fields.
 * Shows only the last 4 characters of secret values, with asterisks for the rest.
 * Strings shorter than 4 characters are fully masked.
 *
 * Requirements: 7.7
 */

/**
 * Masks a secret string value.
 * - For strings of 4 or more characters: replaces all but the last 4 with asterisks
 * - For strings shorter than 4 characters: fully masked with asterisks
 */
export function maskSecret(value: string): string {
  if (value.length < 4) {
    return '*'.repeat(value.length);
  }
  const visiblePart = value.slice(-4);
  const maskedPart = '*'.repeat(value.length - 4);
  return maskedPart + visiblePart;
}

/**
 * Map of provider type to the set of field names considered secret.
 */
export const SECRET_FIELDS: Record<string, Set<string>> = {
  vonage: new Set(['api_secret', 'private_key', 'private_key_path']),
  dummy: new Set(),
};

/**
 * Returns a copy of the provider config with secret fields masked.
 * Only string values in secret fields are masked; non-string values are passed through unchanged.
 * If the provider type is not recognized, returns the config unchanged.
 */
export function maskProviderConfig(
  type: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const secretFields = SECRET_FIELDS[type];
  if (!secretFields || secretFields.size === 0) {
    return { ...config };
  }

  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (secretFields.has(key) && typeof value === 'string') {
      masked[key] = maskSecret(value);
    } else {
      masked[key] = value;
    }
  }
  return masked;
}
