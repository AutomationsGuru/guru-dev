import { describe, it, expect } from 'vitest';
import { shareBudget } from '../../src/session/sessionForkBudgetShare.js';

describe('shareBudget', () => {
  it('should correctly apply the ratio to the parent budget', () => {
    expect(shareBudget(100, 0.5, 10)).toBe(50);
  });

  it('should respect the floor value if the calculated share is below it', () => {
    expect(shareBudget(100, 0.05, 10)).toBe(10);
  });

  it('should return the floor when the parent remaining budget is zero', () => {
    expect(shareBudget(0, 0.5, 10)).toBe(10);
  });

  it('should return the full parent budget when the ratio is 1', () => {
    expect(shareBudget(100, 1, 10)).toBe(100);
  });

  it('should return the floor when the ratio is 0', () => {
    expect(shareBudget(100, 0, 10)).toBe(10);
  });

  it('should return the floor when the calculated amount is exactly the floor', () => {
    expect(shareBudget(100, 0.1, 10)).toBe(10);
  });
});
