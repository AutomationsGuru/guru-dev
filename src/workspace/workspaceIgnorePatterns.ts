/**
 * Workspace ignore patterns -- gitignore-style glob matching for project files.
 *
 * Loads patterns from a gitignore-like file (line-oriented globs), then answers
 * isIgnored(path) for any relative path. Supports the common gitignore syntax
 * subset: comments, negation, wildcards (* ** ?), anchored root patterns,
 * directory-only trailing slash, and basename-only matching.
 *
 * This is NOT a full gitignore reimplementation -- it is a glob-set matcher
 * suitable for workspace-level file exclusion.
 */

/** A compiled set of ignore patterns. */
export interface WorkspaceIgnorePatterns {
  /**
   * Returns true when path matches an active ignore pattern and is NOT
   * un-ignored by a later negation.
   *
   * Path must be a relative path. Backslashes are normalized to forward
   * slashes. Trailing slashes on the input path are preserved so callers
   * can distinguish directory paths.
   */
  readonly isIgnored: (path: string) => boolean;
}

/** A single compiled pattern. */
interface CompiledPattern {
  readonly regex: RegExp;
  /** True for ! negation patterns that re-include a previously excluded path. */
  readonly negated: boolean;
  /** The original pattern text (for diagnostics, not exposed yet). */
  readonly source: string;
}

/**
 * Parse gitignore-style lines into a compiled WorkspaceIgnorePatterns.
 *
 * Empty lines and lines starting with # are skipped. Lines starting with !
 * are negation patterns that un-ignore paths excluded by earlier patterns
 * (last-match-wins order).
 */
export function fromLines(lines: readonly string[]): WorkspaceIgnorePatterns {
  const patterns = compilePatterns(lines);

  return {
    isIgnored(path: string): boolean {
      // Normalize Windows backslashes to forward slashes.
      const normalized = path.replaceAll("\\", "/");

      // Start from the end -- gitignore uses last-match-wins semantics.
      for (const p of [...patterns].reverse()) {
        if (p.regex.test(normalized)) {
          return !p.negated;
        }
      }

      return false;
    }
  };
}

// -- compilation -----------------------------------------------------------

function compilePatterns(lines: readonly string[]): readonly CompiledPattern[] {
  const out: CompiledPattern[] = [];

  for (const raw of lines) {
    const trimmed = raw.trim();

    // Skip blanks and full-line comments.
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    let negated = false;
    let pattern = trimmed;

    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1).trimStart();
      // A bare "!" line is invalid -- skip it.
      if (!pattern) {
        continue;
      }
    }

    out.push({ regex: globToRegex(pattern), negated, source: trimmed });
  }

  return out;
}

// -- glob to regex conversion ----------------------------------------------

/**
 * Convert a single gitignore-style glob to a RegExp.
 *
 * Handles: * ** ? leading-slash anchor trailing-slash dir-marker, and the
 * special case where patterns with no interior slash match as path components
 * anywhere.
 */
function globToRegex(pattern: string): RegExp {
  let dirOnly = false;
  let p = pattern;

  // Trailing slash = match directories only.
  if (p.endsWith("/")) {
    dirOnly = true;
    p = p.slice(0, -1);
    if (!p) {
      return NEVER_MATCH;
    }
  }

  // Leading slash anchors to the root.
  let anchored = false;
  if (p.startsWith("/")) {
    anchored = true;
    p = p.slice(1);
  }

  // Strip trailing /** -- the suffix already provides (?:/.*)?$ behaviour.
  if (p.endsWith("/**")) {
    p = p.slice(0, -3);
  }

  // Convert the glob body to a regex fragment.
  const body = globBodyToRegex(p);

  // All non-anchored patterns match as a path component anywhere.
  const prefix = anchored ? "^" : "(?:^|.*/)";

  // Non-dirOnly: match the exact name OR anything beneath it.
  // DirOnly: a / MUST follow the body (it is a directory, not a file).
  const suffix = dirOnly ? "/.*$" : "(?:/.*)?$";

  return new RegExp(`${prefix}${body}${suffix}`, "u");
}

/**
 * Escape regex-special characters EXCEPT * and ? (which are glob
 * metacharacters handled separately by globBodyToRegex).
 */
function escapeRegexChars(s: string): string {
  return s.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&");
}

// Sentinels for ** transformations.
// **/  (zero-or-more dirs prefix)
const DS_PREFIX = "\x00P\x00";
// /**/ (zero-or-more dirs between slashes)
const DS_BETWEEN = "\x00B\x00";

/**
 * Convert the body of a glob pattern (anchors, dir-only marker, and trailing
 * slash-double-star already stripped) to a regex fragment.
 */
function globBodyToRegex(body: string): string {
  // Escape regex-special chars first, leaving * and ? untouched.
  let result = escapeRegexChars(body);

  // **/ at the very start of the body (no leading slash to consume).
  result = result.replace(/^\*\*\//u, DS_PREFIX);
  // /**/ between two path segments -- consume the leading /.
  result = result.replaceAll("/**/", `/${DS_BETWEEN}`);

  // Remaining * and ? are single-segment metacharacters.
  result = result.replaceAll("*", "[^/]*");
  result = result.replaceAll("?", "[^/]");

  // Restore sentinels.
  result = result.replaceAll(DS_PREFIX, "(?:.*/)?");
  result = result.replaceAll(DS_BETWEEN, "(?:.*/)?");

  return result;
}

/** A regex that never matches -- sentinel for degenerate patterns. */
const NEVER_MATCH = /(?!)u/;
