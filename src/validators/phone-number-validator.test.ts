import { describe, it, expect } from 'vitest';
import { validatePhoneNumber } from './phone-number-validator.js';

describe('validatePhoneNumber', () => {
  it('should accept a valid E.164 number', () => {
    expect(validatePhoneNumber('+14155552671')).toEqual({ valid: true });
  });

  it('should accept the minimum length E.164 number (+ followed by 2 digits)', () => {
    expect(validatePhoneNumber('+12')).toEqual({ valid: true });
  });

  it('should accept the maximum length E.164 number (+ followed by 15 digits)', () => {
    expect(validatePhoneNumber('+123456789012345')).toEqual({ valid: true });
  });

  it('should reject an empty string', () => {
    const result = validatePhoneNumber('');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should accept a number without the + prefix as a local number', () => {
    const result = validatePhoneNumber('14155552671');
    expect(result.valid).toBe(true);
  });

  it('should reject a number starting with +0', () => {
    const result = validatePhoneNumber('+04155552671');
    expect(result.valid).toBe(false);
  });

  it('should reject a number that is too long (more than 15 digits after +)', () => {
    const result = validatePhoneNumber('+1234567890123456');
    expect(result.valid).toBe(false);
  });

  it('should reject a number with only the + sign', () => {
    const result = validatePhoneNumber('+');
    expect(result.valid).toBe(false);
  });

  it('should reject a number containing letters', () => {
    const result = validatePhoneNumber('+1415abc2671');
    expect(result.valid).toBe(false);
  });

  it('should reject a number with spaces', () => {
    const result = validatePhoneNumber('+1 415 555 2671');
    expect(result.valid).toBe(false);
  });
});
