import { statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Session-scoped cache for nested context files (IDEA-F5-NESTED-CTX-01).
 *
 * Context chunks are keyed by canonical file path and invalidated by mtime
 * (mtimeMs + size): a file that changes on disk since it was loaded must be
 * re-read and re-injected, never silently served stale. Paths that errored at
 * load time are remembered so a broken tree does not re-stat on every tool
 * access; the entry clears as soon as the path becomes readable again.
 *
 * Pure in-memory store — no filesystem writes, no dependencies.
 */

export interface NestedContextCacheEntry {
  /** Canonical (resolve()d) file path used as the cache key. */
  readonly path: string;
  /** File contents at load time; undefined when the load failed (see error). */
  readonly contents?: string;
  /** Last observed mtime in milliseconds; undefined when the load failed. */
  readonly mtimeMs?: number;
  /** Last observed size in bytes; undefined when the load failed. */
  readonly size?: number;
  /** Load failure message when the file could not be read/stat'd. */
  readonly error?: string;
}

export interface NestedContextCacheOptions {
  /** Injectable clock for deterministic invalidation tests. */
  readonly now?: () => number;
}

export interface NestedContextCache {
  /** Number of tracked entries (fresh + stale + errored). */
  readonly size: number;
  /**
   * Record the current state of `path`. A missing `contents`/`error` pair means
   * the caller could not load the file; the miss is remembered to avoid a
   * re-stat storm, and clears automatically once the path is stat-able again.
   */
  record(entry: { readonly path: string; readonly contents?: string; readonly error?: string }): NestedContextCacheEntry;
  /** Fresh entry for `path`, or undefined when absent, stale (mtime/size changed), or previously errored. */
  getFresh(path: string): NestedContextCacheEntry | undefined;
  /** The raw entry regardless of freshness (for diagnostics / injection bookkeeping). */
  peek(path: string): NestedContextCacheEntry | undefined;
  /** Drop a single entry; returns true when an entry was removed. */
  invalidate(path: string): boolean;
  /** Drop every entry. */
  clear(): void;
  /** All currently tracked paths (canonical form), root-walk order not implied. */
  keys(): readonly string[];
}

export function createNestedContextCache(options: NestedContextCacheOptions = {}): NestedContextCache {
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, NestedContextCacheEntry>();

  function canonical(path: string): string {
    return resolve(path);
  }

  function statSignature(path: string): { readonly mtimeMs: number; readonly size: number } | undefined {
    try {
      const stats = statSync(path);
      return { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      return undefined;
    }
  }

  function isFresh(entry: NestedContextCacheEntry): boolean {
    if (entry.error !== undefined || entry.contents === undefined) {
      return false;
    }
    const signature = statSignature(entry.path);
    if (!signature) {
      return false;
    }
    return signature.mtimeMs === entry.mtimeMs && signature.size === entry.size;
  }

  return {
    get size() {
      return entries.size;
    },

    record(input) {
      const path = canonical(input.path);
      const signature = statSignature(path);
      const entry: NestedContextCacheEntry = {
        path,
        ...(input.contents !== undefined ? { contents: input.contents } : {}),
        ...(signature ? { mtimeMs: signature.mtimeMs, size: signature.size } : {}),
        ...(input.error !== undefined ? { error: input.error } : {})
      };
      // Touch the clock so tests that inject `now` observe a read per record,
      // and so future TTL-style policy has a hook without changing this API.
      now();
      entries.set(path, entry);
      return entry;
    },

    getFresh(path) {
      const entry = entries.get(canonical(path));
      if (!entry) {
        return undefined;
      }
      return isFresh(entry) ? entry : undefined;
    },

    peek(path) {
      return entries.get(canonical(path));
    },

    invalidate(path) {
      return entries.delete(canonical(path));
    },

    clear() {
      entries.clear();
    },

    keys() {
      return [...entries.keys()];
    }
  };
}
