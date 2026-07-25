/**
 * Garage skill decay score (IDEA-F583-SDECAY-01, R-SDECAY-01). Pure score decay
 * by unused age with an optional floor; no auto-delete. Standard exponential
 * half-life decay: score starts at 1.0 when the skill was just used (age 0) and
 * halves every `halfLifeDays` of unused age. Deterministic, no I/O.
 */

const MS_PER_DAY = 86_400_000;

/** Base score at age 0 — the skill is fully relevant the instant it was used. */
const BASE_SCORE = 1;

export interface SkillDecayOptions {
  readonly lastUsedAt: Date;
  readonly now: Date;
  /** Half-life in days (must be > 0). Score halves every `halfLifeDays` unused. */
  readonly halfLifeDays: number;
  /** Optional minimum score; default 0 (no floor). Must be finite and in [0,1]. */
  readonly floor?: number;
}

/**
 * Unused age in days, clamped to [0, ∞). Clock-skew safe: a `now` before
 * `lastUsedAt` (future last-used) yields 0 rather than a negative number or NaN.
 */
export function decayAgeDays(lastUsedAt: Date, now: Date): number {
  return Math.max(0, (now.getTime() - lastUsedAt.getTime()) / MS_PER_DAY);
}

function assertHalfLife(halfLifeDays: number): void {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    throw new RangeError(`halfLifeDays must be a positive finite number of days (got ${String(halfLifeDays)})`);
  }
}

function assertFloor(floor: number): void {
  if (!Number.isFinite(floor) || floor < 0 || floor > 1) {
    throw new RangeError(`floor must be a finite number in [0, 1] (got ${String(floor)})`);
  }
}

/**
 * Garage skill decay score by unused age. Pure, deterministic, no I/O.
 *
 * Formula: `BASE_SCORE * 0.5 ** (ageDays / halfLifeDays)` where
 * `ageDays = max(0, (now - lastUsedAt) / MS_PER_DAY)`. The result is clamped to
 * `[max(0, floor), 1]`. Never throws on bad clock input (clock skew clamps age
 * to 0); the only structural misuse is a non-positive or non-finite half-life,
 * which throws `RangeError`. An out-of-range/non-finite floor also throws.
 */
export function skillDecayScore(opts: SkillDecayOptions): number;
export function skillDecayScore(lastUsedAt: Date, now: Date, halfLifeDays: number, floor?: number): number;
export function skillDecayScore(
  lastUsedAtOrOpts: Date | SkillDecayOptions,
  now?: Date,
  halfLifeDays?: number,
  floor?: number
): number {
  let lastUsedAt: Date;
  if (lastUsedAtOrOpts instanceof Date) {
    lastUsedAt = lastUsedAtOrOpts;
    if (now === undefined || halfLifeDays === undefined) {
      throw new TypeError("skillDecayScore positional form requires (lastUsedAt, now, halfLifeDays[, floor])");
    }
  } else {
    lastUsedAt = lastUsedAtOrOpts.lastUsedAt;
    now = lastUsedAtOrOpts.now;
    halfLifeDays = lastUsedAtOrOpts.halfLifeDays;
    floor = lastUsedAtOrOpts.floor;
  }

  assertHalfLife(halfLifeDays as number);
  if (floor !== undefined) {
    assertFloor(floor);
  }

  const ageDays = decayAgeDays(lastUsedAt, now as Date);
  const decayed = BASE_SCORE * 0.5 ** (ageDays / (halfLifeDays as number));
  const floorValue = floor ?? 0;
  // ageDays ≥ 0 ⇒ decayed ≤ BASE_SCORE = 1; the clamp upper bound is a safety net.
  const clamped = Math.min(BASE_SCORE, Math.max(floorValue, decayed));
  return clamped;
}
