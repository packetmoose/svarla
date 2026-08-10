import { describe, it, expect } from 'vitest';
import { validateMessage } from './message-validator.js';

describe('validateMessage', () => {
  it('should accept a valid message', () => {
    expect(validateMessage('Hello, world!')).toEqual({ valid: true });
  });

  it('should accept a single character message', () => {
    expect(validateMessage('H')).toEqual({ valid: true });
  });

  it('should accept a 1600-character message', () => {
    expect(validateMessage('x'.repeat(1600))).toEqual({ valid: true });
  });

  it('should reject an empty string', () => {
    const result = validateMessage('');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should reject a whitespace-only message', () => {
    const result = validateMessage('   \t\n  ');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('whitespace-only');
  });

  it('should reject a message exceeding 1600 characters', () => {
    const result = validateMessage('x'.repeat(1601));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('1600');
  });

  it('should accept a message with leading/trailing whitespace as long as it has non-whitespace content', () => {
    expect(validateMessage('  hello  ')).toEqual({ valid: true });
  });
});
