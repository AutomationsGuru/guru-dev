import { resolve, sep } from "node:path";

/**
 * Session resume project filter.
 *
 * Pure, deterministic helper that narrows a saved-session resume list down to
 * the sessions that belong to a given project root, with an `--all` escape
 * hatch that returns the unfiltered global list. This is the project-filtered
 * resume view called out in the daily-driver resume story (R-NC-RESUME): when
 * the operator resumes from inside a project, they see only that project's
 * sessions by default; `--all` lifts the filter to surface every session the
 * harness knows about.
 *
 * Kept deliberately small and dependency-free (only `node:path`) so it can run
 * in any context — including a bare boot with no persistence backend attached.
 */

/**
 * A minimal reference to one saved session as needed for resume filtering.
 *
 * Only the fields that affect filtering are required. `projectRoot` is the
 * authoritative project root the session ran under (canonical source:
 * `session.repo.repoRoot`); it is optional because legacy or unscoped sessions
 * may not have one, and such sessions never match a specific project filter.
 */
export interface ResumeSessionRef {
  readonly sessionId: string;
  readonly projectRoot?: string;
}

/**
 * Filter options.
 *
 * - `projectRoot` — when set (and `all` is falsy), only sessions whose root
 *   matches are returned. Resolved lexically to an absolute, normalized path
 *   so trailing separators and relative inputs behave.
 * - `all` — when true, returns the entire list unchanged (the global view),
 *   ignoring `projectRoot`.
 */
export interface ResumeProjectFilterOptions {
  readonly projectRoot?: string;
  readonly all?: boolean;
}

/**
 * Normalize a path for matching: resolve to absolute and strip a trailing
 * separator (except for a bare root like `/`). Lexical only — symlinks are
 * not resolved, so callers comparing symlinked roots should canonicalize
 * upstream. Kept pure so the filter has no filesystem side effects.
 */
function normalizeRoot(path: string): string {
  const resolved = resolve(path);
  if (resolved.length > 1 && resolved.endsWith(sep)) {
    return resolved.slice(0, -1);
  }
  return resolved;
}

/**
 * Returns the subset of `sessions` that should appear in the resume list.
 *
 * Semantics:
 * - `all` true → every session (the global list), order preserved.
 * - `projectRoot` set, `all` falsy → only sessions whose normalized
 *   `projectRoot` equals the normalized filter root. Sessions with no
 *   `projectRoot` never match a specific filter.
 * - `projectRoot` unset, `all` falsy → empty list. With no project to match
 *   against, a project filter has no members; callers wanting the global list
 *   must pass `all: true`. This keeps the contract honest rather than guessing
 *   a "current" root the pure function does not have.
 *
 * Input is never mutated; a new filtered array is returned.
 */
export function filterSessions(
  sessions: readonly ResumeSessionRef[],
  options: ResumeProjectFilterOptions = {}
): readonly ResumeSessionRef[] {
  if (options.all) {
    return sessions.slice();
  }

  const filterRoot = options.projectRoot;
  if (filterRoot === undefined || filterRoot === "") {
    return [];
  }

  const normalizedFilter = normalizeRoot(filterRoot);

  return sessions.filter((session) => {
    if (!session.projectRoot) {
      return false;
    }
    return normalizeRoot(session.projectRoot) === normalizedFilter;
  });
}
