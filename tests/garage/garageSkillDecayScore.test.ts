import { describe, expect, it } from "vitest";

import { decayAgeDays, skillDecayScore } from '../../src/garage/garageSkillDecayScore.js';

const NOW = new Date(Date.UTC(2026, 6, 20));
const HALF_LIFE_DAYS = 14;

describe("skillDecayScore — exponential half-life decay by unused age", () => {
  it("is 1.0 at age 0 (just used)", () => {
    expect(skillDecayScore(NOW, NOW, HALF_LIFE_DAYS)).toBe(1);
  });

  it("halves after exactly one halfLife", () => {
    const oneHalfLater = new Date(NOW.getTime() + HALF_LIFE_DAYS * 86_400_000);
    expect(skillDecayScore(NOW, oneHalfLater, HALF_LIFE_DAYS)).toBeCloseTo(0.5, 6);
  });

  it("quarters after two halfLives", () => {
    const twoHalfLater = new Date(NOW.getTime() + 2 * HALF_LIFE_DAYS * 86_400_000);
    expect(skillDecayScore(NOW, twoHalfLater, HALF_LIFE_DAYS)).toBeCloseTo(0.25, 6);
  });

  it("older unused ⇒ strictly lower score (30d vs 7d, same halfLife)", () => {
    const seven = new Date(NOW.getTime() + 7 * 86_400_000);
    const thirty = new Date(NOW.getTime() + 30 * 86_400_000);
    const s7 = skillDecayScore(NOW, seven, HALF_LIFE_DAYS);
    const s30 = skillDecayScore(NOW, thirty, HALF_LIFE_DAYS);
    expect(s30).toBeLessThan(s7);
  });

  it("honors floor: a very old skill returns exactly the floor", () => {
    const veryOld = new Date(NOW.getTime() + 365 * 86_400_000);
    const raw = skillDecayScore(NOW, veryOld, HALF_LIFE_DAYS);
    expect(raw).toBeLessThan(0.2); // raw is below the floor without it
    expect(skillDecayScore(NOW, veryOld, HALF_LIFE_DAYS, 0.2)).toBe(0.2);
  });

  it("floor only raises, never lowers: above-floor score is unaffected", () => {
    const oneHalfLater = new Date(NOW.getTime() + HALF_LIFE_DAYS * 86_400_000);
    expect(skillDecayScore(NOW, oneHalfLater, HALF_LIFE_DAYS, 0.2)).toBeCloseTo(0.5, 6);
  });

  it("clock skew safety: now < lastUsedAt ⇒ score 1 (age clamped to 0), no NaN, no throw", () => {
    const earlier = new Date(NOW.getTime() - 10 * 86_400_000);
    const score = skillDecayScore(NOW, earlier, HALF_LIFE_DAYS);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBe(1);
  });

  it("throws RangeError on non-positive or non-finite halfLife", () => {
    expect(() => skillDecayScore(NOW, NOW, 0)).toThrow(RangeError);
    expect(() => skillDecayScore(NOW, NOW, -1)).toThrow(RangeError);
    expect(() => skillDecayScore(NOW, NOW, Number.NaN)).toThrow(RangeError);
    expect(() => skillDecayScore(NOW, NOW, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("throws RangeError on out-of-range or non-finite floor", () => {
    const later = new Date(NOW.getTime() + 365 * 86_400_000);
    expect(() => skillDecayScore(NOW, later, HALF_LIFE_DAYS, -0.1)).toThrow(RangeError);
    expect(() => skillDecayScore(NOW, later, HALF_LIFE_DAYS, 1.1)).toThrow(RangeError);
    expect(() => skillDecayScore(NOW, later, HALF_LIFE_DAYS, Number.NaN)).toThrow(RangeError);
    expect(() => skillDecayScore(NOW, later, HALF_LIFE_DAYS, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("options-object and positional signatures return identical results", () => {
    const later = new Date(NOW.getTime() + 21 * 86_400_000);
    const positional = skillDecayScore(NOW, later, HALF_LIFE_DAYS, 0.1);
    const optionsForm = skillDecayScore({
      lastUsedAt: NOW,
      now: later,
      halfLifeDays: HALF_LIFE_DAYS,
      floor: 0.1
    });
    expect(optionsForm).toBe(positional);
  });

  it("returned score is always finite and within [max(0,floor), 1]", () => {
    const checks = [
      skillDecayScore(NOW, NOW, HALF_LIFE_DAYS),
      skillDecayScore(NOW, new Date(NOW.getTime() + 365 * 86_400_000), HALF_LIFE_DAYS),
      skillDecayScore(NOW, new Date(NOW.getTime() + 365 * 86_400_000), HALF_LIFE_DAYS, 0.3)
    ];
    for (const s of checks) {
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

describe("decayAgeDays — clamped non-negative fractional age", () => {
  it("returns fractional age in days", () => {
    const later = new Date(NOW.getTime() + 1.5 * 86_400_000);
    expect(decayAgeDays(NOW, later)).toBeCloseTo(1.5, 6);
  });

  it("clamps to 0 when now < lastUsedAt (clock skew)", () => {
    const earlier = new Date(NOW.getTime() - 5 * 86_400_000);
    expect(decayAgeDays(NOW, earlier)).toBe(0);
  });

  it("returns 0 when now === lastUsedAt", () => {
    expect(decayAgeDays(NOW, NOW)).toBe(0);
  });
});
