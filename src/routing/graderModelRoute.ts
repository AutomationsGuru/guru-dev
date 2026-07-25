/**
 * Grader model route (IDEA-F210-GRADER-MODEL-01 / F210, composes F104 workflow
 * slots). Binds an optional provider/model pair used to grade goals and
 * rubrics, plus a max grading-iteration budget. When no grader override is
 * set, resolution falls back to the caller's normal model slot so grading
 * always runs on a real route (Foundational Law 1: guru + a model connection).
 *
 * Hard rule (deepagents-dcode REVIEW): the grader never auto-approves
 * hard-limit tools; this module only picks *which model grades*, not whether
 * a tool call is allowed.
 */

/** A named model slot available in the session (F104 workflow slots). */
export interface ModelSlot {
  /** Slot name, e.g. "default", "planner", "grader". */
  readonly name: string;
  /** Provider id, e.g. "openai-compatible". */
  readonly provider: string;
  /** Provider-specific model identifier. */
  readonly model: string;
}

/** A resolved grader route: which slot to grade with, and the iteration cap. */
export interface GraderRoute {
  /** Provider id of the resolved grading model. */
  readonly provider: string;
  /** Model id of the resolved grading model. */
  readonly model: string;
  /** True when an explicit grader override was used; false on slot fallback. */
  readonly overridden: boolean;
  /** Maximum auto grading iterations before the goal surfaces as blocked. */
  readonly maxIterations: number;
}

/** Smallest sane default: one grade, no silent auto re-grade loops. */
export const DEFAULT_MAX_GRADING_ITERATIONS = 3;

export interface GraderModelRoute {
  /** Bind an explicit grader provider/model override. */
  setGrader(provider: string, model: string): void;
  /** Remove the grader override; resolve() falls back to the normal slot. */
  clearGrader(): void;
  /** Set the max auto grading iterations (positive integer). */
  setMaxIterations(maxIterations: number): void;
  /**
   * Resolve the grading route against the session's slots. If an override is
   * bound it wins; otherwise the normal slot is used unchanged.
   */
  resolve(normalSlot: ModelSlot): GraderRoute;
  /** Current override, or undefined when cleared/never set. */
  getGrader(): { provider: string; model: string } | undefined;
  /** Current max grading iterations. */
  getMaxIterations(): number;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`graderModelRoute: ${field} must be a non-empty string.`);
  }
}

/**
 * Create a grader model route. Pure and synchronous — no provider I/O; route
 * resolution is config-shaped so tests and the F104 slot registry can compose
 * it without network access.
 */
export function createGraderModelRoute(
  maxIterations: number = DEFAULT_MAX_GRADING_ITERATIONS
): GraderModelRoute {
  assertPositiveInt(maxIterations);

  let grader: { provider: string; model: string } | undefined;
  let maxIters = maxIterations;

  return {
    setGrader(provider, model) {
      assertNonEmpty(provider, "provider");
      assertNonEmpty(model, "model");
      grader = { provider: provider.trim(), model: model.trim() };
    },

    clearGrader() {
      grader = undefined;
    },

    setMaxIterations(next) {
      assertPositiveInt(next);
      maxIters = next;
    },

    resolve(normalSlot) {
      if (grader !== undefined) {
        return {
          provider: grader.provider,
          model: grader.model,
          overridden: true,
          maxIterations: maxIters
        };
      }
      return {
        provider: normalSlot.provider,
        model: normalSlot.model,
        overridden: false,
        maxIterations: maxIters
      };
    },

    getGrader() {
      return grader;
    },

    getMaxIterations() {
      return maxIters;
    }
  };
}

function assertPositiveInt(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`graderModelRoute: maxIterations must be a positive integer, got ${value}.`);
  }
}
