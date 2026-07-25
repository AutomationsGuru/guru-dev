/**
 * Expression route table.
 *
 * Pure ordered matching: evaluate rules in declaration order and return the
 * target of the first rule whose expression matches the input. No routing is
 * executed here; callers decide what to do with the selected target.
 */

export interface ExpressionRouteRule<I, T> {
  /** Optional rule name for debugging or evidence. */
  readonly name?: string;
  /** Expression that decides whether this rule applies to an input. */
  readonly match: (input: I) => boolean;
  /** Value to return when this rule is the first match. */
  readonly target: T;
}

export interface ExpressionRouteHit<T> {
  readonly matched: true;
  readonly ruleName: string | undefined;
  readonly target: T;
}

export interface ExpressionRouteMiss {
  readonly matched: false;
  readonly ruleName: undefined;
  readonly target: undefined;
}

export type ExpressionRouteResult<T> = ExpressionRouteHit<T> | ExpressionRouteMiss;

/**
 * Match an input against an ordered list of expression rules.
 *
 * Iterates rules in order and returns the first match. If no rule matches, the
 * result indicates a miss. Short-circuits after the first match.
 */
export function route<I, T>(input: I, rules: readonly ExpressionRouteRule<I, T>[]): ExpressionRouteResult<T> {
  for (const rule of rules) {
    if (rule.match(input)) {
      return { matched: true, ruleName: rule.name, target: rule.target };
    }
  }

  return { matched: false, ruleName: undefined, target: undefined };
}

// --- Lightweight convenience expressions -------------------------------------

/** Match any input. Useful as a final catch-all rule. */
export function any<I>(): (input: I) => boolean {
  return () => true;
}

/** Match when the named field equals the given value. */
export function exact<I extends Record<string, unknown>>(field: keyof I, value: unknown): (input: I) => boolean {
  return (input) => input[field] === value;
}

/** Match when the named string field contains the given substring. */
export function contains<I extends Record<string, string | undefined>>(field: keyof I, substring: string): (input: I) => boolean {
  return (input) => {
    const value = input[field];
    return typeof value === "string" && value.includes(substring);
  };
}

/** Match when every provided predicate matches. */
export function all<I>(...predicates: ReadonlyArray<(input: I) => boolean>): (input: I) => boolean {
  return (input) => predicates.every((predicate) => predicate(input));
}

/** Match when at least one provided predicate matches. */
export function anyOf<I>(...predicates: ReadonlyArray<(input: I) => boolean>): (input: I) => boolean {
  return (input) => predicates.some((predicate) => predicate(input));
}
