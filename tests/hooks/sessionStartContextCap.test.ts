import { describe, it, expect } from 'vitest';
import { cap } from '../../src/hooks/sessionStartContextCap.js';

describe('sessionStartContextCap', () => {
  describe('cap', () => {
    it('returns short text unchanged', () => {
      const input = 'Hello, world!';
      const result = cap(input, 100);
      expect(result).toBe(input);
      expect(result.length).toBeLessThanOrEqual(100);
    });

    it('truncates long text with ellipsis', () => {
      const input = 'A'.repeat(150);
      const result = cap(input, 100);
      expect(result.length).toBe(103); // 100 chars + '...'
      expect(result.endsWith('...')).toBe(true);
      expect(result.slice(0, 100)).toBe(input.slice(0, 100));
    });

    it('handles exact boundary without truncation', () => {
      const input = 'B'.repeat(50);
      const result = cap(input, 50);
      expect(result).toBe(input);
      expect(result.length).toBe(50);
    });

    it('truncates text exactly one char over limit', () => {
      const input = 'C'.repeat(51);
      const result = cap(input, 50);
      expect(result.length).toBe(53); // 50 + '...'
      expect(result.endsWith('...')).toBe(true);
    });
  });
});
