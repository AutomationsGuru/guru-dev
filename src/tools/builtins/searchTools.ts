import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type { ToolDefinition } from "../registry.js";

/**
 * Typed grep / glob / ls (ADR 2026-07-05-every-session-dividends, gap research
 * Gap 4): structured results cost ~60% fewer tokens than raw bash output, and
 * the read-only floor stops depending on the shell allowlist for exploration.
 * Hand-rolled and bounded by construction — no ripgrep/fast-glob dependencies,
 * symlinks never followed, repo containment enforced on every path input.
 */

const SKIP_DIRS: ReadonlySet<string> = new Set([".git", "node_modules", "dist", "coverage", ".trash", ".smart-env"]);
const MAX_WALK_ENTRIES = 20_000;
const MAX_FILE_BYTES = 1_000_000;

interface WalkResult {
  readonly files: readonly string[];
  readonly truncated: boolean;
}

/** Bounded, symlink-safe walk returning repo-relative POSIX paths. */
function walkFiles(root: string, startRel: string): WalkResult {
  const files: string[] = [];
  const queue: string[] = [resolve(root, startRel)];
  let visited = 0;
  let truncated = false;
  while (queue.length > 0) {
    if (visited >= MAX_WALK_ENTRIES) {
      truncated = true;
      break;
    }
    const dir = queue.shift() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited >= MAX_WALK_ENTRIES) {
        truncated = true;
        break;
      }
      if (SKIP_DIRS.has(entry)) {
        continue;
      }
      const full = join(dir, entry);
      let stats: ReturnType<typeof lstatSync>;
      try {
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

/** Repo containment: the resolved target must stay inside repoRoot. */
function containedRel(repoRoot: string, target: string): string | null {
  const rel = relative(resolve(repoRoot), resolve(repoRoot, target));
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return null;
  }
  return rel;
}

/** `*` / `**` / `?` glob → anchored RegExp (everything else literal). */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.split("\\").join("/");
  let out = "^";
  for (let at = 0; at < normalized.length; at += 1) {
    const char = normalized[at] as string;
    if (char === "*") {
      if (normalized[at + 1] === "*") {
        out += normalized[at + 2] === "/" ? "(?:.*/)?" : ".*";
        at += normalized[at + 2] === "/" ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return new RegExp(`${out}$`, "u");
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

export const GrepToolInputSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    /** Regular expression (JavaScript syntax), matched per line. */
    pattern: z.string().min(1),
    /** Subdirectory or file to search; defaults to the whole repo. */
    path: z.string().trim().min(1).default("."),
    /** Glob filter on file paths (e.g. "**\/*.ts"). */
    include: z.string().trim().min(1).optional(),
    caseInsensitive: z.boolean().default(false),
    maxMatches: z.number().int().positive().max(500).default(100)
  })
  .strict();

export const GrepToolOutputSchema = z
  .object({
    matches: z.array(z.object({ file: z.string(), line: z.number().int().positive(), content: z.string() }).strict()),
    truncated: z.boolean(),
    blockers: z.array(z.string()),
    summary: z.string()
  })
  .strict();

export function createGrepTool(): ToolDefinition<typeof GrepToolInputSchema, typeof GrepToolOutputSchema> {
  return {
    id: "grep",
    title: "Search file contents",
    description: "Regex search across repo files. Returns typed {file, line, content} matches — cheaper and cleaner than raw grep output.",
    inputSchema: GrepToolInputSchema,
    outputSchema: GrepToolOutputSchema,
    execute(input) {
      const rel = containedRel(input.repoRoot, input.path);
      if (rel === null) {
        return { matches: [], truncated: false, blockers: ["Search path escapes the repository root."], summary: "Grep blocked by containment policy." };
      }
      let matcher: RegExp;
      try {
        matcher = new RegExp(input.pattern, input.caseInsensitive ? "iu" : "u");
      } catch (error) {
        return { matches: [], truncated: false, blockers: [`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`], summary: "Grep blocked by invalid regex." };
      }
      const include = input.include !== undefined ? globToRegExp(input.include) : null;
      const root = resolve(input.repoRoot);
      const target = resolve(root, rel);
      const isFile = ((): boolean => {
        try {
          return statSync(target).isFile();
        } catch {
          return false;
        }
      })();
      const walk = isFile ? { files: [rel.split(sep).join("/")], truncated: false } : walkFiles(root, rel);
      const matches: Array<{ file: string; line: number; content: string }> = [];
      let truncated = walk.truncated;
      for (const file of walk.files) {
        if (include && !include.test(file)) {
          continue;
        }
        let contents: string;
        try {
          const buffer = readFileSync(join(root, file));
          if (buffer.length > MAX_FILE_BYTES || buffer.subarray(0, 4096).includes(0)) {
            continue; // oversized or binary — never grep-worthy
          }
          contents = buffer.toString("utf8");
        } catch {
          continue;
        }
        const lines = contents.split(/\r?\n/u);
        for (let index = 0; index < lines.length; index += 1) {
          if (matcher.test(lines[index] as string)) {
            matches.push({ file, line: index + 1, content: (lines[index] as string).slice(0, 400) });
            if (matches.length >= input.maxMatches) {
              truncated = true;
              break;
            }
          }
        }
        if (matches.length >= input.maxMatches) {
          break;
        }
      }
      return {
        matches,
        truncated,
        blockers: [],
        summary: `${matches.length} match(es)${truncated ? " (truncated)" : ""}.`
      };
    }
  };
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

export const GlobToolInputSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    /** Glob pattern over repo-relative paths (*, **, ?). */
    pattern: z.string().trim().min(1),
    path: z.string().trim().min(1).default("."),
    maxResults: z.number().int().positive().max(2_000).default(500)
  })
  .strict();

export const GlobToolOutputSchema = z
  .object({
    paths: z.array(z.string()),
    truncated: z.boolean(),
    blockers: z.array(z.string()),
    summary: z.string()
  })
  .strict();

export function createGlobTool(): ToolDefinition<typeof GlobToolInputSchema, typeof GlobToolOutputSchema> {
  return {
    id: "glob",
    title: "Find files by pattern",
    description: "Glob over repo files (*, **, ?). Returns a typed path list sorted by recency of modification.",
    inputSchema: GlobToolInputSchema,
    outputSchema: GlobToolOutputSchema,
    execute(input) {
      const rel = containedRel(input.repoRoot, input.path);
      if (rel === null) {
        return { paths: [], truncated: false, blockers: ["Search path escapes the repository root."], summary: "Glob blocked by containment policy." };
      }
      const matcher = globToRegExp(input.pattern);
      const root = resolve(input.repoRoot);
      const walk = walkFiles(root, rel);
      const scored: Array<{ path: string; mtime: number }> = [];
      let truncated = walk.truncated;
      for (const file of walk.files) {
        if (!matcher.test(file)) {
          continue;
        }
        let mtime = 0;
        try {
          mtime = statSync(join(root, file)).mtimeMs;
        } catch {
          /* keep 0 */
        }
        scored.push({ path: file, mtime });
      }
      scored.sort((left, right) => right.mtime - left.mtime);
      if (scored.length > input.maxResults) {
        truncated = true;
      }
      return {
        paths: scored.slice(0, input.maxResults).map((entry) => entry.path),
        truncated,
        blockers: [],
        summary: `${Math.min(scored.length, input.maxResults)} path(s)${truncated ? " (truncated)" : ""}.`
      };
    }
  };
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

export const LsToolInputSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    path: z.string().trim().min(1).default("."),
    includeHidden: z.boolean().default(false)
  })
  .strict();

