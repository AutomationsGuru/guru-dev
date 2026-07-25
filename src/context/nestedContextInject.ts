import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { isRiskyPath } from "../safety/policyGuard.js";
import { createNestedContextCache, type NestedContextCache } from "./nestedContextCache.js";

/**
 * Nested context delta injection (IDEA-F5-NESTED-CTX-01 / R-GO-CTX-NEST).
 *
 * When tools touch nested paths, the harness should hold the AGENTS/context
 * chain for that part of the tree WITHOUT re-pasting the full root-to-leaf
 * chain every turn. This module discovers context files along the directory
 * walk from a session root down to a tool's target directory, loads each file
 * once per session (cached by path+mtime via nestedContextCache), and returns
 * only the NEWLY loaded chunks so the caller can inject the delta into
 * subsequent model turns.
 *
 * Composition notes:
 * - The existing repo-wide loader (`src/repo/context.ts`) and the
 *   `repo.context.resolve` tool stay untouched; this module is the
 *   session-delta layer that keeps repeated injections cheap.
 * - Safety: files whose paths match the configured risky-path patterns
 *   (`.env`, `secrets`, `credentials`, …) are never opened — presence-over-
 *   value, enforced structurally like the tool policy guard.
 * - Read-only: no filesystem writes, no new dependencies.
 */

/** Context filenames discovered per directory, in order. Default is DOX only. */
export const DEFAULT_CONTEXT_FILENAMES: readonly string[] = ["AGENTS.md"];

/** Fallback risky-path guard, mirroring the shipped config defaults. */
export const DEFAULT_NESTED_CONTEXT_RISKY_PATTERNS: readonly string[] = [
  ".git",
  ".env",
  ".ssh",
  ".aws",
  ".npmrc",
  ".yarnrc",
  ".netrc",
  ".config/gcloud",
  "secrets",
  "credentials",
  "id_rsa",
  "id_ed25519",
  "service-account"
];

export interface NestedContextInjectOptions {
  /**
   * Top of the directory walk (session/project root). The walk runs
   * root→target; targets outside the root walk to the filesystem root instead
   * of throwing, so ad-hoc paths outside the project still get context.
   */
  readonly rootPath: string;
  /** Context filenames to look for per directory (default: ["AGENTS.md"]). */
  readonly contextFilenames?: readonly string[];
  /**
   * Risky-path patterns: any candidate file matching one is skipped unread.
   * Defaults to the shipped runtime-hardening patterns; pass the session's
   * configured list when available.
   */
  readonly riskyPathPatterns?: readonly string[];
  /** Skip files larger than this many bytes (default 256 KiB) — bounds turn tokens. */
  readonly maxFileBytes?: number;
  /** Pre-built session cache; a fresh one is created when omitted. */
  readonly cache?: NestedContextCache;
}

export interface NestedContextChunk {
  /** Canonical file path (cache key). */
  readonly path: string;
  /** Path relative to the walk root, forward-slash normalized. */
  readonly relativePath: string;
  /** File contents as loaded. */
  readonly contents: string;
}

