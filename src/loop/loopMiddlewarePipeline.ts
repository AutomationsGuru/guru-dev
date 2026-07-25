/**
 * Loop middleware pipeline (IDEA-F492-MW-01).
 *
 * Pure ordered composition around a base runner.
 * Middlewares are functions of shape (next: T) => T and are applied
 * left-to-right in the order listed: the first middleware in the list
 * is the first to execute when the composed runner is invoked.
 */

export type Middleware<T> = (next: T) => T;

/**
 * apply(base, ...mws) — compose middlewares over base.
 * Empty list returns base unchanged.
 * Non-empty list applies left-to-right (first mw wraps closest to base).
 */
export function apply<T>(base: T, ...middlewares: Middleware<T>[]): T {
  return middlewares.reduce((acc, mw) => mw(acc), base);
}
