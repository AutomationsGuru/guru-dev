import { readFileSync, existsSync } from "node:fs";
import { basename, posix, sep } from "node:path";

/**
 * Extra ignore file support — layers `.guruignore` (and `.gitignore`) patterns
 * on top of a built-in deny-by-default secret-name list.
 *
 * No flag or ignore-file pattern may lift the secret-name deny limit.
 * This module intentionally uses only Node built-ins to keep the harness core
 * dependency-light.
 */

/** File names / patterns that are always denied regardless of ignore files. */
const DEFAULT_SECRET_NAMES = new Set([
  ".env",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials",
  "secrets",
  "keystore",
]);

const ALWAYS_SECRET_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".crt",
  ".cer",
  ".der",
]);

function looksLikeSecret(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  const ext = posix.extname(lower);
  if (ALWAYS_SECRET_EXTENSIONS.has(ext)) return true;
  if (DEFAULT_SECRET_NAMES.has(fileName)) return true;
  // Loose heuristic for common secret tokens in file names.
  if (/\b(secret|token|password|passwd|apikey|api_key|private|credential)/u.test(lower)) {
    return true;
  }
  return false;
}

export interface ExtraIgnoreOptions {
  /**
   * Base directory to resolve leading-slash patterns and to locate ignore files.
   * Defaults to the current working directory.
   */
  baseDir?: string;
  /**
   * Ordered list of extra ignore file names to layer. Defaults to
   * [".gitignore", ".guruignore"]. Earlier files have lower priority than later
   * ones; later negations can unignore paths ignored by earlier patterns.
   */
  ignoreFiles?: string[];
}

export interface ExtraIgnoreSet {
  /** Return true when `path` should be ignored. */
  isIgnored(path: string): boolean;
}

interface IgnoreRule {
  readonly pattern: string;
  readonly negated: boolean;
  readonly anchored: boolean;
  readonly directoryOnly: boolean;
  readonly parts: string[];
}

/**
 * Split a pattern into slash-separated parts, preserving `**` as a single
 * wildcard token. Collapses multiple adjacent `*` into one.
 */
function tokenizePattern(pattern: string): string[] {
  const parts: string[] = [];
  for (const part of pattern.split("/")) {
    if (part === "") continue;
    if (part === "**") {
      parts.push("**");
    } else {
      // Collapse runs of * so "a***b" matches the same as "a*b".
      parts.push(part.replace(/\*+/gu, "*"));
    }
  }
  return parts;
}

function parseRule(line: string): IgnoreRule | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;

  let negated = false;
  let pattern = trimmed;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("\\!")) {
    negated = false;
    pattern = pattern.slice(1);
  }

  let directoryOnly = false;
  if (pattern.endsWith("/")) {
    directoryOnly = true;
    pattern = pattern.slice(0, -1);
  }

  const anchored = pattern.startsWith("/");
  if (anchored) {
    pattern = pattern.slice(1);
  }

  return {
    pattern,
    negated,
    anchored,
    directoryOnly,
    parts: tokenizePattern(pattern),
  };
}

function readIgnoreFile(baseDir: string, fileName: string): string[] {
  const path = `${baseDir}/${fileName}`;
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8").split(/\r?\n/u);
  } catch {
    return [];
  }
}

function normalizeInputPath(input: string): string[] {
  // Use POSIX separators internally; strip leading slash to simplify matching.
  const normalized = input.replace(/\\/gu, "/").replace(/^\//u, "");
  return normalized.split("/").filter((part) => part !== "");
}

function matchWildcards(pattern: string, candidate: string): boolean {
  // Simple glob with single '*' matching any sequence of non-slash characters.
  const segments = pattern.split("*");
  let pos = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "") continue;
    const idx = candidate.indexOf(segment, pos);
    if (idx === -1) return false;
    if (i === 0 && idx !== 0) return false; // first segment must match from start
    pos = idx + segment.length;
  }
  // Trailing empty segment (pattern ending in *) already consumed everything.
  if (segments.at(-1) !== "" && pos !== candidate.length) return false;
  return true;
}

function matchRuleParts(rule: IgnoreRule, pathParts: string[]): boolean {
  if (rule.parts.length === 0) return false;

  // Fast path for bare file name / directory pattern: match any part.
  if (rule.parts.length === 1 && !rule.anchored) {
    const part = rule.parts[0] ?? "";
    if (part === "**") return true;
    return pathParts.some((p) => matchWildcards(part, p));
  }

  // Leading anchored pattern: must match from the start of the path.
  if (rule.anchored) {
    if (rule.parts.length > pathParts.length) return false;
    for (let i = 0; i < rule.parts.length; i++) {
      const part = rule.parts[i] ?? "";
      const candidate = pathParts[i] ?? "";
      if (part === "**") {
        // '**' in anchored mode matches the remainder of the path greedily.
        return true;
      }
      if (!matchWildcards(part, candidate)) return false;
    }
    return true;
  }

  // Unanchored multi-part pattern: can match at any depth.
  const maxStart = pathParts.length - rule.parts.length;
  if (maxStart < 0) return false;

  for (let start = 0; start <= maxStart; start++) {
    let matched = true;
    for (let i = 0; i < rule.parts.length; i++) {
      const part = rule.parts[i] ?? "";
      const candidate = pathParts[start + i] ?? "";
      if (part === "**") {
        // '**' matches zero or more path segments.
        return true;
      }
      if (!matchWildcards(part, candidate)) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }

  return false;
}

function matchRule(rule: IgnoreRule, pathParts: string[], fileName: string): boolean {
  if (rule.parts.length === 1 && !rule.anchored) {
    const part = rule.parts[0] ?? "";
    if (matchWildcards(part, fileName)) return true;
    if (rule.directoryOnly && part === fileName) return true;
  }
  return matchRuleParts(rule, pathParts);
}

/**
 * Create an ignore set from the given options. Patterns are layered in the order
 * provided by `ignoreFiles`: later files win, and within a file later rules win.
 * The secret-name deny list is enforced before any pattern and cannot be lifted.
 */
export function createExtraIgnore(options: ExtraIgnoreOptions = {}): ExtraIgnoreSet {
  const baseDir = options.baseDir ?? process.cwd();
  const ignoreFiles = options.ignoreFiles ?? [".gitignore", ".guruignore"];

  const rules: IgnoreRule[] = [];
  for (const fileName of ignoreFiles) {
    for (const line of readIgnoreFile(baseDir, fileName)) {
      const rule = parseRule(line);
      if (rule) rules.push(rule);
    }
  }

  return {
    isIgnored(path: string): boolean {
      const fileName = basename(path);
      if (looksLikeSecret(fileName)) return true;

      const pathParts = normalizeInputPath(path);
      if (pathParts.length === 0) return false;

      let ignored = false;
      for (const rule of rules) {
        if (matchRule(rule, pathParts, fileName)) {
          ignored = !rule.negated;
        }
      }
      return ignored;
    },
  };
}
