import { describe, it, expect } from 'vitest';
import { validatePassword } from './password-validator.js';

describe('validatePassword', () => {
  it('should accept a valid strong password', () => {
    expect(validatePassword('MyStr0ng!Pass')).toEqual({ valid: true });
  });

  it('should accept a password with various special characters', () => {
    expect(validatePassword('Abcdef1234~`')).toEqual({ valid: true });
  });

  it('should reject an empty string', () => {
    const result = validatePassword('');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should reject a password shorter than 12 characters', () => {
    const result = validatePassword('Ab1!short');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('12 characters');
  });

  it('should reject a password without an uppercase letter', () => {
    const result = validatePassword('mystrongpass1!');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('uppercase');
  });

  it('should reject a password without a lowercase letter', () => {
    const result = validatePassword('MYSTRONGPASS1!');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('lowercase');
  });

  it('should reject a password without a digit', () => {
    const result = validatePassword('MyStrongPass!!');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('digit');
  });

  it('should reject a password without a special character', () => {
    const result = validatePassword('MyStrongPass12');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('special character');
  });

  it('should accept a password that is exactly 12 characters', () => {
    expect(validatePassword('Abcdefgh1!23')).toEqual({ valid: true });
  });
});
