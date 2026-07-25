/**
 * Pure gitignore-style path filter for workspace sync/download lists.
 *
 * Evaluates a list of root-relative paths against gitignore-style rules using
 * the same semantics as git: comments and blank lines are ignored, `!`
 * negates, trailing `/` matches directories only, a leading `/` anchors the
 * pattern to the root, patterns without a slash match any basename, and
 * `*` / `?` / `**` behave as standard globs. Because each prefix of a path is
 * walked from root to leaf, a path cannot be re-included once a parent
 * directory has been excluded — matching git's behavior exactly.
 */

export interface CompiledIgnoreRule {
  readonly raw: string;
  readonly isNegated: boolean;
  readonly isDirOnly: boolean;
  readonly hasSlash: boolean;
  readonly segments: readonly string[];
  readonly segmentRegexes: readonly RegExp[];
}

/**
 * Returns the subset of `paths` that are NOT ignored by `rules`.
 *
 * Paths are root-relative (leading/trailing slashes and `\` separators are
 * normalized). A trailing slash marks a directory path. Rules are applied in
 * order; later rules override earlier ones, and a negated rule only has an
 * effect when the path's parent directories were not excluded.
 */
export function filterPaths(paths: readonly string[], rules: readonly string[]): string[] {
  const compiledRules = compileIgnoreRules(rules);

  return paths.filter((path) => {
    const originalIsDir = path.endsWith("/") || path.endsWith("\\");
    const normalized = normalizePath(path);
    if (normalized.length === 0) {
      return false;
    }

    const segments = normalized.split("/");
    return !isIgnored(segments, originalIsDir, compiledRules);
  });
}

/** Parses gitignore-style rules into compiled matchers, preserving order. */
export function compileIgnoreRules(rules: readonly string[]): readonly CompiledIgnoreRule[] {
  const compiled: CompiledIgnoreRule[] = [];

  for (const raw of rules) {
    let rule = raw.trim();

    if (rule.length === 0 || rule.startsWith("#")) {
      continue;
    }

    const isNegated = rule.startsWith("!");
    if (isNegated) {
      rule = rule.slice(1).trim();
    }

    let isDirOnly = false;
    if (rule.endsWith("/")) {
      isDirOnly = true;
      rule = rule.slice(0, -1);
    }

    if (rule.length === 0) {
      continue;
    }

    const hasLeadingSlash = rule.startsWith("/");
    const cleanRule = hasLeadingSlash ? rule.slice(1) : rule;
    if (cleanRule.length === 0) {
      continue;
    }

    const hasSlash = hasLeadingSlash || cleanRule.includes("/");
    const segments = cleanRule.split("/");
    const segmentRegexes = segments.map(compileSegmentToRegex);

    compiled.push({ raw, isNegated, isDirOnly, hasSlash, segments, segmentRegexes });
  }

  return compiled;
}

/**
 * Walks each root-to-leaf prefix of the path. A path is ignored when any
 * prefix (parent directory or the path itself) ends up ignored after all
 * rules have been applied to that prefix. Once a parent directory is
 * excluded, deeper negations cannot re-include the path.
 */
function isIgnored(
  segments: readonly string[],
  originalIsDir: boolean,
  rules: readonly CompiledIgnoreRule[]
): boolean {
  for (let i = 0; i < segments.length; i++) {
    const isLast = i === segments.length - 1;
    const isDir = !isLast || originalIsDir;
    const prefixSegs = segments.slice(0, i + 1);

    let prefixIgnored = false;
    for (const rule of rules) {
      if (matchRule(prefixSegs, isDir, rule)) {
        prefixIgnored = !rule.isNegated;
      }
    }

    if (prefixIgnored) {
      return true;
    }
  }

  return false;
}

function matchRule(
  pathSegs: readonly string[],
  isDir: boolean,
  rule: CompiledIgnoreRule
): boolean {
  if (rule.isDirOnly && !isDir) {
    return false;
  }

  if (rule.hasSlash) {
    // Anchored to the root: match the full prefix path segment by segment.
    return matchSegments(pathSegs, rule.segments, rule.segmentRegexes);
  }

  // No slash: the pattern matches any single basename in the tree.
  const basename = pathSegs.at(-1);
  const basenameRegex = rule.segmentRegexes[0];
  if (basename === undefined || basenameRegex === undefined) {
    return false;
  }
  return basenameRegex.test(basename);
}

/**
 * Matches path segments against pattern segments, where `**` consumes zero
 * or more consecutive path segments (backtracking) and every other segment
 * must match its glob regex exactly.
 */
function matchSegments(
  pathSegs: readonly string[],
  patternSegs: readonly string[],
  regexes: readonly RegExp[]
): boolean {
  function match(pathIdx: number, patternIdx: number): boolean {
    const currentPatternSeg = patternSegs[patternIdx];
    if (currentPatternSeg === undefined) {
      return pathIdx === pathSegs.length;
    }

    if (currentPatternSeg === "**") {
      if (match(pathIdx, patternIdx + 1)) {
        return true;
      }
      return pathIdx < pathSegs.length && match(pathIdx + 1, patternIdx);
    }

    const currentPathSeg = pathSegs[pathIdx];
    const currentRegex = regexes[patternIdx];
    if (currentPathSeg === undefined || currentRegex === undefined) {
      return false;
    }

    return currentRegex.test(currentPathSeg) && match(pathIdx + 1, patternIdx + 1);
  }

  return match(0, 0);
}

/** Compiles one slash-free glob segment: `*` → any run, `?` → one char. */
function compileSegmentToRegex(pattern: string): RegExp {
  let regexStr = "";
  for (const char of pattern) {
    if (char === "*") {
      regexStr += ".*";
    } else if (char === "?") {
      regexStr += ".";
    } else if (/[.+^${}()|[\]\\]/.test(char)) {
      regexStr += "\\" + char;
    } else {
      regexStr += char;
    }
  }
  return new RegExp("^" + regexStr + "$");
}

function normalizePath(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }
  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}
