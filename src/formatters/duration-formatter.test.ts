import { describe, it, expect } from 'vitest';
import { formatDurationHHMMSS, formatDurationForHistory } from './duration-formatter.js';

describe('formatDurationHHMMSS', () => {
  it('should format 0 seconds', () => {
    expect(formatDurationHHMMSS(0)).toBe('00:00:00');
  });

  it('should format seconds only', () => {
    expect(formatDurationHHMMSS(45)).toBe('00:00:45');
  });

  it('should format minutes and seconds', () => {
    expect(formatDurationHHMMSS(125)).toBe('00:02:05');
  });

  it('should format hours, minutes, and seconds', () => {
    expect(formatDurationHHMMSS(3661)).toBe('01:01:01');
  });

  it('should handle large values', () => {
    expect(formatDurationHHMMSS(36000)).toBe('10:00:00');
  });

  it('should handle negative values as 0', () => {
    expect(formatDurationHHMMSS(-5)).toBe('00:00:00');
  });

  it('should floor fractional seconds', () => {
    expect(formatDurationHHMMSS(59.9)).toBe('00:00:59');
  });
});

describe('formatDurationForHistory', () => {
  it('should format 0 seconds as "0m 0s"', () => {
    expect(formatDurationForHistory(0)).toBe('0m 0s');
  });

  it('should format seconds under a minute', () => {
    expect(formatDurationForHistory(45)).toBe('0m 45s');
  });

  it('should format minutes and seconds', () => {
    expect(formatDurationForHistory(125)).toBe('2m 5s');
  });

  it('should format 59 minutes 59 seconds', () => {
    expect(formatDurationForHistory(3599)).toBe('59m 59s');
  });

  it('should format exactly 1 hour in HH:MM:SS format', () => {
    expect(formatDurationForHistory(3600)).toBe('01:00:00');
  });

  it('should format more than 1 hour in HH:MM:SS format', () => {
    expect(formatDurationForHistory(7261)).toBe('02:01:01');
  });

  it('should handle negative values as 0', () => {
    expect(formatDurationForHistory(-10)).toBe('0m 0s');
  });
});
