import { resolve } from "node:path";

/**
 * Trust-folder allowlist — the mechanical backstop for the rule that path
 * operations OUTSIDE an operator-declared trusted root require elevated
 * approval. The behavioral rule lives in Guru's system prompt; this is the
 * fail-closed check for the moment the model doesn't honor it.
 *
 * Sibling to {@link pathCovers} in `evaluate.ts`: both answer "is this target
 * inside this granted subtree?", and they MUST agree. The trust set is the
 * generalization of a single SPACE grant path to a set of trusted roots, so a
 * path is trusted iff it is contained by at least one root under the same
 * containment rule the mandate engine already uses (exact match, or a
 * separator-anchored prefix — never a bare `startsWith`, which would let
 * `/repo/ap` wrongly cover `/repo/app`).
 *
 * Pure: no filesystem access. Callers resolve real on-disk paths before
 * asking; this module only reasons about the path strings it is given.
 */

/** An operator-declared trusted root: an absolute directory subtree. */
export interface TrustedRoot {
  /** Absolute directory path that anchors a trusted subtree. */
  readonly path: string;
}

/**
 * The set of trusted roots a path operation is checked against. Roots are
 * treated as directory subtrees: a path is trusted iff it equals a root or
 * lives (at any depth) under one. Empty roots → nothing is trusted.
 */
export type TrustFolderAllowlist = readonly TrustedRoot[];

/** The verdict a caller surfaces when a path escapes every trusted root. */
export interface TrustVerdict {
  /** True when the path is contained by at least one trusted root. */
  readonly trusted: boolean;
  /** Operator-facing reason for the escalation when `trusted` is false. */
  readonly reason: string;
}

/**
 * Containment check shared by the trust allowlist and the SPACE-grant engine.
 * A target is "inside" a root when, after resolving both: they are equal, OR
 * the target begins with the root followed by a path separator (`/` or `\`).
 * The separator anchor blocks the classic `/repo/ap` → `/repo/app` false cover
 * a bare `startsWith` would produce.
 */
export function isInsideRoot(target: string, root: string): boolean {
  if (target.length === 0 || root.length === 0) {
    return false;
  }
  const t = resolve(target);
  const g = resolve(root);
  return t === g || t.startsWith(`${g}/`) || t.startsWith(`${g}\\`);
}

/**
 * Returns true iff `path` is contained by at least one trusted root. Empty
 * roots, or an empty/whitespace path, are NOT trusted — a path we cannot place
 * inside a declared root fails closed (Constitution §3: hard edges resolve
 * before YOLO, and "unknown location" is never silently trusted).
 */
export function isTrusted(path: string, roots: TrustFolderAllowlist): boolean {
  if (path.trim().length === 0) {
    return false;
  }
  return roots.some((root) => isInsideRoot(path, root.path));
}

/**
 * Resolve a path operation against the trust allowlist. Trusted → `{ trusted:
 * true }`. Untrusted → `{ trusted: false, reason }` carrying the elevated-
 * approval rationale the mandate layer surfaces (path operations outside
 * trusted roots escalate, in every mode including YOLO).
 */
export function assessTrust(path: string, roots: TrustFolderAllowlist): TrustVerdict {
  if (isTrusted(path, roots)) {
    return { trusted: true, reason: "path is inside a trusted root" };
  }
  return {
    trusted: false,
    reason: `path "${path}" is outside every trusted root — path operations outside trusted roots require elevated approval`
  };
}
