import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolFailCircuitBreaker } from '../../src/tools/toolFailCircuitBreaker.js';

describe('ToolFailCircuitBreaker', () => {
  let breaker: ToolFailCircuitBreaker;
  const TOOL = 'test-tool';

  beforeEach(() => {
    vi.useFakeTimers();
    breaker = new ToolFailCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows calls when CLOSED (initial state)', () => {
    expect(breaker.mayCall(TOOL)).toBe(true);
  });

  it('opens after N consecutive failures', () => {
    breaker.recordFailure(TOOL);
    expect(breaker.mayCall(TOOL)).toBe(true);
    expect(breaker.getState(TOOL).state).toBe('CLOSED');

    breaker.recordFailure(TOOL);
    expect(breaker.mayCall(TOOL)).toBe(true);

    breaker.recordFailure(TOOL); // 3rd failure reaches threshold
    expect(breaker.getState(TOOL).state).toBe('OPEN');
    expect(breaker.mayCall(TOOL)).toBe(false);
  });

  it('stays open during cooldown', () => {
    // Trip the breaker
    for (let i = 0; i < 3; i++) breaker.recordFailure(TOOL);
    expect(breaker.mayCall(TOOL)).toBe(false);

    // Advance time but not past cooldown
    vi.advanceTimersByTime(500);
    expect(breaker.mayCall(TOOL)).toBe(false);
    expect(breaker.getState(TOOL).state).toBe('OPEN');
  });

  it('transitions to HALF_OPEN after cooldown and allows a probe call', () => {
    // Trip the breaker
    for (let i = 0; i < 3; i++) breaker.recordFailure(TOOL);
    expect(breaker.mayCall(TOOL)).toBe(false);

    // Advance past cooldown
    vi.advanceTimersByTime(1000);
    expect(breaker.mayCall(TOOL)).toBe(true);
    expect(breaker.getState(TOOL).state).toBe('HALF_OPEN');
  });

  it('closes on success after HALF_OPEN probe', () => {
    // Trip and wait for half-open
    for (let i = 0; i < 3; i++) breaker.recordFailure(TOOL);
    vi.advanceTimersByTime(1000);
    expect(breaker.mayCall(TOOL)).toBe(true);
    expect(breaker.getState(TOOL).state).toBe('HALF_OPEN');

    // Success should close it
    breaker.recordSuccess(TOOL);
    expect(breaker.getState(TOOL).state).toBe('CLOSED');
    expect(breaker.mayCall(TOOL)).toBe(true);
  });

  it('re-opens on failure during HALF_OPEN probe', () => {
    // Trip and wait for half-open
    for (let i = 0; i < 3; i++) breaker.recordFailure(TOOL);
    vi.advanceTimersByTime(1000);
    expect(breaker.mayCall(TOOL)).toBe(true);
    expect(breaker.getState(TOOL).state).toBe('HALF_OPEN');

    // Failure during probe re-opens
    breaker.recordFailure(TOOL);
    expect(breaker.getState(TOOL).state).toBe('OPEN');
    expect(breaker.mayCall(TOOL)).toBe(false);
  });

  it('resets on success while CLOSED', () => {
    breaker.recordFailure(TOOL);
    breaker.recordSuccess(TOOL);
    expect(breaker.getState(TOOL).consecutiveFailures).toBe(0);
    expect(breaker.getState(TOOL).state).toBe('CLOSED');
  });
});
