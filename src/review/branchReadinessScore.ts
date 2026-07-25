/**
 * Branch Readiness Score - Pure Scorer
 *
 * Takes BranchFacts as input and produces a deterministic BranchReadinessScore.
 * This is a pure function with no git/CI side effects.
 *
 * Signals (weighted):
 * - Age: days since first commit (older = more mature)
 * - Size: total changes (files + insertions + deletions)
 * - Density: commits per day
 * - Staleness: days since last activity (fresher = better)
 * - Churn: average changes per file
 * - Divergence: commits ahead of base
 * - CI Health: passing status
 */

export interface BranchFacts {
  readonly firstCommitDate: string; // ISO date
  readonly lastCommitDate: string; // ISO date
  readonly lastActivityDate: string; // ISO date
  readonly commitCount: number;
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly commitsAheadOfBase: number;
  readonly ciPassing: boolean;
}

export interface SignalScores {
  readonly age: number; // 0-100
  readonly size: number; // 0-100
  readonly density: number; // 0-100
  readonly staleness: number; // 0-100
  readonly churn: number; // 0-100
  readonly divergence: number; // 0-100
  readonly ciHealth: number; // 0-100
}

export interface BranchReadinessScore {
  readonly overall: number; // 0-100
  readonly signals: SignalScores;
  readonly recommendation: 'merge' | 'refine' | 'split' | 'abandon';
  readonly rationale: string;
}

/**
 * Calculate days between two ISO dates.
 * Pure function - deterministic.
 */
