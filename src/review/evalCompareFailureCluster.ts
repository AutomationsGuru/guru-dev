/**
 * IDEA-F504-CMP-01 — R-GAC-CMP.
 *
 * Pure eval-compare and failure-clustering for two grade files. This is the
 * GuruHarness-native "compare + analyze" step of the eval lifecycle (sibling to
 * F503's generate-grade and F505's prompt-optimize gate). It owns its own
 * grade-file shape: F503's producer runs in a separate worktree and is not yet
 * on this base tip, so this module declares the canonical `GradeFile` type
 * rather than importing a sibling's not-yet-merged output.
 *
 * Everything here is a pure, synchronous transform over plain data — no model
 * calls, no I/O, no framework. Inputs are in-memory; `parseGradeFile` is the
 * only JSON-shaped entry point and it lives behind a typed schema so callers
 * cannot hand unvalidated data to the clusterer.
 */

export type ReasonTag = string;

/**
 * A single graded case inside a grade file. The `reason` is the short,
 * normalized failure classification (e.g. "timeout", "wrong-branch",
 * "assertion") that `clusterFailures` groups on. A passing case carries an
 * empty reason.
 */
export interface GradeCaseResult {
  /** Stable identity of the eval case across runs (what compare matches on). */
  readonly caseId: string;
  /** Pass/fail signal — the only field compare flips into a regression. */
  readonly passed: boolean;
  /** Numeric grade in [0,1]; 1 == perfect. Defaults to passed ? 1 : 0. */
  readonly score?: number;
  /** Normalized failure classification; empty for a passing case. */
  readonly reason: ReasonTag;
}

export interface GradeFile {
  /** Which eval run produced this file (e.g. a commit SHA or run label). */
  readonly runId: string;
  /** Optional human label for the run, surfaced in compare summaries. */
  readonly label?: string;
  readonly cases: readonly GradeCaseResult[];
}

/** One bucket of failures sharing a normalized reason tag. */
export interface FailureCluster {
  readonly reason: ReasonTag;
  readonly count: number;
  /** caseIds that failed with this reason, stable-sorted. */
  readonly caseIds: readonly string[];
}

/** The result of clustering a single grade file's failures. */
export interface FailureClusterReport {
  readonly runId: string;
  readonly totalCases: number;
  readonly failed: number;
  readonly passed: number;
  readonly meanScore: number;
  readonly clusters: readonly FailureCluster[];
  /** Clusters sorted by descending count, then ascending reason for determinism. */
}

/** Direction of change for a case between resultA (before) and resultB (after). */
export type CaseDeltaKind = "regression" | "improvement" | "stable-pass" | "stable-fail" | "added" | "removed";

export interface CaseDelta {
  readonly caseId: string;
  readonly kind: CaseDeltaKind;
  readonly scoreBefore?: number;
  readonly scoreAfter?: number;
  /** Reason carried by whichever side is the failure (after for regression, before for improvement). */
  readonly reason: ReasonTag;
}

export interface EvalCompareReport {
  readonly runIdBefore: string;
  readonly runIdAfter: string;
  readonly failedBefore: number;
  readonly failedAfter: number;
  readonly passedBefore: number;
  readonly passedAfter: number;
  readonly meanScoreBefore: number;
  readonly meanScoreAfter: number;
  readonly regressions: number;
  readonly improvements: number;
  readonly added: number;
  readonly removed: number;
  /** True when any case went from passing (or absent) to failing. */
  readonly regressionDetected: boolean;
  readonly deltas: readonly CaseDelta[];
  /**
   * Aggregated failure-reason movement between the two runs: how each reason
   * tag's failing-case count changed (after − before). Negative == fewer
   * failures (good); positive == more (bad).
   */
  readonly reasonDeltas: readonly ReasonDelta[];
}

export interface ReasonDelta {
  readonly reason: ReasonTag;
  readonly before: number;
  readonly after: number;
  readonly delta: number;
}

const DEFAULT_PASS_SCORE = 1;
const DEFAULT_FAIL_SCORE = 0;

