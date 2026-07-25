
import { describe, it, expect } from 'vitest';
import { applyFindings, clearBlock } from '../../src/review/reviewCriticalBlockFlag.js';
import type { ReviewState } from '../../src/review/reviewCriticalBlockFlag.js';

describe('reviewState', () => {
  describe('applyFindings', () => {
    it('should set blockNext to true if any finding is critical', () => {
      const initialState: ReviewState = { blockNext: false };
      const findings = [{ critical: true }, { level: 'warn' }];
      const newState = applyFindings(initialState, findings);
      expect(newState.blockNext).toBe(true);
      expect(newState).not.toBe(initialState);
    });

    it('should not change blockNext if no findings are critical', () => {
      const initialState: ReviewState = { blockNext: false };
      const findings = [{ level: 'warn' }, { level: 'info' }];
      const newState = applyFindings(initialState, findings);
      expect(newState.blockNext).toBe(false);
      expect(newState).not.toBe(initialState);
    });

    it('should leave blockNext as true if it was already true, even with no new critical findings', () => {
      const initialState: ReviewState = { blockNext: true };
      const findings = [{ level: 'warn' }, { level: 'info' }];
      const newState = applyFindings(initialState, findings);
      expect(newState.blockNext).toBe(true);
      expect(newState).not.toBe(initialState);
    });
  });

  describe('clearBlock', () => {
    it('should set blockNext to false', () => {
      const initialState: ReviewState = { blockNext: true };
      const newState = clearBlock(initialState);
      expect(newState.blockNext).toBe(false);
      expect(newState).not.toBe(initialState);
    });
  });
});
