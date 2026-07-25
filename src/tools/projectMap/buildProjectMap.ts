import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Project map builder (IDEA-F8-PROJECT-MAP-01): a bounded, gitignore-aware
 * walk that renders the repo tree plus a light symbol sketch for TS/JS files.
 *
 * Bounded by construction like the composer file picker (src/tui/filePicker.ts):
 * the walk caps depth, file count, and visited entries so huge repos stay
 * instant, never follows symlinks, and never surfaces .env* files. Gitignore
 * matching is implemented natively (BUILD, not ATTACH): zod stays the only
 * runtime dependency and the matcher is scoped to the gitignore grammar this
 * tool needs — basename/anchored globs, `**`, directory-only rules, and `!`
 * negation, with per-directory .gitignore stacking and deeper-level override.
 */

/** Heavyweight dirs that are skipped even when no .gitignore names them. */
const ALWAYS_SKIP_DIRS: ReadonlySet<string> = new Set([".git", "node_modules"]);

/** .env* files are the concrete secret risk — they never surface in ANY map. */
const SECRET_FILES = /^\.env(?:\..*)?$/u;

/** Symbol sketch is attempted only for these extensions (TS/JS first). */
const SKETCHABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs"
]);

/** One parsed .gitignore line. */
interface IgnoreRule {
  readonly negated: boolean;
  /** True for rules ending in `/` — they match directories only. */
  readonly dirOnly: boolean;
  /** True when the original pattern contains `/` — matched against the path relative to the rule's base dir. */
  readonly anchored: boolean;
  readonly regex: RegExp;
  /** Repo-relative POSIX directory the rule's .gitignore lives in ("" for root). */
  readonly base: string;
  /** Deeper .gitignore files (and later lines) win over shallower ones. */
  readonly order: number;
}

export interface ProjectMapFile {
  /** Repo-relative POSIX path. */
  path: string;
  bytes: number;
  /**
   * Light symbol sketch for TS/JS files: exported functions, classes,
   * interfaces, type aliases, enums, and exported const names. Absent for
   * non-sketchable files or files skipped by the symbol budget.
   */
  symbols?: string[];
}

export interface ProjectMapResult {
  /** Absolute root that was walked. */
  root: string;
  /** True when any cap (depth, files, entries, symbols) stopped the walk. */
  truncated: boolean;
  totalFiles: number;
  totalDirs: number;
  files: ProjectMapFile[];
  /** Pre-rendered indented tree text for model consumption. */
  text: string;
}

export interface BuildProjectMapOptions {
  /** Max directory depth descended below root (root contents = depth 1). Default 8. */
  readonly maxDepth?: number;
  /** Max files collected. Default 500. */
  readonly maxFiles?: number;
  /** Max entries visited before the walk stops. Default maxFiles * 25. */
  readonly maxEntries?: number;
  /** Max files annotated with a symbol sketch. Default 100. */
  readonly maxSymbolFiles?: number;
  /** Max symbols recorded per file. Default 12. */
  readonly maxSymbolsPerFile?: number;
  /** Max source bytes read per file for the sketch. Default 64 KiB. */
  readonly maxSymbolFileBytes?: number;
  /** When false, skip symbol extraction entirely (tree only). Default true. */
  readonly includeSymbols?: boolean;
  /** Max characters of rendered text. Default 24_000; the tail is cut with a truncation note. */
  readonly maxTextChars?: number;
}

/**
 * Walk `root` with gitignore rules honored and return the structured map plus
 * rendered text. Synchronous by design — the walk is bounded and observation
 * tools in this codebase (repo.context) are synchronous too.
 */
