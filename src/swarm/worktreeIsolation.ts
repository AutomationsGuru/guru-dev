import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Worktree-default ship isolation (IDEA-A3-WORKTREE-SHIP-01).
 *
 * Ship-shaped workers default to git worktree isolation: a ship that writes
 * runs in its own bounded, project-local worktree under `<root>/.guru/worktrees/`
 * instead of silently mutating the operator's primary checkout. Isolation is
 * opt-out (`isolation: 'none'`), never opt-in — the safe default is structural.
 *
 * Hard-limit posture:
 * - §3.1 No destruction without preservation: worktrees are created DETACHED
 *   (no branch is ever created or deleted); dispose only ever runs
 *   `git worktree remove` on a path this module itself created. Operator
 *   branches and the primary checkout are never touched.
 * - §3.4 No out-of-scope crossing: worktrees live under the project-local
 *   `.guru/worktrees/` boundary — never in /tmp, never in the user's global
 *   state, never outside the project root.
 *
 * Tangle detect: each ship claims a set of writable globs at acquire time. A
 * second ship claiming an overlapping glob fails closed with a structured
 * WorktreeIsolationError rather than racing the first writer.
 *
 * Integration (manager.ts / schema.ts / spawnAgentTool.ts wiring) is owned by
 * lane S1-B; this module is the isolated, independently testable unit.
 */

export type IsolationMode = "worktree" | "none";

/** Bounded project-local segments that own every ship worktree. */
const WORKTREE_ROOT_SEGMENTS = [".guru", "worktrees"] as const;

/** Structured failure for isolation/tangle violations — never a silent race. */
export class WorktreeIsolationError extends Error {
  readonly code = "worktree_isolation";
  constructor(message: string) {
    super(message);
    this.name = "WorktreeIsolationError";
  }
}

/**
 * Resolve the project root to a git repo root, or null when `cwd` is not
 * inside a git work tree. Uses `git rev-parse --show-toplevel` so nested
 * directories and linked worktrees both resolve to their own root.
 */
export function detectGitRepo(cwd: string): string | null {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    // realpath collapses Windows 8.3 short paths (RUNNER~1) to the long form.
    return top.length > 0 ? realpathSync(resolve(top)) : null;
  } catch {
    return null;
  }
}

/**
 * Ship default: `worktree` when a git repo is detected, `none` otherwise.
 * An explicit request always wins over the default — the operator (or the
 * spawn caller) may opt out, but the default never silently mutates the
 * primary checkout inside a repo.
 */
export function resolveIsolation(cwd: string, requested?: IsolationMode): IsolationMode {
  if (requested !== undefined) {
    return requested;
  }
  return detectGitRepo(cwd) !== null ? "worktree" : "none";
}

/**
 * Conservative glob-overlap test. Fails CLOSED: any pair that might name the
 * same path counts as overlap. Two globs overlap when they are identical, or
 * when one is a path-prefix of the other at a `/` boundary or `**` wildcard
 * boundary. This is deliberately simple and predictable — a ship that needs
 * disjoint writes should claim disjoint prefixes.
 */
export function globsOverlap(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const norm = (g: string): string => g.replace(/\*\*.*$/u, "").replace(/\/+$/u, "");
  const pa = norm(a);
  const pb = norm(b);
  if (pa === pb) {
    return true;
  }
  if (pa.length === 0 || pb.length === 0) {
    return true; // a bare `**` claims everything
  }
  return pa.startsWith(pb + "/") || pb.startsWith(pa + "/");
}

export interface WritableClaims {
  /** Claim globs for a ship; throws WorktreeIsolationError on cross-ship overlap. */
  claim(shipId: string, globs: readonly string[]): void;
  /** Release every glob a ship holds (idempotent). */
  release(shipId: string): void;
  /** Test/support: the ship currently holding a glob, if any. */
  holderOf(glob: string): string | undefined;
}

/** In-memory claim table for tangle detect. One table per isolation scope. */
export function claimWritableGlobs(): WritableClaims {
  const claims = new Map<string, Set<string>>(); // shipId -> globs

  return {
    claim(shipId, globs) {
      const mine = claims.get(shipId) ?? new Set<string>();
      for (const glob of globs) {
        for (const [otherId, otherGlobs] of claims) {
          if (otherId === shipId) {
            continue;
          }
          for (const other of otherGlobs) {
            if (globsOverlap(glob, other)) {
              throw new WorktreeIsolationError(
                `Tangle detect: ship '${shipId}' cannot claim '${glob}' — ship '${otherId}' already holds overlapping glob '${other}'.`
              );
            }
          }
        }
      }
      for (const glob of globs) {
        mine.add(glob);
      }
      claims.set(shipId, mine);
    },
    release(shipId) {
      claims.delete(shipId);
    },
    holderOf(glob) {
      for (const [shipId, globs] of claims) {
        if (globs.has(glob)) {
          return shipId;
        }
      }
      return undefined;
    }
  };
}