/** Clamp a score to [0,1] so a malformed grade file can never skew the mean. */
function clampScore(score: number): number {
  if (Number.isNaN(score)) {
    return DEFAULT_FAIL_SCORE;
  }
  return Math.min(DEFAULT_PASS_SCORE, Math.max(DEFAULT_FAIL_SCORE, score));
}

function effectiveScore(c: GradeCaseResult): number {
  return c.score === undefined ? (c.passed ? DEFAULT_PASS_SCORE : DEFAULT_FAIL_SCORE) : clampScore(c.score);
}

/** Normalize a reason tag: trimmed, lowercased, empty → "uncategorized". */
export function normalizeReason(reason: unknown): ReasonTag {
  if (typeof reason !== "string") {
    return "uncategorized";
  }
  const trimmed = reason.trim().toLowerCase();
  return trimmed.length === 0 ? "uncategorized" : trimmed;
}

/** Sum / mean over the cases of one grade file. */
function meanScore(cases: readonly GradeCaseResult[]): number {
  if (cases.length === 0) {
    return 0;
  }
  const total = cases.reduce((sum, c) => sum + effectiveScore(c), 0);
  return total / cases.length;
}

/**
 * Cluster a grade file's failures by normalized reason tag. Pure and
 * deterministic: clusters are sorted by descending count, then ascending
 * reason. Passing cases are excluded.
 */