export const LsToolOutputSchema = z
  .object({
    entries: z.array(
      z
        .object({
          name: z.string(),
          type: z.enum(["file", "dir", "symlink", "other"]),
          size: z.number().int().nonnegative(),
          modified: z.string()
        })
        .strict()
    ),
    blockers: z.array(z.string()),
    summary: z.string()
  })
  .strict();

export function createLsTool(): ToolDefinition<typeof LsToolInputSchema, typeof LsToolOutputSchema> {
  return {
    id: "ls",
    title: "List directory",
    description: "Typed directory listing: {name, type, size, modified} per entry, dirs first.",
    inputSchema: LsToolInputSchema,
    outputSchema: LsToolOutputSchema,
    execute(input) {
      const rel = containedRel(input.repoRoot, input.path);
      if (rel === null) {
        return { entries: [], blockers: ["Path escapes the repository root."], summary: "Ls blocked by containment policy." };
      }
      const target = resolve(input.repoRoot, rel);
      let names: string[];
      try {
        names = readdirSync(target);
      } catch (error) {
        return { entries: [], blockers: [`Cannot read directory: ${error instanceof Error ? error.message : String(error)}`], summary: "Ls failed." };
      }
      const entries = names
        .filter((name) => input.includeHidden || !name.startsWith("."))
        .map((name) => {
          try {
            const stats = lstatSync(join(target, name));
            const type = stats.isSymbolicLink() ? ("symlink" as const) : stats.isDirectory() ? ("dir" as const) : stats.isFile() ? ("file" as const) : ("other" as const);
            return { name, type, size: Number(stats.size), modified: stats.mtime.toISOString() };
          } catch {
            return { name, type: "other" as const, size: 0, modified: new Date(0).toISOString() };
          }
        })
        .sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name) : left.type === "dir" ? -1 : right.type === "dir" ? 1 : 0));
      return { entries, blockers: [], summary: `${entries.length} entrie(s).` };
    }
  };
}
