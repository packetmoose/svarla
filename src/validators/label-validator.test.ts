import { describe, it, expect } from 'vitest';
import { validateLabel } from './label-validator.js';

describe('validateLabel', () => {
  it('should accept a valid label', () => {
    expect(validateLabel('Personal')).toEqual({ valid: true });
  });

  it('should accept a single character label', () => {
    expect(validateLabel('A')).toEqual({ valid: true });
  });

  it('should accept a 30-character label', () => {
    expect(validateLabel('A'.repeat(30))).toEqual({ valid: true });
  });

  it('should accept a label with special characters', () => {
    expect(validateLabel('Business - Main #1')).toEqual({ valid: true });
  });

  it('should reject an empty string', () => {
    const result = validateLabel('');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should reject a label longer than 30 characters', () => {
    const result = validateLabel('A'.repeat(31));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('1 and 30');
  });
});