export function buildProjectMap(root: string, options: BuildProjectMapOptions = {}): ProjectMapResult {
  const maxDepth = options.maxDepth ?? 8;
  const maxFiles = options.maxFiles ?? 500;
  const maxEntries = options.maxEntries ?? maxFiles * 25;
  const maxSymbolFiles = options.maxSymbolFiles ?? 100;
  const maxSymbolsPerFile = options.maxSymbolsPerFile ?? 12;
  const maxSymbolFileBytes = options.maxSymbolFileBytes ?? 64 * 1024;
  const includeSymbols = options.includeSymbols ?? true;
  const maxTextChars = options.maxTextChars ?? 24_000;

  let visited = 0;
  let truncated = false;
  let symbolFiles = 0;
  let totalDirs = 0;
  const files: ProjectMapFile[] = [];

  /** Per-directory rule stacks, keyed by repo-relative dir ("" = root). */
  const ruleCache = new Map<string, readonly IgnoreRule[]>();
  let ruleOrder = 0;

  const rulesForDir = (relDir: string, absDir: string): readonly IgnoreRule[] => {
    const cached = ruleCache.get(relDir);
    if (cached) {
      return cached;
    }
    const parentRel = relDir === "" ? "" : parentPath(relDir);
    const parentRules = parentRel === relDir ? [] : rulesForDir(parentRel, join(absDir, ".."));
    const own: IgnoreRule[] = [];
    const gitignorePath = join(absDir, ".gitignore");
    if (existsSync(gitignorePath)) {
      let text: string;
      try {
        text = readFileSync(gitignorePath, "utf8");
      } catch {
        text = "";
      }
      for (const rule of parseGitignore(text, relDir, () => ruleOrder++)) {
        own.push(rule);
      }
    }
    const combined = [...parentRules, ...own];
    ruleCache.set(relDir, combined);
    return combined;
  };

  const isIgnored = (relPath: string, isDir: boolean): boolean => {
    const relDir = parentPath(relPath);
    const rules = rulesForDir(relDir, relDir === "" ? root : join(root, relDir));
    let ignored = false;
    let ignoredOrder = -1;
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) {
        continue;
      }
      if (!matchesRule(rule, relPath)) {
        continue;
      }
      // Later / deeper rules override earlier ones (git: last match wins).
      if (rule.order >= ignoredOrder) {
        ignored = !rule.negated;
        ignoredOrder = rule.order;
      }
    }
    return ignored;
  };

  // Breadth-first walk: [absolute dir, repo-relative dir, depth].
  const queue: Array<[string, string, number]> = [[root, "", 0]];
  while (queue.length > 0 && !truncated) {
    const [absDir, relDir, depth] = queue.shift() as [string, string, number];
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      continue; // unreadable dir: skip, never crash the observation
    }
    entries.sort((a, b) => a.localeCompare(b));
    for (const entry of entries) {
      visited += 1;
      if (files.length >= maxFiles || visited > maxEntries) {
        truncated = true;
        break;
      }
      if (ALWAYS_SKIP_DIRS.has(entry) || SECRET_FILES.test(entry)) {
        continue;
      }
      const abs = join(absDir, entry);
      const rel = relDir === "" ? entry : `${relDir}/${entry}`;
      let stats: ReturnType<typeof lstatSync>;
      try {
        // lstat: NEVER follow symlinks — a symlinked dir cycle would loop the
        // walk forever (the file cap bounds files, not queued dirs).
        stats = lstatSync(abs);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) {
        continue;
      }
      const isDir = stats.isDirectory();
      if (isIgnored(rel, isDir)) {
        continue;
      }
      if (isDir) {
        totalDirs += 1;
        if (depth + 1 >= maxDepth) {
          // Depth cap: the subtree is omitted from the map and truncation is
          // flagged so the model knows this is a prefix view, not the repo.
          truncated = true;
          continue;
        }
        queue.push([abs, rel, depth + 1]);
        continue;
      }
      const file: ProjectMapFile = {
        path: rel,
        bytes: stats.size
      };
      if (
        includeSymbols &&
        symbolFiles < maxSymbolFiles &&
        SKETCHABLE_EXTENSIONS.has(extensionOf(entry)) &&
        stats.size <= maxSymbolFileBytes
      ) {
        const symbols = sketchSymbols(abs, maxSymbolsPerFile, maxSymbolFileBytes);
        if (symbols.length > 0) {
          file.symbols = symbols;
        }
        symbolFiles += 1;
      }
      files.push(file);
    }
  }

  const result: ProjectMapResult = {
    root,
    truncated,
    totalFiles: files.length,
    totalDirs,
    files,
    text: ""
  };
  return { ...result, text: renderProjectMap(result, maxTextChars) };
}

/** Render the map as an indented tree with symbol sketches inline. */
export function renderProjectMap(result: ProjectMapResult, maxTextChars = 24_000): string {
  interface TreeDir {
    readonly dirs: Map<string, TreeDir>;
    readonly files: ProjectMapFile[];
  }
  const newDir = (): TreeDir => ({ dirs: new Map(), files: [] });
  const tree = newDir();
  for (const file of result.files) {
    const parts = file.path.split("/");
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) {
        next = newDir();
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push(file);
  }

  const lines: string[] = [];
  const emitDir = (name: string, node: TreeDir, indent: string): void => {
    if (name !== "") {
      lines.push(`${indent}${name}/`);
      indent = `${indent}  `;
    }
    for (const [childName, child] of [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      emitDir(childName, child, indent);
    }
    for (const file of [...node.files].sort((a, b) => basename(a.path).localeCompare(basename(b.path)))) {
      const fileName = basename(file.path);
      if (file.symbols && file.symbols.length > 0) {
        lines.push(`${indent}${fileName} — ${file.symbols.join(", ")}`);
      } else {
        lines.push(`${indent}${fileName}`);
      }
    }
  };
  emitDir("", tree, "");

  let text = lines.join("\n");
  let textCut = false;
  const budget = Math.max(0, maxTextChars - 64);
  if (text.length > budget) {
    text = `${text.slice(0, budget)}\n… (map text truncated at ${maxTextChars} chars)`;
    textCut = true;
  }
  if (result.truncated || textCut) {
    text = `${text}\n… (walk truncated: depth/file/entry cap reached — map is a prefix of the repo)`;
  }
  return text;
}

/** Light regex symbol sketch for one TS/JS file. Never throws. */
function sketchSymbols(absPath: string, maxSymbols: number, maxBytes: number): string[] {
  let text: string;
  try {
    const raw = readFileSync(absPath);
    text = raw.subarray(0, maxBytes).toString("utf8");
  } catch {
    return [];
  }
  const symbols: string[] = [];
  const seen = new Set<string>();
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => string | undefined]> = [
    [/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, (m) => `ƒ ${m[1]}()`],
    [/^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm, (m) => `class ${m[1]}`],
    [/^export\s+interface\s+([A-Za-z_$][\w$]*)/gm, (m) => `interface ${m[1]}`],
    [/^export\s+type\s+([A-Za-z_$][\w$]*)/gm, (m) => `type ${m[1]}`],
    [/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (m) => `const ${m[1]}`],
    [/^export\s+enum\s+([A-Za-z_$][\w$]*)/gm, (m) => `enum ${m[1]}`],
    [/^export\s+(?:default\s+)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, (m) => `ƒ default ${m[1]}()`]
  ];
  for (const [regex, label] of patterns) {
    for (const match of text.matchAll(regex)) {
      if (symbols.length >= maxSymbols) {
        return symbols;
      }
      const symbol = label(match);
      if (symbol && !seen.has(symbol)) {
        seen.add(symbol);
        symbols.push(symbol);
      }
    }
  }
  return symbols;
}

