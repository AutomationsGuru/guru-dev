import { describe, it, expect } from 'vitest';
import { TurnRequestTracker } from '../../src/runtime/maxRequestsPerTurn.js';

describe('TurnRequestTracker', () => {
  it('should initialize with default max requests of 50', () => {
    const tracker = new TurnRequestTracker();
    
    // Simulate 49 requests
    for (let i = 0; i < 49; i++) {
      tracker.recordRequest();
    }
    expect(tracker.needsContinue()).toBe(false);
    
    // 50th request triggers the gate
    tracker.recordRequest();
    expect(tracker.needsContinue()).toBe(true);
  });

  it('should support configuring a custom max limit', () => {
    const tracker = new TurnRequestTracker(3);
    
    tracker.recordRequest();
    tracker.recordRequest();
    expect(tracker.needsContinue()).toBe(false);
    
    tracker.recordRequest();
    expect(tracker.needsContinue()).toBe(true);
  });

  it('continueTurn should clear the gate but keep total count', () => {
    const tracker = new TurnRequestTracker(2);
    
    tracker.recordRequest();
    tracker.recordRequest();
    expect(tracker.needsContinue()).toBe(true);
    expect(tracker.getTotalRequests()).toBe(2);
    
    tracker.continueTurn();
    
    expect(tracker.needsContinue()).toBe(false);
    expect(tracker.getTotalRequests()).toBe(2);
    
    tracker.recordRequest();
    expect(tracker.needsContinue()).toBe(false);
    expect(tracker.getTotalRequests()).toBe(3);
    
    tracker.recordRequest();
    expect(tracker.needsContinue()).toBe(true);
    expect(tracker.getTotalRequests()).toBe(4);
  });

  it('resetTurn should clear the gate and the total count', () => {
    const tracker = new TurnRequestTracker(2);
    
    tracker.recordRequest();
    tracker.recordRequest();
    tracker.continueTurn();
    tracker.recordRequest();
    
    expect(tracker.getTotalRequests()).toBe(3);
    expect(tracker.needsContinue()).toBe(false);
    
    tracker.resetTurn();
    
    expect(tracker.getTotalRequests()).toBe(0);
    expect(tracker.needsContinue()).toBe(false);
    
    tracker.recordRequest();
    tracker.recordRequest();
    expect(tracker.needsContinue()).toBe(true);
  });
});
