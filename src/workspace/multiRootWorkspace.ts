import { isAbsolute, normalize, relative, resolve } from "node:path";

/**
 * A multi-root workspace maps multiple absolute root directories into a single
 * containment check.  The primary root is always the first entry; additional
 * include directories follow in deduplicated insertion order.
 *
 * Design (per IDEA-F123):
 * - `createWorkspace(primary, includes[])` normalizes and deduplicates roots.
 * - `isInside(path)` returns true when the resolved path sits inside any root.
 */
export interface MultiRootWorkspace {
  /** Absolute, normalized roots — primary first, then includes in order. */
  readonly roots: readonly string[];
  /** True when `path` resolves inside any root. */
  isInside(path: string): boolean;
}

/**
 * Normalize a set of absolute paths, collapsing equivalent entries.
 * Case-insensitive dedup on Windows; case-sensitive elsewhere.
 */
function deduplicateRoots(primary: string, includes: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const norm = (p: string): string => {
    const n = normalize(p);
    return process.platform === "win32" ? n.toLowerCase() : n;
  };

  for (const raw of [primary, ...includes]) {
    const abs = resolve(raw);
    const key = norm(abs);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(abs);
    }
  }

  return out;
}

/**
 * Create a multi-root workspace.
 *
 * @param primary  The primary workspace root (must be absolute or resolvable).
 * @param includes Zero or more extra include directories.
 * @returns A frozen workspace with deduplicated, normalized roots.
 */
export function createWorkspace(
  primary: string,
  includes: readonly string[] = [],
): MultiRootWorkspace {
  if (typeof primary !== "string" || primary.length === 0) {
    throw new TypeError("primary root must be a non-empty string");
  }

  const roots = deduplicateRoots(primary, includes);

  // Validate: every entry must be absolute after resolution.
  for (const r of roots) {
    if (!isAbsolute(r)) {
      throw new TypeError(`root must be absolute after resolution, got: ${JSON.stringify(r)}`);
    }
  }

  const frozenRoots: readonly string[] = Object.freeze([...roots]);

  return {
    roots: frozenRoots,

    isInside(path: string): boolean {
      // Resolve the candidate path before checking containment.
      // Symlinks are NOT chased — the user path is resolved against CWD
      // and compared as a prefix string, which is the same conservative
      // behaviour as Node itself (realpath would dereference symlinks into
      // possibly-excluded territory).
      const resolved = resolve(path);

      for (const root of frozenRoots) {
        const rel = relative(root, resolved);
        // relative() returns "" for the exact root, and a non-".."-prefixed
        // path for anything beneath it.
        if (rel === "" || !rel.startsWith("..")) {
          return true;
        }
      }

      return false;
    },
  };
}