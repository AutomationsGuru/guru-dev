/**
 * Ordered middleware chain runner.
 *
 * Run semantics (the rule that matters here):
 *   - Middleware in {@link runMiddlewareChain} are called LEFT-TO-RIGHT by index.
 *   - A middleware returns either a `continue` result (run advances to the next
 *     middleware) or a `halt` result (run SHORT-CIRCUITS immediately — every
 *     middleware after the halting one is NOT called).
 *   - Every result actually produced (continue or halt) is recorded in order.
 */

/**
 * Minimal, generic context wrapper. The caller owns the inner {@link value};
 * middleware may read and mutate it. Keeping it behind a stable field lets a
 * chain share mutable state without depending on a specific domain shape.
 */
export interface MiddlewareContext<TCtx = unknown> {
  value: TCtx;
}

/**
 * Discriminated result of one middleware call. `continue` advances the chain;
 * `halt` short-circuits it (remaining middleware are skipped).
 */
export type MiddlewareResult<TOut> =
  | { readonly type: "continue"; readonly value?: TOut }
  | { readonly type: "halt"; readonly value?: TOut };

/**
 * A single middleware step: receives the context, returns a {@link MiddlewareResult}.
 */
export type Middleware<TCtx, TOut> = (ctx: MiddlewareContext<TCtx>) => MiddlewareResult<TOut>;

/**
 * Outcome of running a chain. Records every result produced (in call order),
 * whether the run halted, the index at which it halted (-1 when it did not),
 * and the final value (the last result's value, whether continue or halt).
 */
export interface MiddlewareChainOutcome<TOut> {
  /** Every result produced, in the order the middleware ran. */
  readonly results: ReadonlyArray<MiddlewareResult<TOut>>;
  /** True iff some middleware returned a halt result. */
  readonly halted: boolean;
  /** Index of the middleware that halted the run, or -1 if no halt occurred. */
  readonly haltIndex: number;
  /** The final value: the halt value on halt, otherwise the last continue value. */
  readonly finalValue?: TOut;
}

/** Build a `continue` result (chain advances to the next middleware). */
export function continueMiddleware<TOut>(value?: TOut): MiddlewareResult<TOut> {
  return value === undefined ? { type: "continue" } : { type: "continue", value };
}

/** Build a `halt` result (chain short-circuits; remaining middleware are skipped). */
export function haltMiddleware<TOut>(value?: TOut): MiddlewareResult<TOut> {
  return value === undefined ? { type: "halt" } : { type: "halt", value };
}

/**
 * Run an ordered middleware chain left-to-right over `ctx`, short-circuiting
 * on the first `halt` result. Returns the recorded results, whether the run
 * halted, the halt index (or -1), and the final value produced.
 */
export function runMiddlewareChain<TCtx, TOut>(
  chain: ReadonlyArray<Middleware<TCtx, TOut>>,
  ctx: MiddlewareContext<TCtx>
): MiddlewareChainOutcome<TOut> {
  const results: MiddlewareResult<TOut>[] = [];

  for (let index = 0; index < chain.length; index += 1) {
    const middleware = chain[index];
    if (!middleware) {
      continue;
    }
    const result = middleware(ctx);
    results.push(result);
    if (result.type === "halt") {
      return { results, halted: true, haltIndex: index, ...(result.value !== undefined ? { finalValue: result.value } : {}) };
    }
  }

  const last = results.length > 0 ? results[results.length - 1] : undefined;
  return {
    results,
    halted: false,
    haltIndex: -1,
    ...(last && last.value !== undefined ? { finalValue: last.value } : {})
  };
}
