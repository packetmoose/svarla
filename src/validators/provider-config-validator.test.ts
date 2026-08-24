import { describe, it, expect } from 'vitest';
import {
  validateProviderConfig,
  vonageConfigSchema,
  dummyConfigSchema,
} from './provider-config-validator.js';

describe('provider-config-validator', () => {
  describe('validateProviderConfig - vonage', () => {
    const validVonageConfig = {
      api_key: 'abc123',
      api_secret: 'secret456',
      application_id: '550e8400-e29b-41d4-a716-446655440000',
      private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
    };

    const validVonageConfigWithPath = {
      api_key: 'abc123',
      api_secret: 'secret456',
      application_id: '550e8400-e29b-41d4-a716-446655440000',
      private_key_path: '/path/to/key.pem',
    };

    it('accepts a valid vonage config with private_key content', () => {
      const result = validateProviderConfig('vonage', validVonageConfig);
      expect(result).toEqual({ valid: true });
    });

    it('accepts a valid vonage config with private_key_path', () => {
      const result = validateProviderConfig('vonage', validVonageConfigWithPath);
      expect(result).toEqual({ valid: true });
    });

    it('rejects config without either private_key or private_key_path', () => {
      const result = validateProviderConfig('vonage', {
        api_key: 'abc123',
        api_secret: 'secret456',
        application_id: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors).toContainEqual(
          expect.objectContaining({ field: 'private_key' }),
        );
      }
    });

    it('rejects empty api_key', () => {
      const result = validateProviderConfig('vonage', {
        ...validVonageConfig,
        api_key: '',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors).toContainEqual(
          expect.objectContaining({ field: 'api_key' }),
        );
      }
    });

    it('rejects invalid application_id (not a UUID)', () => {
      const result = validateProviderConfig('vonage', {
        ...validVonageConfig,
        application_id: 'not-a-uuid',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors).toContainEqual(
          expect.objectContaining({ field: 'application_id' }),
        );
      }
    });

    it('rejects invalid webhook_base_url', () => {
      const result = validateProviderConfig('vonage', {
        ...validVonageConfig,
        webhook_base_url: 'not-a-url',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors).toContainEqual(
          expect.objectContaining({ field: 'webhook_base_url' }),
        );
      }
    });

    it('rejects missing required fields', () => {
      const result = validateProviderConfig('vonage', {});
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.length).toBeGreaterThanOrEqual(3);
      }
    });

    it('reports multiple errors at once', () => {
      const result = validateProviderConfig('vonage', {
        api_key: '',
        api_secret: '',
        application_id: 'bad',
        webhook_base_url: 'bad',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        const fields = result.errors.map((e) => e.field);
        expect(fields).toContain('api_key');
        expect(fields).toContain('api_secret');
        expect(fields).toContain('application_id');
        expect(fields).toContain('webhook_base_url');
      }
    });
  });

  describe('validateProviderConfig - dummy', () => {
    it('accepts empty config', () => {
      const result = validateProviderConfig('dummy', {});
      expect(result).toEqual({ valid: true });
    });

    it('accepts config with optional name', () => {
      const result = validateProviderConfig('dummy', { name: 'Test Dummy' });
      expect(result).toEqual({ valid: true });
    });

    it('rejects invalid name type', () => {
      const result = validateProviderConfig('dummy', { name: 123 });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors).toContainEqual(
          expect.objectContaining({ field: 'name' }),
        );
      }
    });
  });

  describe('validateProviderConfig - unknown type', () => {
    it('rejects unknown provider type', () => {
      const result = validateProviderConfig('unknown', {});
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors).toContainEqual(
          expect.objectContaining({ field: 'type' }),
        );
      }
    });
  });

  describe('exported schemas', () => {
    it('vonageConfigSchema is a valid zod schema', () => {
      expect(vonageConfigSchema.parse).toBeDefined();
    });

    it('dummyConfigSchema is a valid zod schema', () => {
      expect(dummyConfigSchema.parse).toBeDefined();
    });
  });
});