/** Parse one .gitignore file into rules. Comment/blank lines are dropped. */
function parseGitignore(text: string, base: string, nextOrder: () => number): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split("\n")) {
    // git treats trailing spaces as significant only when escaped; trim the
    // common accidental case and skip blanks/comments.
    const line = rawLine.replace(/\r$/, "").replace(/(?<!\\) +$/, "");
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    let pattern = line;
    let negated = false;
    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    }
    let dirOnly = false;
    if (pattern.endsWith("/")) {
      dirOnly = true;
      pattern = pattern.slice(0, -1);
    }
    if (pattern.startsWith("/")) {
      pattern = pattern.slice(1);
    }
    if (pattern === "") {
      continue;
    }
    const anchored = pattern.includes("/");
    const regex = globToRegex(pattern, anchored);
    if (!regex) {
      continue;
    }
    rules.push({ negated, dirOnly, anchored, regex, base, order: nextOrder() });
  }
  return rules;
}

/** Test one rule against a repo-relative POSIX path. */
function matchesRule(rule: IgnoreRule, relPath: string): boolean {
  if (rule.anchored) {
    // Anchored: pattern matches relative to the rule's base dir.
    if (rule.base !== "") {
      if (!relPath.startsWith(`${rule.base}/`)) {
        return false;
      }
      const sub = relPath.slice(rule.base.length + 1);
      return rule.regex.test(sub);
    }
    return rule.regex.test(relPath);
  }
  // Basename rule: match against the final path segment.
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  return rule.regex.test(name);
}

/**
 * Translate a gitignore glob into a RegExp, or undefined when the pattern is
 * untranslatable. Supports `*` (within a segment), `?`, `**` (across
 * segments), and single-char classes — the grammar .gitignore actually uses.
 */
function globToRegex(pattern: string, anchored: boolean): RegExp | undefined {
  let out = "";
  let i = 0;
  const push = (char: string): void => {
    out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  };
  while (i < pattern.length) {
    const char = pattern[i] as string;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**` — crosses segment boundaries.
        const precededBySlash = out.endsWith("/");
        const followedBySlash = pattern[i + 2] === "/";
        if (precededBySlash && followedBySlash) {
          // `a/**\/b` → `a(?:/[^/]+)*/b` — zero or more middle segments.
          out = `${out.slice(0, -1)}(?:/[^/]+)*/`;
          i += 3;
          continue;
        }
        if (precededBySlash) {
          // `a/**` → `a(?:/[^/]*)*` — everything under a (never "ab").
          out = `${out.slice(0, -1)}(?:/[^/]*)*`;
          i += 2;
          continue;
        }
        out += followedBySlash ? "(?:[^/]+/)*" : "[^/]*(?:/[^/]*)*";
        i += followedBySlash ? 3 : 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        return undefined;
      }
      let charClass = pattern.slice(i, end + 1);
      // git negates classes with `!`; JS regex uses `^`.
      if (charClass.startsWith("[!")) {
        charClass = `[^${charClass.slice(2)}`;
      }
      out += charClass;
      i = end + 1;
      continue;
    }
    if (char === "\\" && i + 1 < pattern.length) {
      push(pattern[i + 1] as string);
      i += 2;
      continue;
    }
    push(char);
    i += 1;
  }
  // A matched dir hides everything under it too (git semantics): allow the
  // pattern to match a path PREFIX so `build` also ignores `build/out/x.js`
  // when anchored, and dir contents are cut at walk time anyway.
  const source = anchored ? `^${out}(?:/.*)?$` : `^${out}$`;
  try {
    return new RegExp(source, "u");
  } catch {
    return undefined;
  }
}

function parentPath(relPath: string): string {
  const at = relPath.lastIndexOf("/");
  return at === -1 ? "" : relPath.slice(0, at);
}

function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  return at === -1 ? "" : name.slice(at).toLowerCase();
}