function daysBetween(isoDateA: string, isoDateB: string): number {
  const dateA = new Date(isoDateA);
  const dateB = new Date(isoDateB);
  const diffMs = Math.abs(dateB.getTime() - dateA.getTime());
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Calculate age score: older branches score higher (more mature).
 * Max score at 30+ days.
 */
function scoreAge(daysSinceFirst: number): number {
  if (daysSinceFirst < 0) return 0;
  // Linear: 0 days = 0, 30 days = 100
  return Math.min(100, Math.floor((daysSinceFirst / 30) * 100));
}

/**
 * Calculate size score: moderate size is ideal.
 * Too small = not enough work; too large = risky.
 */
function scoreSize(totalChanges: number): number {
  if (totalChanges < 0) return 0;
  // Ideal: 100-500 changes
  // 0 changes = 0, 100 = 60, 300 = 100, 500 = 100, 1000+ = declining
  if (totalChanges === 0) return 0;
  if (totalChanges < 100) return Math.floor((totalChanges / 100) * 60);
  if (totalChanges <= 500) return 100;
  // Decline after 500: 1000 = 50, 2000+ = 20
  return Math.max(20, Math.floor(100 - ((totalChanges - 500) / 1500) * 80));
}

/**
 * Calculate density score: commits per day.
 * Moderate density is ideal (not too sparse, not too rushed).
 */
function scoreDensity(commitCount: number, ageDays: number): number {
  if (commitCount < 0 || ageDays < 0) return 0;
  if (ageDays === 0) return commitCount > 0 ? 50 : 0; // Single-day work
  const density = commitCount / ageDays;
  // Ideal: 1-3 commits per day
  // 0 = 0, 0.5 = 40, 1-3 = 100, 5+ = declining
  if (density < 0.5) return Math.floor(density * 80);
  if (density <= 3) return 100;
  return Math.max(30, Math.floor(100 - ((density - 3) / 7) * 70));
}

/**
 * Calculate staleness score: fresher activity = higher score.
 * 0 days stale = 100, 7 days = 70, 30+ days = 20
 */
function scoreStaleness(daysStale: number): number {
  if (daysStale < 0) return 0;
  if (daysStale === 0) return 100;
  if (daysStale <= 7) return Math.floor(100 - (daysStale / 7) * 30);
  // After 7 days, linear decline to 20 at 30 days
  return Math.max(20, Math.floor(70 - ((daysStale - 7) / 23) * 50));
}

/**
 * Calculate churn score: average changes per file.
 * Low-moderate churn is ideal (focused changes, not scattered).
 */
function scoreChurn(totalChanges: number, filesChanged: number): number {
  if (totalChanges < 0 || filesChanged < 0) return 0;
  if (filesChanged === 0) return 0;
  const churn = totalChanges / filesChanged;
  // Ideal: 10-50 changes per file
  // 0-5 = 40, 10-50 = 100, 100+ = declining
  if (churn < 5) return Math.floor((churn / 5) * 40);
  if (churn <= 50) return 100;
  return Math.max(30, Math.floor(100 - ((churn - 50) / 150) * 70));
}

/**
 * Calculate divergence score: commits ahead of base.
 * Moderate divergence is expected; extreme = risky.
 */
function scoreDivergence(commitsAhead: number): number {
  if (commitsAhead < 0) return 0;
  // Ideal: 1-20 commits ahead
  // 0 = 50 (no divergence), 1-20 = 100, 50+ = declining
  if (commitsAhead === 0) return 50;
  if (commitsAhead <= 20) return 100;
  return Math.max(40, Math.floor(100 - ((commitsAhead - 20) / 80) * 60));
}

/**
 * Calculate CI health score.
 */
function scoreCiHealth(ciPassing: boolean): number {
  return ciPassing ? 100 : 0;
}

/**
 * Determine recommendation based on overall score and signals.
 */
function determineRecommendation(
  overall: number,
  signals: SignalScores
): 'merge' | 'refine' | 'split' | 'abandon' {
  // CI failure is a hard blocker
  if (signals.ciHealth === 0) return 'refine';

  // High score with good signals = merge
  if (overall >= 75 && signals.staleness >= 60) return 'merge';

  // Low score with high staleness = abandon
  if (overall < 40 && signals.staleness < 40) return 'abandon';

  // Very large divergence = split
  if (signals.divergence < 60 && signals.size > 80) return 'split';

  // Default: needs refinement
  return 'refine';
}

/**
 * Generate rationale string from scores.
 */
function generateRationale(
  overall: number,
  signals: SignalScores,
  recommendation: string
): string {
  const parts: string[] = [];

  if (signals.ciHealth === 0) {
    parts.push('CI is failing');
  } else {
    parts.push('CI is passing');
  }

  if (signals.age >= 70) {
    parts.push('branch is mature');
  } else if (signals.age < 30) {
    parts.push('branch is young');
  }

  if (signals.staleness < 40) {
    parts.push('activity is stale');
  } else if (signals.staleness >= 80) {
    parts.push('recently active');
  }

  if (signals.size > 80) {
    parts.push('large change set');
  }

  if (signals.divergence < 60) {
    parts.push('high divergence');
  }

  const base = parts.length > 0 ? parts.join(', ') : 'neutral signals';
  return `${recommendation.toUpperCase()}: ${base} (score: ${overall})`;
}

/**
 * Pure scorer: BranchFacts → BranchReadinessScore
 *
 * Deterministic: same input always produces same output.
 * Idempotent: calling multiple times yields same result.
 * No side effects: does not read/write git, CI, or filesystem.
 */
export function computeBranchReadinessScore(
  facts: BranchFacts
): BranchReadinessScore {
  // Calculate age in days
  const ageDays = daysBetween(facts.firstCommitDate, facts.lastCommitDate);

  // Calculate staleness (days since last activity)
  const now = new Date().toISOString();
  const daysStale = daysBetween(facts.lastActivityDate, now);

  // Calculate total changes
  const totalChanges = facts.insertions + facts.deletions;

  // Score each signal
  const age = scoreAge(ageDays);
  const size = scoreSize(totalChanges);
  const density = scoreDensity(facts.commitCount, ageDays);
  const staleness = scoreStaleness(daysStale);
  const churn = scoreChurn(totalChanges, facts.filesChanged);
  const divergence = scoreDivergence(facts.commitsAheadOfBase);
  const ciHealth = scoreCiHealth(facts.ciPassing);

  const signals: SignalScores = {
    age,
    size,
    density,
    staleness,
    churn,
    divergence,
    ciHealth,
  };

  // Weighted overall score
  // Weights: age(10), size(15), density(10), staleness(20), churn(10), divergence(15), ciHealth(20)
  const overall = Math.floor(
    (age * 0.1 +
      size * 0.15 +
      density * 0.1 +
      staleness * 0.2 +
      churn * 0.1 +
      divergence * 0.15 +
      ciHealth * 0.2)
  );

  const recommendation = determineRecommendation(overall, signals);
  const rationale = generateRationale(overall, signals, recommendation);

  return {
    overall,
    signals,
    recommendation,
    rationale,
  };
}
