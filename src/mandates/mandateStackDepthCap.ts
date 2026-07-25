/**
 * Mandate stack depth cap (R-MDEPTH-01) — nested mandate inheritance cannot
 * exceed a bounded max depth; overflow fails closed with a structured error,
 * never a silent stop. Mirrors the swarm recursion ceiling (§9 / §17 S5):
 * ceilings are configuration, hard-capped here so a bad config cannot weaken
 * the limit.
 */

/** Hard ceiling a config can never exceed — hard limits are never weakened. */
export const MANDATE_STACK_DEPTH_HARD_MAX = 8;

/** Structured error when a push would exceed the mandate stack depth cap. */
export class MandateStackDepthExceededError extends Error {
  readonly code = "mandate_stack_depth_exceeded";
  constructor(
    readonly depth: number,
    readonly limit: number
  ) {
    super(`Mandate stack depth ${depth} exceeds the limit of ${limit} — nested mandate inheritance cannot exceed max depth.`);
    this.name = "MandateStackDepthExceededError";
  }
}

export interface MandateStackDepthCapOptions {
  /** Max nesting depth (default 3). Values above the hard max are clamped down. */
  readonly maxDepth?: number;
}

export interface MandateStackDepthCap {
  readonly maxDepth: number;
  /** Current nesting depth (0 = empty stack). */
  depth(): number;
  /**
   * Enter one nested mandate level. Fails closed: a push at the cap throws
   * {@link MandateStackDepthExceededError} and leaves the stack unchanged.
   */
  push(): void;
  /** Leave one nested mandate level, restoring capacity for a later push. */
  pop(): void;
}

export function createMandateStackDepthCap(options: MandateStackDepthCapOptions = {}): MandateStackDepthCap {
  const requested = options.maxDepth ?? 3;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`Mandate stack maxDepth must be a positive integer (got ${requested}).`);
  }
  const maxDepth = Math.min(requested, MANDATE_STACK_DEPTH_HARD_MAX);
  let depth = 0;

  return {
    maxDepth,
    depth() {
      return depth;
    },
    push() {
      if (depth >= maxDepth) {
        throw new MandateStackDepthExceededError(depth + 1, maxDepth);
      }
      depth += 1;
    },
    pop() {
      if (depth === 0) {
        throw new Error("Mandate stack underflow — pop with no matching push.");
      }
      depth -= 1;
    }
  };
}
