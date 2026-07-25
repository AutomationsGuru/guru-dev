export type Runner<Args extends unknown[] = unknown[], Result = unknown> = (...args: Args) => Result;

export type Middleware<Args extends unknown[] = unknown[], Result = unknown> = (
  next: Runner<Args, Result>
) => Runner<Args, Result>;

/** Wraps a runner so middleware executes in declaration order. */
export function apply<Args extends unknown[], Result>(
  base: Runner<Args, Result>,
  ...middlewares: readonly Middleware<Args, Result>[]
): Runner<Args, Result> {
  return middlewares.reduceRight<Runner<Args, Result>>(
    (next, middleware) => middleware(next),
    base
  );
}
