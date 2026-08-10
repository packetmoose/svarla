import { describe, it, expect } from 'vitest';
import { notificationPreview, threadListPreview } from './message-preview.js';

describe('notificationPreview', () => {
  it('should return the full message if it is 100 characters or less', () => {
    const msg = 'Hello, world!';
    expect(notificationPreview(msg)).toBe(msg);
  });

  it('should return the full message if it is exactly 100 characters', () => {
    const msg = 'x'.repeat(100);
    expect(notificationPreview(msg)).toBe(msg);
  });

  it('should truncate and append "…" if the message exceeds 100 characters', () => {
    const msg = 'a'.repeat(150);
    const result = notificationPreview(msg);
    expect(result).toBe('a'.repeat(100) + '…');
    expect(result.length).toBe(101);
  });

  it('should handle an empty string', () => {
    expect(notificationPreview('')).toBe('');
  });
});

describe('threadListPreview', () => {
  it('should return the full message if it is 50 characters or less', () => {
    const msg = 'Short message';
    expect(threadListPreview(msg)).toBe(msg);
  });

  it('should return the full message if it is exactly 50 characters', () => {
    const msg = 'x'.repeat(50);
    expect(threadListPreview(msg)).toBe(msg);
  });

  it('should truncate and append "…" if the message exceeds 50 characters', () => {
    const msg = 'b'.repeat(80);
    const result = threadListPreview(msg);
    expect(result).toBe('b'.repeat(50) + '…');
    expect(result.length).toBe(51);
  });

  it('should handle an empty string', () => {
    expect(threadListPreview('')).toBe('');
  });
});
