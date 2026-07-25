import { resolve } from "node:path";

/**
 * Directory conversation affinity (IDEA-F146-DIR-CONV-01 / R-KR-DIRCONV).
 *
 * Maps a working directory (cwd / project root) to the conversation ids most
 * recently used there, so the harness can default back into the conversation an
 * operator was last having in that directory (composes the F114 conversation
 * switcher). In-memory only: the map lives for the process; durable persistence
 * is a later wave and belongs beside the conversation store, not here.
 *
 * Paths are normalized before they key the map so `/repo/alpha`, `/repo//alpha//`,
 * `/repo/./alpha/`, and (on this host) case variants all resolve to the same
 * affinity entry.
 */

export interface DirectoryConversationAffinity {
  /** Record that `convId` was used in `dir`. Blank inputs are ignored. */
  record(dir: string, convId: string): void;
  /** Most recently recorded conversation id for `dir`, or null when unknown. */
  lastFor(dir: string): string | null;
}

export interface DirectoryConversationAffinityOptions {
  /** Base for resolving relative dirs. Defaults to process.cwd(). */
  readonly cwd?: string;
}

export function createDirectoryConversationAffinity(
  options: DirectoryConversationAffinityOptions = {}
): DirectoryConversationAffinity {
  const cwd = options.cwd ?? process.cwd();
  const byDir = new Map<string, string>();

  const normalizeDir = (dir: string): string | null => {
    const trimmed = dir.trim();
    if (trimmed.length === 0) {
      return null;
    }
    // resolve() resolves relative paths against cwd, collapses separators and
    // dot segments, and strips trailing slashes; toLowerCase() matches the
    // harness's case-insensitive directory treatment (Windows-first tool).
    return resolve(cwd, trimmed).toLowerCase();
  };

  return {
    record(dir, convId) {
      const key = normalizeDir(dir);
      const id = convId.trim();
      if (key === null || id.length === 0) {
        return;
      }
      byDir.set(key, id);
    },
    lastFor(dir) {
      const key = normalizeDir(dir);
      if (key === null) {
        return null;
      }
      return byDir.get(key) ?? null;
    }
  };
}

/** Convenience helper: the default conversation id for `dir`, or null. */
export function pickLastForDir(affinity: DirectoryConversationAffinity, dir: string): string | null {
  return affinity.lastFor(dir);
}
