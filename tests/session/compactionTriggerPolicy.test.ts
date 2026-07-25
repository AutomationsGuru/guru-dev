import { describe, it, expect } from 'vitest';
import { shouldTriggerCompaction, type CompactionContext } from '../../src/session/compactionTriggerPolicy.js';

describe('shouldTriggerCompaction', () => {
  const baseContext: Omit<CompactionContext, 'messageCount' | 'totalTokens'> = {
    messageHighWatermark: 100,
    messageLowWatermark: 50,
    tokenHighWatermark: 20000,
    tokenLowWatermark: 10000,
    compactionCancelled: false,
    compactionSurvived: false,
    previousShouldTrigger: false,
  };

  it('returns false when both counts are below high watermarks', () => {
    const ctx: CompactionContext = {
      ...baseContext,
      messageCount: 42,
      totalTokens: 8000,
    };
    const decision = shouldTriggerCompaction(ctx);
    expect(decision.shouldTrigger).toBe(false);
    expect(decision.reason).toBe('Below low watermarks');
  });

  it('triggers when message count exceeds high watermark', () => {
    const ctx: CompactionContext = {
      ...baseContext,
      messageCount: 101,
      totalTokens: 5000,
    };
    const decision = shouldTriggerCompaction(ctx);
    expect(decision.shouldTrigger).toBe(true);
    expect(decision.reason).toBe('High watermark breached');
  });

  it('triggers when token count exceeds high watermark', () => {
    const ctx: CompactionContext = {
      ...baseContext,
      messageCount: 10,
      totalTokens: 25000,
    };
    const decision = shouldTriggerCompaction(ctx);
    expect(decision.shouldTrigger).toBe(true);
    expect(decision.reason).toBe('High watermark breached');
  });

  it('triggers when both exceed high watermarks', () => {
    const ctx: CompactionContext = {
      ...baseContext,
      messageCount: 150,
      totalTokens: 30000,
    };
    const decision = shouldTriggerCompaction(ctx);
    expect(decision.shouldTrigger).toBe(true);
    expect(decision.reason).toBe('High watermark breached');
  });

  it('does not trigger when compaction is cancelled, even if high watermarks exceeded', () => {
    const ctx: CompactionContext = {
      ...baseContext,
      messageCount: 200,
      totalTokens: 50000,
      compactionCancelled: true,
    };
    const decision = shouldTriggerCompaction(ctx);
    expect(decision.shouldTrigger).toBe(false);
    expect(decision.reason).toBe('Compaction cancelled by user');
  });

  it('does not re-trigger after survival until next high watermark breach', () => {
    const ctxBelow: CompactionContext = {
      ...baseContext,
      messageCount: 60,
      totalTokens: 12000,
      compactionSurvived: true,
    };
    const decisionBelow = shouldTriggerCompaction(ctxBelow);
    expect(decisionBelow.shouldTrigger).toBe(false);
    expect(decisionBelow.reason).toBe('Awaiting next high watermark breach after survival');

    const ctxAbove: CompactionContext = {
      ...baseContext,
      messageCount: 120,
      totalTokens: 8000,
      compactionSurvived: true,
    };
    const decisionAbove = shouldTriggerCompaction(ctxAbove);
    expect(decisionAbove.shouldTrigger).toBe(true);
    expect(decisionAbove.reason).toBe('High watermark breached after previous compaction survived');
  });

  it('maintains trigger (hysteresis) while still above low watermark after initial breach', () => {
    const ctxHigh: CompactionContext = {
      ...baseContext,
      messageCount: 120,
      totalTokens: 15000,
      previousShouldTrigger: false,
    };
    const first = shouldTriggerCompaction(ctxHigh);
    expect(first.shouldTrigger).toBe(true);

    // Now counts dropped a bit but still above low; previous true => stay triggered
    const ctxMid: CompactionContext = {
      ...baseContext,
      messageCount: 70,
      totalTokens: 12000,
      previousShouldTrigger: true,
    };
    const mid = shouldTriggerCompaction(ctxMid);
    expect(mid.shouldTrigger).toBe(true);
    expect(mid.reason).toBe('Hysteresis: still above low watermark(s)');
  });

  it('releases trigger once context drops below all low watermarks', () => {
    const ctx: CompactionContext = {
      ...baseContext,
      messageCount: 30,
      totalTokens: 5000,
      previousShouldTrigger: true,
    };
    const decision = shouldTriggerCompaction(ctx);
    expect(decision.shouldTrigger).toBe(false);
    expect(decision.reason).toBe('Below low watermarks');
  });

  it('handles exact boundary values (high is strict >, low is strict <)', () => {
    const ctxAtHigh: CompactionContext = {
      ...baseContext,
      messageCount: 100, // not > 100
      totalTokens: 20000,
    };
    expect(shouldTriggerCompaction(ctxAtHigh).shouldTrigger).toBe(false);

    const ctxJustBelowLow: CompactionContext = {
      ...baseContext,
      messageCount: 50, // not < 50
      totalTokens: 10000,
      previousShouldTrigger: true,
    };
    // still not below => keep if previous
    expect(shouldTriggerCompaction(ctxJustBelowLow).shouldTrigger).toBe(true);
  });
});
