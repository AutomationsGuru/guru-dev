import { describe, it, expect } from 'vitest';
import { phases } from '../../src/swarm/heavyFivePhasePlan.js';

describe('heavyFivePhasePlan', () => {
  it('should return an array of 5 strings', () => {
    const result = phases();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(5);
    result.forEach((phase) => {
      expect(typeof phase).toBe('string');
    });
  });
});