export interface NestedContextDelta {
  /** Chunks loaded for the first time (or reloaded after mtime change) — inject these. */
  readonly chunks: readonly NestedContextChunk[];
  /** Context files already fresh in the session cache — do NOT re-inject. */
  readonly alreadyCached: readonly string[];
  /** Candidate paths skipped, with the structural reason (risky-path, too-large, unreadable). */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

export interface NestedContextInjector {
  /** Session cache backing this injector (shared across tool accesses). */
  readonly cache: NestedContextCache;
  /** Discover the candidate context files for `targetPath`, root→leaf, without loading. */
  discover(targetPath: string): readonly string[];
  /**
   * Load any not-yet-cached context files on the root→target walk and return
   * the delta. Repeated calls with the same unchanged files return empty
   * chunks — the full chain is never re-pasted.
   */
  collect(targetPath: string): NestedContextDelta;
}

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;

export function createNestedContextInjector(options: NestedContextInjectOptions): NestedContextInjector {
  const rootPath = resolve(options.rootPath);
  const contextFilenames = options.contextFilenames ?? DEFAULT_CONTEXT_FILENAMES;
  const riskyPathPatterns = options.riskyPathPatterns ?? DEFAULT_NESTED_CONTEXT_RISKY_PATTERNS;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const cache = options.cache ?? createNestedContextCache();

  function resolveTargetDirectory(targetPath: string): string {
    const resolved = isAbsolute(targetPath) ? resolve(targetPath) : resolve(rootPath, targetPath);
    const stats = statSync(resolved, { throwIfNoEntry: false });
    return stats?.isFile() ? dirname(resolved) : resolved;
  }

  /**
   * Directories from the walk root down to the target directory, inclusive.
   * When the target is outside the root, the walk starts at the target's own
   * filesystem root so containment never throws (mirrors the DOX rule that any
   * ancestor chain is still useful context).
   */
  function walkDirectories(targetDirectory: string): readonly string[] {
    let walkRoot = rootPath;
    let relativeDirectory = relative(walkRoot, targetDirectory);
    if (relativeDirectory.startsWith("..") || isAbsolute(relativeDirectory)) {
      walkRoot = parseFilesystemRoot(targetDirectory);
      relativeDirectory = relative(walkRoot, targetDirectory);
    }

    const segments = relativeDirectory ? relativeDirectory.split(/[\\/]+/u).filter(Boolean) : [];
    const directories = [walkRoot];
    let current = walkRoot;
    for (const segment of segments) {
      current = join(current, segment);
      directories.push(current);
    }
    return directories;
  }

  function discover(targetPath: string): readonly string[] {
    const targetDirectory = resolveTargetDirectory(targetPath);
    const candidates: string[] = [];
    for (const directory of walkDirectories(targetDirectory)) {
      for (const filename of contextFilenames) {
        const candidate = join(directory, filename);
        if (existsSync(candidate)) {
          candidates.push(candidate);
        }
      }
    }
    return candidates;
  }

  function loadChunk(candidate: string): NestedContextDelta {
    // Safety gate first, enforced structurally like the tool policy guard:
    // never open a risky-path file. This skips `.env`-shaped candidates and
    // any context file living under a risky-named directory (secrets/, .aws/,
    // credentials/, …) even when it sits on the walk.
    if (isRiskyPath(candidate, riskyPathPatterns)) {
      return { chunks: [], alreadyCached: [], skipped: [{ path: candidate, reason: "risky-path" }] };
    }

    const fresh = cache.getFresh(candidate);
    if (fresh?.contents !== undefined) {
      return { chunks: [], alreadyCached: [candidate], skipped: [] };
    }

    let stats;
    try {
      stats = statSync(candidate);
    } catch (error) {
      cache.record({ path: candidate, error: formatError(error) });
      return { chunks: [], alreadyCached: [], skipped: [{ path: candidate, reason: "unreadable" }] };
    }
    if (stats.size > maxFileBytes) {
      return { chunks: [], alreadyCached: [], skipped: [{ path: candidate, reason: `too-large (${stats.size} > ${maxFileBytes} bytes)` }] };
    }

    try {
      const contents = readFileSync(candidate, "utf8");
      const entry = cache.record({ path: candidate, contents });
      return {
        chunks: [
          {
            path: entry.path,
            relativePath: normalizeRelativePath(relative(rootPath, entry.path)),
            contents
          }
        ],
        alreadyCached: [],
        skipped: []
      };
    } catch (error) {
      cache.record({ path: candidate, error: formatError(error) });
      return { chunks: [], alreadyCached: [], skipped: [{ path: candidate, reason: "unreadable" }] };
    }
  }

  function collect(targetPath: string): NestedContextDelta {
    const chunks: NestedContextChunk[] = [];
    const alreadyCached: string[] = [];
    const skipped: { readonly path: string; readonly reason: string }[] = [];

    for (const candidate of discover(targetPath)) {
      const delta = loadChunk(candidate);
      chunks.push(...delta.chunks);
      alreadyCached.push(...delta.alreadyCached);
      skipped.push(...delta.skipped);
    }

    return { chunks, alreadyCached, skipped };
  }

  return { cache, discover, collect };
}

/** Filesystem root of a path in its own form ("C:\\" on Windows, "/" elsewhere). */
function parseFilesystemRoot(path: string): string {
  const resolved = resolve(path);
  let current = resolved;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split("\\").join("/");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
