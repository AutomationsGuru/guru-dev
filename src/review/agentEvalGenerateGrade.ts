/**
 * Agent eval generate-grade pipeline (R-GAC-EVAL · F503) — guru's OWN pure grading core.
 *
 * Given recorded traces over eval cases and a list of metrics, `grade()` produces a scores
 * map: one aggregate score per metric, plus per-metric pass/total counts and the failing
 * case evidence. It is **pure** (deterministic, no side effects, no I/O, no model calls) —
 * "score file pure" per R-GAC-EVAL. The one external seam is the metric *evaluator*: a pure
 * predicate that turns a (metric, trace) pair into a pass/fail outcome. A model-powered or
 * rubric evaluator can be ATTACHed through that seam later (F504/F505), but the grading core
 * never depends on one — it delegates evaluation and synthesizes the score itself.
 *
 * Grading is the synthesizer, not the judge: the verdict is computed in code, never model
 * discretion, mirroring the native-critic-panel rule that a result is GREEN only when the
 * evidence forces it.
 */

/** One recorded agent run over a single eval case (the "trace" half of generate+grade). */
export interface EvalTrace {
  readonly caseId: string;
  /** The agent's output / final answer for the case. */
  readonly output: string;
  /** Free-form observations captured during the run (tool calls, notes, errors). */
  readonly notes?: string;
}

/** The pass/fail outcome a metric's evaluator returns for a single trace. */
export interface MetricOutcome {
  readonly pass: boolean;
  readonly reason?: string;
}

/** A failing trace entry recorded under a metric (evidence, not just a count). */
export interface MetricFailure {
  readonly caseId: string;
  readonly reason: string;
}

/** One grading criterion. `evaluate` is optional: a metric without it cannot be graded. */
export interface EvalMetric {
  readonly id: string;
  readonly description: string;
  /**
   * Pure predicate: does this trace satisfy the metric? Optional so a metric list may name a
   * criterion that has no native evaluator yet (an honest "ungraded", never a silent pass).
   */
  readonly evaluate?: (trace: EvalTrace) => MetricOutcome;
}

/** The per-metric score row in the scores map. */
export interface MetricScore {
  /** Aggregate score in [0,1] = passed / total (0 when nothing was graded). */
  readonly score: number;
  readonly passed: number;
  readonly total: number;
  readonly failures: readonly MetricFailure[];
  /** True when the metric named a criterion the grading core has no evaluator for. */
  readonly ungraded: boolean;
}

/** A grade report. `scores` is keyed by metric id. */
export interface GradeReport {
  readonly scores: ReadonlyMap<string, MetricScore>;
  /** Mean of the GRADED metrics' scores (ungraded metrics excluded). */
  readonly overall: number;
  readonly metricsPassed: number;
  readonly metricsTotal: number;
}

/** The injected evaluation seam. Defaults to each metric's own `evaluate` predicate. */
export interface GradeDeps {
  /**
   * Override every metric's evaluator with one pure function (e.g. a model/rubric ATTACH).
   * When omitted, each metric's own `evaluate` predicate is used; metrics without one are
   * recorded as ungraded (score 0, total 0) rather than silently passed.
   */
  readonly evaluate?: (metric: EvalMetric, trace: EvalTrace) => MetricOutcome;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) {
    return 0;
  }
  if (n <= 0) {
    return 0;
  }
  if (n >= 1) {
    return 1;
  }
  return n;
}

/**
 * Grade `traces` against `metrics` → a scores map, pure. Each metric's score is the fraction
 * of traces that pass it; a metric a trace fails lowers that metric's score below 1.0. A
 * metric with no evaluator is reported ungraded (0, total 0) — never a silent perfect score.
 */
export function grade(traces: readonly EvalTrace[], metrics: readonly EvalMetric[], deps: GradeDeps = {}): GradeReport {
  const scores = new Map<string, MetricScore>();
  let gradedSum = 0;
  let gradedCount = 0;
  let metricsPassed = 0;

  for (const metric of metrics) {
    // Resolve this metric's evaluator: the injected override, else its own predicate, else none.
    const ownEval = metric.evaluate;
    const evaluator =
      deps.evaluate ??
      (ownEval
        ? (m: EvalMetric, t: EvalTrace): MetricOutcome => {
            const fn = m.evaluate;
            return fn ? fn(t) : { pass: false, reason: "no evaluator" };
          }
        : null);

    if (evaluator === null) {
      // Named criterion, no evaluator — honest ungraded, never a fake 1.0.
      scores.set(metric.id, { score: 0, passed: 0, total: 0, failures: [], ungraded: true });
      gradedCount += 0; // excluded from the overall mean
      continue;
    }

    let passed = 0;
    const failures: MetricFailure[] = [];
    for (const trace of traces) {
      let outcome: MetricOutcome;
      try {
        outcome = evaluator(metric, trace);
      } catch (error) {
        // A throwing evaluator is a failed grade for that trace, recorded with the reason —
        // never a crash that loses the rest of the run.
        outcome = { pass: false, reason: error instanceof Error ? error.message : String(error) };
      }
      if (outcome.pass) {
        passed += 1;
      } else {
        const reason = typeof outcome.reason === "string" && outcome.reason.length > 0 ? outcome.reason : "failed";
        failures.push({ caseId: trace.caseId, reason });
      }
    }

    const total = traces.length;
    const score = total > 0 ? clamp01(passed / total) : 0;
    scores.set(metric.id, { score, passed, total, failures, ungraded: false });
    if (total > 0) {
      gradedSum += score;
      gradedCount += 1;
      if (score >= 1) {
        metricsPassed += 1;
      }
    }
  }

  const overall = gradedCount > 0 ? gradedSum / gradedCount : 0;

  return {
    scores,
    overall,
    metricsPassed,
    metricsTotal: metrics.length
  };
}
