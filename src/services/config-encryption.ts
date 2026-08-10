import crypto from 'node:crypto';

/**
 * Application-level encryption for sensitive provider configuration fields.
 *
 * Uses AES-256-GCM with a random IV per encryption operation.
 * The encryption key is derived from the CONFIG_ENCRYPTION_KEY environment variable.
 *
 * Encrypted values are stored as: `enc:v1:<iv-hex>:<auth-tag-hex>:<ciphertext-hex>`
 * This prefix makes it easy to identify encrypted fields and skip double-encryption.
 *
 * When no encryption key is configured, secrets are stored in plaintext
 * (backward-compatible behavior with a logged warning).
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits recommended for GCM
const AUTH_TAG_LENGTH = 16;
const ENCRYPTED_PREFIX = 'enc:v1:';

/**
 * Fields considered sensitive per provider type.
 * Only these fields will be encrypted/decrypted.
 */
const SENSITIVE_FIELDS: Record<string, string[]> = {
  vonage: ['api_secret', 'private_key'],
  '46elks': ['api_password'],
  modemmanager: [],
  dummy: [],
};

/**
 * Get the list of sensitive fields for a given provider type.
 */
export function getSensitiveFields(providerType: string): string[] {
  return SENSITIVE_FIELDS[providerType] ?? [];
}

/**
 * Derive a 256-bit key from the config encryption key using SHA-256.
 * This allows the user to provide a passphrase of any length.
 */
function deriveKey(configKey: string): Buffer {
  return crypto.createHash('sha256').update(configKey).digest();
}

/**
 * Encrypt a single string value.
 * Returns the encrypted string in the format: enc:v1:<iv>:<tag>:<ciphertext>
 */
export function encryptValue(plaintext: string, encryptionKey: string): string {
  const key = deriveKey(encryptionKey);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return `${ENCRYPTED_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a single encrypted value.
 * Expects the format: enc:v1:<iv>:<tag>:<ciphertext>
 * Returns the decrypted plaintext string.
 * Throws if decryption fails (wrong key, tampered data).
 */
export function decryptValue(encryptedValue: string, encryptionKey: string): string {
  if (!encryptedValue.startsWith(ENCRYPTED_PREFIX)) {
    // Not encrypted — return as-is (backward compatibility)
    return encryptedValue;
  }

  const payload = encryptedValue.slice(ENCRYPTED_PREFIX.length);
  const parts = payload.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted value format');
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const key = deriveKey(encryptionKey);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf-8');
}

/**
 * Check if a value is already encrypted.
 */
export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Encrypt sensitive fields in a provider config object.
 * Only fields listed in SENSITIVE_FIELDS for the given type are encrypted.
 * Already-encrypted values are skipped (idempotent).
 *
 * Returns null if no encryption key is available (plaintext fallback).
 */
export function encryptConfig(
  providerType: string,
  config: Record<string, unknown>,
  encryptionKey: string | undefined
): Record<string, unknown> {
  if (!encryptionKey) {
    return config; // No encryption key — store plaintext
  }

  const sensitiveFields = getSensitiveFields(providerType);
  if (sensitiveFields.length === 0) {
    return config;
  }

  const encrypted: Record<string, unknown> = { ...config };

  for (const field of sensitiveFields) {
    const value = encrypted[field];
    if (typeof value === 'string' && value.length > 0 && !isEncrypted(value)) {
      encrypted[field] = encryptValue(value, encryptionKey);
    }
  }

  return encrypted;
}

/**
 * Decrypt sensitive fields in a provider config object.
 * Only fields listed in SENSITIVE_FIELDS for the given type are decrypted.
 * Non-encrypted values are returned as-is (backward compatibility).
 *
 * Returns the config unchanged if no encryption key is available.
 */
export function decryptConfig(
  providerType: string,
  config: Record<string, unknown>,
  encryptionKey: string | undefined
): Record<string, unknown> {
  if (!encryptionKey) {
    return config; // No encryption key — assume plaintext
  }

  const sensitiveFields = getSensitiveFields(providerType);
  if (sensitiveFields.length === 0) {
    return config;
  }

  const decrypted: Record<string, unknown> = { ...config };

  for (const field of sensitiveFields) {
    const value = decrypted[field];
    if (typeof value === 'string' && isEncrypted(value)) {
      decrypted[field] = decryptValue(value, encryptionKey);
    }
  }

  return decrypted;
}