export interface WorktreeHandle {
  /** Absolute path the ship writes into (its worktree, or the checkout when `none`). */
  readonly path: string;
  /** True when the ship runs in its own git worktree. */
  readonly isolated: boolean;
  readonly shipId: string;
  /** Release this ship's claims and remove its worktree (never the checkout). */
  dispose(): void;
}

export interface WorktreeIsolationOptions {
  /** Project root (the operator checkout). Must be a git repo for `worktree`. */
  readonly projectRoot: string;
  /** Explicit override; defaults via resolveIsolation (worktree in a repo). */
  readonly isolation?: IsolationMode;
}

export interface WorktreeIsolation {
  readonly mode: IsolationMode;
  /** Acquire a writing surface for a ship; claims globs with tangle detect. */
  acquire(shipId: string, writableGlobs: readonly string[]): WorktreeHandle;
  /** Dispose every outstanding handle (test/cleanup support). */
  disposeAll(): void;
}

/**
 * Create the isolation scope for one project. The scope owns the bounded
 * `<root>/.guru/worktrees/` directory and the tangle-detect claim table.
 */
export function createWorktreeIsolation(options: WorktreeIsolationOptions): WorktreeIsolation {
  const projectRoot = resolve(options.projectRoot);
  const mode = resolveIsolation(projectRoot, options.isolation);
  const claims = claimWritableGlobs();
  const handles = new Set<WorktreeHandle>();

  const worktreeRoot = join(projectRoot, ...WORKTREE_ROOT_SEGMENTS);

  const acquire = (shipId: string, writableGlobs: readonly string[]): WorktreeHandle => {
    // Tangle detect runs BEFORE any filesystem mutation — a conflicting ship
    // fails closed without creating anything.
    claims.claim(shipId, writableGlobs);

    if (mode === "none") {
      const handle: WorktreeHandle = {
        path: projectRoot,
        isolated: false,
        shipId,
        dispose() {
          claims.release(shipId);
          handles.delete(handle);
        }
      };
      handles.add(handle);
      return handle;
    }

    // mode === "worktree": create a DETACHED worktree at HEAD. No branch is
    // created, so dispose can never delete an operator branch (§3.1).
    const id = randomUUID().slice(0, 8);
    const wtPath = join(worktreeRoot, id);
    try {
      mkdirSync(worktreeRoot, { recursive: true });
      execFileSync("git", ["worktree", "add", "--detach", wtPath, "HEAD"], {
        cwd: projectRoot,
        stdio: ["ignore", "ignore", "pipe"]
      });
    } catch (error) {
      claims.release(shipId);
      throw new WorktreeIsolationError(
        `Failed to create worktree for ship '${shipId}': ${error instanceof Error ? error.message : String(error)}`
      );
    }

    let disposed = false;
    const handle: WorktreeHandle = {
      path: wtPath,
      isolated: true,
      shipId,
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        claims.release(shipId);
        handles.delete(handle);
        // Remove ONLY the worktree this module created — never the checkout,
        // never a branch. git worktree remove refuses a dirty worktree, so a
        // ship's uncommitted work is preserved rather than silently destroyed;
        // the path is left for the operator to inspect in that case.
        try {
          execFileSync("git", ["worktree", "remove", wtPath], {
            cwd: projectRoot,
            stdio: ["ignore", "ignore", "pipe"]
          });
        } catch {
          // Dirty worktree: preserve it (§3.1). The claims are still released —
          // the path is inert without a holder.
        }
      }
    };
    handles.add(handle);
    return handle;
  };

  return {
    mode,
    acquire,
    disposeAll() {
      for (const handle of [...handles]) {
        handle.dispose();
      }
      // Best-effort: remove the bounded root if empty (never recursive force).
      if (existsSync(worktreeRoot)) {
        try {
          rmSync(worktreeRoot, { recursive: false });
        } catch {
          // Non-empty (a preserved dirty worktree) — leave it.
        }
      }
    }
  };
}
