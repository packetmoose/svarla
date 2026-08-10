import { z } from 'zod';

/**
 * Validation result for provider configuration.
 * Returns either a success or field-level error details.
 */
export type ProviderConfigValidationResult =
  | { valid: true }
  | { valid: false; errors: Array<{ field: string; message: string }> };

/**
 * Zod schema for Vonage provider configuration.
 * Requires API credentials, application ID, private key path, and webhook base URL.
 */
export const vonageConfigSchema = z.object({
  api_key: z.string().trim().min(1, 'api_key is required'),
  api_secret: z.string().trim().min(1, 'api_secret is required'),
  application_id: z.string().trim().uuid('application_id must be a valid UUID'),
  private_key: z.string().min(1, 'private_key is required when private_key_path is not provided').optional(),
  private_key_path: z.string().trim().min(1, 'private_key_path is required when private_key is not provided').optional(),
  webhook_base_url: z.string().trim().url('webhook_base_url must be a valid URL').optional(),
}).refine(
  (data) => !!data.private_key || !!data.private_key_path,
  { message: 'Either private_key or private_key_path must be provided', path: ['private_key'] },
);

/**
 * Zod schema for ModemManager provider configuration.
 * Only has an optional number_overrides map.
 */
export const modemmanagerConfigSchema = z.object({
  number_overrides: z.record(z.string(), z.string()).optional(),
});

/**
 * Zod schema for Dummy provider configuration.
 * Minimal config with an optional name field.
 */
export const dummyConfigSchema = z.object({
  name: z.string().optional(),
});

/**
 * Zod schema for 46elks provider configuration.
 * Requires API credentials (username/password) and webhook base URL.
 *
 * Requirements: 7.9
 */
export const elks46ConfigSchema = z.object({
  api_username: z.string().trim().min(1, 'api_username is required'),
  api_password: z.string().trim().min(1, 'api_password is required'),
  webhook_base_url: z.string().trim().url('webhook_base_url must be a valid URL').optional(),
  websocket_number: z.string().trim().optional(),
});

/**
 * Map of provider type to its corresponding Zod schema.
 */
const schemasByType: Record<string, z.ZodSchema> = {
  vonage: vonageConfigSchema,
  modemmanager: modemmanagerConfigSchema,
  dummy: dummyConfigSchema,
  '46elks': elks46ConfigSchema,
};

/**
 * Validates a provider configuration against the schema for the given provider type.
 * Returns field-level validation errors if the config is invalid.
 *
 * Requirements: 3.5, 3.6
 */
export function validateProviderConfig(
  type: string,
  config: unknown,
): ProviderConfigValidationResult {
  const schema = schemasByType[type];
  if (!schema) {
    return {
      valid: false,
      errors: [{ field: 'type', message: `Unknown provider type: ${type}` }],
    };
  }

  const result = schema.safeParse(config);
  if (result.success) {
    return { valid: true };
  }

  const errors = result.error.issues.map((issue) => ({
    field: issue.path.join('.') || 'config',
    message: issue.message,
  }));

  return { valid: false, errors };
}
