import { describe, it, expect } from 'vitest';
import { maskSecret, maskProviderConfig, SECRET_FIELDS } from './secret-masker.js';

describe('maskSecret', () => {
  it('should mask a string longer than 4 characters showing only last 4', () => {
    expect(maskSecret('my-super-secret')).toBe('***********cret');
  });

  it('should mask a string of exactly 4 characters as fully visible with no asterisks', () => {
    expect(maskSecret('abcd')).toBe('abcd');
  });

  it('should fully mask a string of 3 characters', () => {
    expect(maskSecret('abc')).toBe('***');
  });

  it('should fully mask a string of 2 characters', () => {
    expect(maskSecret('ab')).toBe('**');
  });

  it('should fully mask a string of 1 character', () => {
    expect(maskSecret('a')).toBe('*');
  });

  it('should return empty string for empty input', () => {
    expect(maskSecret('')).toBe('');
  });

  it('should show last 4 characters of a long API secret', () => {
    expect(maskSecret('abcdef12345678')).toBe('**********5678');
  });

  it('should preserve the length of the original string', () => {
    const input = 'this-is-a-secret-value';
    const result = maskSecret(input);
    expect(result.length).toBe(input.length);
  });
});

describe('SECRET_FIELDS', () => {
  it('should define api_secret and private_key_path as secrets for vonage', () => {
    expect(SECRET_FIELDS['vonage']!.has('api_secret')).toBe(true);
    expect(SECRET_FIELDS['vonage']!.has('private_key_path')).toBe(true);
  });

  it('should not mark api_key as a secret for vonage', () => {
    expect(SECRET_FIELDS['vonage']!.has('api_key')).toBe(false);
  });

  it('should have no secret fields for modemmanager', () => {
    expect(SECRET_FIELDS['modemmanager']!.size).toBe(0);
  });

  it('should have no secret fields for dummy', () => {
    expect(SECRET_FIELDS['dummy']!.size).toBe(0);
  });
});

describe('maskProviderConfig', () => {
  it('should mask secret fields in vonage config', () => {
    const config = {
      api_key: 'abc123',
      api_secret: 'supersecretvalue',
      application_id: '550e8400-e29b-41d4-a716-446655440000',
      private_key: '-----BEGIN PRIVATE KEY-----\nlong_key_content_here\n-----END PRIVATE KEY-----',
      private_key_path: '/path/to/private.key',
      webhook_base_url: 'https://example.com',
    };

    const result = maskProviderConfig('vonage', config);

    expect(result['api_key']).toBe('abc123');
    expect(result['api_secret']).toBe('************alue');
    expect(result['application_id']).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result['private_key']).not.toContain('BEGIN PRIVATE KEY');
    expect(result['private_key_path']).toBe('****************.key');
    expect(result['webhook_base_url']).toBe('https://example.com');
  });

  it('should not mutate the original config object', () => {
    const config = {
      api_key: 'abc123',
      api_secret: 'supersecretvalue',
    };
    const original = { ...config };

    maskProviderConfig('vonage', config);

    expect(config).toEqual(original);
  });

  it('should return config unchanged for modemmanager (no secret fields)', () => {
    const config = {
      number_overrides: { '+1234567890': 'My Modem' },
    };

    const result = maskProviderConfig('modemmanager', config);

    expect(result).toEqual(config);
  });

  it('should return config unchanged for dummy (no secret fields)', () => {
    const config = { name: 'test-dummy' };

    const result = maskProviderConfig('dummy', config);

    expect(result).toEqual(config);
  });

  it('should return a copy of config for unknown provider type', () => {
    const config = { some_field: 'value' };

    const result = maskProviderConfig('unknown', config);

    expect(result).toEqual(config);
    expect(result).not.toBe(config);
  });

  it('should pass through non-string secret field values unchanged', () => {
    const config = {
      api_key: 'abc123',
      api_secret: 12345 as unknown,
      private_key_path: null as unknown,
    };

    const result = maskProviderConfig('vonage', config);

    expect(result['api_secret']).toBe(12345);
    expect(result['private_key_path']).toBe(null);
  });

  it('should handle short secret values (less than 4 chars)', () => {
    const config = {
      api_key: 'abc123',
      api_secret: 'ab',
      private_key_path: '/a/b/c/long-path.key',
    };

    const result = maskProviderConfig('vonage', config);

    expect(result['api_secret']).toBe('**');
    expect(result['private_key_path']).toBe('****************.key');
  });
});
