import { homedir } from "node:os";
import { join } from "node:path";

import { createFileMemoryStore, type FileMemoryStore } from "./store.js";

/**
 * Memory scopes (Memory Scopes wave, ADR 2026-07-05-memory-scopes, THERE v2 §7).
 *
 * A scope is a `FileMemoryStore` rooted at a distinct directory, so learnings and
 * facts are addressable BY CONTEXT rather than piled in one flat store:
 *
 *   global → ~/.guruharness/memory                    (always active)
 *   space  → <repoRoot>/.guru/memory                  (travels with the repo)
 *   role   → ~/.guruharness/roles/<slug>/memory        (loaded at strap-up)
 *
 * `ScopedMemory` wraps the existing global store and lazily materializes the space
 * store (from the session repo) and the role store (set on suit-up, cleared on
 * park / `/role off`). Reads merge across the ACTIVE scopes; writes target one.
 */

export type MemoryScope = "global" | "space" | "role";

export const MEMORY_SCOPES: readonly MemoryScope[] = ["global", "space", "role"];

const GLOBAL_SUBDIR = join(".guruharness", "memory");
const SPACE_SUBDIR = join(".guru", "memory");
const ROLE_ROOT_SUBDIR = join(".guruharness", "roles");
const ROLE_LEAF = "memory";

export interface ScopeContext {
  /** Home dir override (tests). Defaults to os.homedir(). */
  readonly home?: string;
  /** Enables the space scope when set (the session's repo root). */
  readonly repoRoot?: string;
  /** Enables the role scope when set (the worn suit's slug). */
  readonly roleSlug?: string;
}

/**
 * The directory for a scope, or `null` when the scope isn't addressable in this
 * context (space without a repo, role without a worn suit). Pure — no I/O.
 */
export function resolveScopeDirectory(scope: MemoryScope, ctx: ScopeContext = {}): string | null {
  const home = ctx.home ?? homedir();
  switch (scope) {
    case "global":
      return join(home, GLOBAL_SUBDIR);
    case "space":
      return ctx.repoRoot && ctx.repoRoot.length > 0 ? join(ctx.repoRoot, SPACE_SUBDIR) : null;
    case "role":
      return ctx.roleSlug && ctx.roleSlug.length > 0 ? join(home, ROLE_ROOT_SUBDIR, ctx.roleSlug, ROLE_LEAF) : null;
    default:
      return null;
  }
}

export interface ScopedStore {
  readonly scope: MemoryScope;
  readonly store: FileMemoryStore;
}

export interface ScopedMemory {
  /** The always-on global store (the passed-in one — garage/gaps live here too). */
  readonly global: FileMemoryStore;
  /** The space store for the bound repo, or null when no repo is bound. */
  space(): FileMemoryStore | null;
  /** The role store for the worn suit, or null when nothing is worn. */
  role(): FileMemoryStore | null;
  /** The store for a scope, or null when that scope isn't addressable now. */
  storeFor(scope: MemoryScope): FileMemoryStore | null;
  /** The active scopes' stores, most-general first: global ▸ space? ▸ role?. */
  activeStores(): readonly ScopedStore[];
  /** Bind the session repo (enables the space scope). Idempotent per path. */
  setRepoRoot(repoRoot: string | null): void;
  /** Wear a suit (enables the role scope) or clear it (null). Idempotent per slug. */
  setRole(roleSlug: string | null): void;
}

export interface ScopedMemoryOptions {
  readonly now?: () => Date;
  readonly sessionId?: string;
  /** Home override for space/role resolution (tests). */
  readonly home?: string;
  readonly repoRoot?: string;
  readonly roleSlug?: string;
  /** Store factory override (tests). Defaults to createFileMemoryStore. */
  readonly makeStore?: (directory: string) => FileMemoryStore;
}

/**
 * Build the scoped-memory organ around an existing global store. The space and
 * role stores are created lazily on first access after their key (repoRoot / slug)
 * is bound, and memoized so repeated access is free.
 */
export function createScopedMemory(global: FileMemoryStore, options: ScopedMemoryOptions = {}): ScopedMemory {
  const make =
    options.makeStore ??
    ((directory: string): FileMemoryStore =>
      createFileMemoryStore({
        directory,
        ...(options.now ? { now: options.now } : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {})
      }));

  let repoRoot: string | null = options.repoRoot ?? null;
  let roleSlug: string | null = options.roleSlug ?? null;
  let spaceStore: FileMemoryStore | null = null;
  let spaceKey: string | null = null;
  let roleStore: FileMemoryStore | null = null;
  let roleKey: string | null = null;

  const ctx = (): ScopeContext => ({
    ...(options.home ? { home: options.home } : {}),
    ...(repoRoot ? { repoRoot } : {}),
    ...(roleSlug ? { roleSlug } : {})
  });

  const space = (): FileMemoryStore | null => {
    const dir = resolveScopeDirectory("space", ctx());
    if (!dir) {
      spaceStore = null;
      spaceKey = null;
      return null;
    }
    if (dir !== spaceKey) {
      spaceStore = make(dir);
      spaceKey = dir;
    }
    return spaceStore;
  };

  const role = (): FileMemoryStore | null => {
    const dir = resolveScopeDirectory("role", ctx());
    if (!dir) {
      roleStore = null;
      roleKey = null;
      return null;
    }
    if (dir !== roleKey) {
      roleStore = make(dir);
      roleKey = dir;
    }
    return roleStore;
  };

  return {
    global,
    space,
    role,
    storeFor(scope) {
      switch (scope) {
        case "global":
          return global;
        case "space":
          return space();
        case "role":
          return role();
        default:
          return null;
      }
    },
    activeStores() {
      const active: ScopedStore[] = [{ scope: "global", store: global }];
      const spaceStoreNow = space();
      if (spaceStoreNow) {
        active.push({ scope: "space", store: spaceStoreNow });
      }
      const roleStoreNow = role();
      if (roleStoreNow) {
        active.push({ scope: "role", store: roleStoreNow });
      }
      return active;
    },
    setRepoRoot(next) {
      repoRoot = next && next.length > 0 ? next : null;
    },
    setRole(next) {
      roleSlug = next && next.length > 0 ? next : null;
    }
  };
}
