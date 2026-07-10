import { lstatSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * The @ file-reference picker + Tab path completion (P1 composer wave, ADR
 * 2026-07-05-composer-editor). Bounded by construction: the walk caps its
 * entry count so huge repos stay instant; heavyweight dirs are skipped.
 */

const SKIP_DIRS: ReadonlySet<string> = new Set([".git", "node_modules", "dist", "coverage", ".trash", ".smart-env"]);

/** .env* files are the concrete secret risk — they never surface in ANY picker path. */
const SECRET_FILES = /^\.env(?:\..*)?$/u;

export interface RepoFileScan {
  readonly files: readonly string[];
  /** True when the cap stopped the walk — the list is a prefix, not the repo. */
  readonly truncated: boolean;
}

/** Breadth-first bounded walk; returns repo-relative POSIX-style paths. */
export function scanRepoFiles(root: string, options: { readonly cap?: number } = {}): RepoFileScan {
  const cap = options.cap ?? 2_000;
  // Bound the WALK, not just the file list — a directory-heavy tree (few
  // files, thousands of dirs) must stay instant too (review follow-up).
  const entryCap = cap * 25;
  let visited = 0;
  const files: string[] = [];
  const queue: string[] = [root];
  let truncated = false;

  while (queue.length > 0 && !truncated) {
    const dir = queue.shift() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // unreadable dir: skip, never crash the picker
    }
    for (const entry of entries) {
      visited += 1;
      if (files.length >= cap || visited > entryCap) {
        truncated = true;
        break;
      }
      // The ADR skip list governs dirs (so .github/.claude STAY walkable);
      // .env* files are the concrete secret risk and never enter the picker.
      if (SKIP_DIRS.has(entry) || SECRET_FILES.test(entry)) {
        continue;
      }
      const full = join(dir, entry);
      let stats: ReturnType<typeof lstatSync>;
      try {
        // lstat: NEVER follow symlinks — a symlinked dir cycle would loop the
        // walk forever (the file cap bounds files, not queued dirs).
        stats = lstatSync(full);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) {
        continue;
      }
      if (stats.isDirectory()) {
        queue.push(full);
        continue;
      }
      files.push(relative(root, full).split(sep).join("/"));
    }
  }

  return { files, truncated };
}

/**
 * Subsequence fuzzy score: every query char must appear in order (case-
 * insensitive). Higher is better; contiguous runs and basename hits rank up;
 * -1 = no match.
 */
export function fuzzyScore(query: string, path: string): number {
  if (query.length === 0) {
    return 0;
  }
  const haystack = path.toLowerCase();
  const needle = query.toLowerCase();
  let score = 0;
  let at = -1;
  let previous = -2;
  for (const char of needle) {
    at = haystack.indexOf(char, at + 1);
    if (at === -1) {
      return -1;
    }
    score += at === previous + 1 ? 3 : 1; // contiguity bonus
    previous = at;
  }
  const basenameAt = haystack.lastIndexOf("/") + 1;
  if (haystack.slice(basenameAt).includes(needle)) {
    score += 5; // whole query inside the basename
  }
  return score - Math.floor(path.length / 16); // gentle short-path preference
}

export interface PickerMatch {
  readonly path: string;
  readonly score: number;
}

export function filterFiles(files: readonly string[], query: string, limit = 8): readonly PickerMatch[] {
  const matches: PickerMatch[] = [];
  for (const path of files) {
    const score = fuzzyScore(query, path);
    if (score >= 0) {
      matches.push({ path, score });
    }
  }
  matches.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  return matches.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Tab path completion
// ---------------------------------------------------------------------------

export interface PathCompletion {
  /** The completed token (longest unambiguous extension of the input). */
  readonly completed: string;
  /** All candidates when ambiguous (shown by the caller); empty = none. */
  readonly candidates: readonly string[];
}

/**
 * Complete a filesystem path token relative to `cwd`: "src/comp" →
 * "src/compaction/". Directories complete with a trailing slash so a second
 * Tab descends. Pure lookup — no side effects beyond readdir.
 */
export function completePathToken(token: string, cwd: string): PathCompletion {
  // Windows operators type backslashes too — normalize for the split, complete
  // with forward slashes (every guru surface speaks POSIX-style paths).
  const normalized = token.split("\\").join("/");
  const slash = normalized.lastIndexOf("/");
  const dirPart = slash >= 0 ? normalized.slice(0, slash + 1) : "";
  const stem = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  let entries: string[];
  try {
    entries = readdirSync(join(cwd, dirPart || "."));
  } catch {
    return { completed: token, candidates: [] };
  }
  // Case-insensitive stem match on Windows (its filesystems are); skip-dirs and
  // dotfiles stay out unless the operator explicitly typed the leading dot —
  // and .env* NEVER completes, matching the repo-scan guardrail.
  const caseFold = process.platform === "win32" ? (text: string): string => text.toLowerCase() : (text: string): string => text;
  const foldedStem = caseFold(stem);
  const matches = entries.filter(
    (entry) =>
      caseFold(entry).startsWith(foldedStem) && !SKIP_DIRS.has(entry) && !SECRET_FILES.test(entry) && (stem.startsWith(".") || !entry.startsWith("."))
  );
  if (matches.length === 0) {
    return { completed: token, candidates: [] };
  }
  const suffixFor = (entry: string): string => {
    try {
      return statSync(join(cwd, dirPart, entry)).isDirectory() ? "/" : "";
    } catch {
      return "";
    }
  };
  if (matches.length === 1) {
    const only = matches[0] as string;
    return { completed: `${dirPart}${only}${suffixFor(only)}`, candidates: [] };
  }
  // Longest common prefix across candidates.
  let prefix = matches[0] as string;
  for (const entry of matches.slice(1)) {
    let length = 0;
    while (length < prefix.length && length < entry.length && prefix[length] === entry[length]) {
      length += 1;
    }
    prefix = prefix.slice(0, length);
  }
  return { completed: `${dirPart}${prefix}`, candidates: matches.map((entry) => `${entry}${suffixFor(entry)}`) };
}
