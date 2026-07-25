/**
 * Stream rule definition for injection points.
 * Pattern may be RegExp for precise matching or string for substring.
 */
export interface StreamRule {
  readonly pattern: RegExp | string;
  readonly inject?: unknown; // content or descriptor to inject on match
  readonly retry?: boolean; // whether retry should follow injection
}

/**
 * Pure decision returned when a rule matches for inject+retry.
 */
export interface InjectRetryDecision {
  readonly inject: true;
  readonly retry: true;
  readonly matched: StreamRule;
  readonly chunk: string;
}

/**
 * Stream rule inject retry evaluator (pure, no side effects).
 *
 * Given a text chunk and a list of rules, returns the first matching
 * inject+retry decision or null. This is the decision surface for
 * stream-rule injection points that require a retry after injection.
 *
 * Invariants (ADR-aligned):
 *  - Pure function: same input → same output, no mutation, no I/O.
 *  - First-match wins (order of rules matters; stable for tests).
 *  - Match supports RegExp.test or string includes (case-sensitive).
 *  - On match: returns decision with inject+retry flags + matched rule.
 *  - No match or empty input → null (clean pass-through, no retry).
 *
 * Keeps decision lightweight; actual side-effecting inject/retry lives
 * at caller (registered via extension seam, never edits core).
 */
export function evaluate(
  chunk: string,
  rules: readonly StreamRule[] = []
): InjectRetryDecision | null {
  if (!chunk || rules.length === 0) {
    return null;
  }

  for (const rule of rules) {
    const pattern = rule.pattern;
    const isMatch =
      pattern instanceof RegExp
        ? pattern.test(chunk)
        : typeof pattern === "string"
          ? chunk.includes(pattern)
          : false;

    if (isMatch) {
      return {
        inject: true,
        retry: true,
        matched: rule,
        chunk,
      };
    }
  }

  return null;
}