export function clusterFailures(file: GradeFile): FailureClusterReport {
  const buckets = new Map<ReasonTag, string[]>();

  let failed = 0;
  for (const c of file.cases) {
    if (c.passed) {
      continue;
    }
    failed += 1;
    const tag = normalizeReason(c.reason);
    const bucket = buckets.get(tag);
    if (bucket) {
      bucket.push(c.caseId);
    } else {
      buckets.set(tag, [c.caseId]);
    }
  }

  const clusters: FailureCluster[] = Array.from(buckets.entries())
    .map(([reason, caseIds]) => ({
      reason,
      count: caseIds.length,
      caseIds: [...caseIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    }))
    .sort((a, b) => (b.count - a.count !== 0 ? b.count - a.count : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));

  return {
    runId: file.runId,
    totalCases: file.cases.length,
    failed,
    passed: file.cases.length - failed,
    meanScore: meanScore(file.cases),
    clusters
  };
}

type IndexedCase = { caseId: string; c: GradeCaseResult };

function indexByCaseId(cases: readonly GradeCaseResult[]): Map<string, GradeCaseResult> {
  const index = new Map<string, GradeCaseResult>();
  for (const c of cases) {
    index.set(c.caseId, c);
  }
  return index;
}

function classifyDelta(
  caseId: string,
  before: GradeCaseResult | undefined,
  after: GradeCaseResult | undefined
): CaseDelta | undefined {
  if (before && after) {
    if (before.passed && !after.passed) {
      return { caseId, kind: "regression", scoreBefore: effectiveScore(before), scoreAfter: effectiveScore(after), reason: normalizeReason(after.reason) };
    }
    if (!before.passed && after.passed) {
      return { caseId, kind: "improvement", scoreBefore: effectiveScore(before), scoreAfter: effectiveScore(after), reason: normalizeReason(before.reason) };
    }
    const kind: CaseDeltaKind = after.passed ? "stable-pass" : "stable-fail";
    // Only surface stable rows that carry information — a score change counts,
    // an unchanged stable row is omitted to keep deltas focused on movement.
    if (effectiveScore(before) !== effectiveScore(after)) {
      return { caseId, kind, scoreBefore: effectiveScore(before), scoreAfter: effectiveScore(after), reason: normalizeReason(after.reason) };
    }
    return undefined;
  }
  if (after && !before) {
    return { caseId, kind: "added", scoreAfter: effectiveScore(after), reason: after.passed ? "" : normalizeReason(after.reason) };
  }
  if (before && !after) {
    return { caseId, kind: "removed", scoreBefore: effectiveScore(before), reason: before.passed ? "" : normalizeReason(before.reason) };
  }
  return undefined;
}

/** Count failing cases per normalized reason tag for one grade file. */
function reasonCounts(cases: readonly GradeCaseResult[]): Map<ReasonTag, number> {
  const counts = new Map<ReasonTag, number>();
  for (const c of cases) {
    if (c.passed) {
      continue;
    }
    const tag = normalizeReason(c.reason);
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
}

/**
 * Compare two grade files (before/after). Pure and deterministic. The union of
 * caseIds is iterated in sorted order so the deltas array is stable across
 * runs. `regressionDetected` is the headline signal: any case that went from
 * passing (or absent) to failing.
 */
export function compareGradeFiles(before: GradeFile, after: GradeFile): EvalCompareReport {
  const beforeIndex = indexByCaseId(before.cases);
  const afterIndex = indexByCaseId(after.cases);

  const caseIds = new Set<string>([...beforeIndex.keys(), ...afterIndex.keys()]);
  const orderedIds = Array.from(caseIds).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const deltas: CaseDelta[] = [];
  for (const caseId of orderedIds) {
    const delta = classifyDelta(caseId, beforeIndex.get(caseId), afterIndex.get(caseId));
    if (delta) {
      deltas.push(delta);
    }
  }

  const beforeCounts = reasonCounts(before.cases);
  const afterCounts = reasonCounts(after.cases);
  const reasonKeys = new Set<ReasonTag>([...beforeCounts.keys(), ...afterCounts.keys()]);
  const reasonDeltas: ReasonDelta[] = Array.from(reasonKeys)
    .map((reason) => {
      const b = beforeCounts.get(reason) ?? 0;
      const a = afterCounts.get(reason) ?? 0;
      return { reason, before: b, after: a, delta: a - b };
    })
    .sort((x, y) => (y.delta !== x.delta ? y.delta - x.delta : x.reason < y.reason ? -1 : x.reason > y.reason ? 1 : 0));

  const failedBefore = countFailed(before.cases);
  const failedAfter = countFailed(after.cases);

  return {
    runIdBefore: before.runId,
    runIdAfter: after.runId,
    failedBefore,
    failedAfter,
    passedBefore: before.cases.length - failedBefore,
    passedAfter: after.cases.length - failedAfter,
    meanScoreBefore: meanScore(before.cases),
    meanScoreAfter: meanScore(after.cases),
    regressions: deltas.filter((d) => d.kind === "regression").length,
    improvements: deltas.filter((d) => d.kind === "improvement").length,
    added: deltas.filter((d) => d.kind === "added").length,
    removed: deltas.filter((d) => d.kind === "removed").length,
    regressionDetected: deltas.some((d) => d.kind === "regression" || (d.kind === "added" && !afterIndex.get(d.caseId)?.passed)),
    deltas,
    reasonDeltas
  };
}

function countFailed(cases: readonly GradeCaseResult[]): number {
  return cases.reduce((n, c) => (c.passed ? n : n + 1), 0);
}

/**
 * Parse unvalidated JSON (e.g. a grade file on disk) into a typed GradeFile.
 * Throws a descriptive Error on any structural problem rather than returning a
 * half-shaped object to the pure transforms above. Kept permissive on optional
 * fields (score, label) and strict on the ones the clusterer depends on.
 */
export function parseGradeFile(input: unknown): GradeFile {
  if (typeof input !== "object" || input === null) {
    throw new Error("grade file must be an object");
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.runId !== "string" || raw.runId.length === 0) {
    throw new Error("grade file runId must be a non-empty string");
  }
  if (!Array.isArray(raw.cases)) {
    throw new Error("grade file cases must be an array");
  }

  const label = raw.label;
  const cases: GradeCaseResult[] = raw.cases.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`grade file case[${i}] must be an object`);
    }
    const c = entry as Record<string, unknown>;
    if (typeof c.caseId !== "string" || c.caseId.length === 0) {
      throw new Error(`grade file case[${i}].caseId must be a non-empty string`);
    }
    if (typeof c.passed !== "boolean") {
      throw new Error(`grade file case[${i}].passed must be a boolean`);
    }
    const reason = normalizeReason(c.reason);
    const score = c.score;
    const result: GradeCaseResult = { caseId: c.caseId, passed: c.passed, reason };
    if (typeof score === "number") {
      return { ...result, score: clampScore(score) };
    }
    return result;
  });

  return label !== undefined && typeof label === "string" ? { runId: raw.runId, label, cases } : { runId: raw.runId, cases };
}
