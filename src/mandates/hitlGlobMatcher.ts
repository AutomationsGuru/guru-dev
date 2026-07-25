/**
 * HITL glob matcher — pure function that tests whether an input (tool name or
 * file path) matches any pattern in a list of globs. A match signals "this
 * operation may require human-in-the-loop approval."
 *
 * This module is a PURE MATCHER. It never auto-approves, never weakens hard
 * limits, and never makes an approval decision. It only answers: "does this
 * input trigger a HITL pattern?" The caller (mandate evaluator / approval
 * gate) owns the decision.
 *
 * Supported glob syntax:
 * - `*`      — matches any characters except path separators (`/`, `\`)
 * - `**`     — matches zero or more complete path segments (globstar)
 * - `?`      — matches exactly one character except path separators
 * - Literal text is matched exactly (regex metacharacters are escaped)
 */

const RE_SEGMENT_SEPARATOR = "[/\\\\]";
const RE_NON_SEPARATOR = "[^/\\\\]";

/**
 * Escape regex metacharacters in literal glob text so they are treated as
 * plain characters rather than regex constructs.
 */
function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Convert a single path segment (no `/` or `\` inside) into its regex form.
 * `*` → zero or more non-separator chars; `?` → exactly one non-separator.
 */
function segmentToRegex(segment: string): string {
  let result = "";
  let remaining = segment;

  while (remaining.length > 0) {
    if (remaining.startsWith("*")) {
      result += `${RE_NON_SEPARATOR}*`;
      remaining = remaining.slice(1);
    } else if (remaining.startsWith("?")) {
      result += RE_NON_SEPARATOR;
      remaining = remaining.slice(1);
    } else {
      // Collect literal run until next special char.
      let literal = "";
      while (remaining.length > 0 && remaining[0] !== "*" && remaining[0] !== "?") {
        literal += remaining[0];
        remaining = remaining.slice(1);
      }
      result += escapeRegex(literal);
    }
  }

  return result;
}

/**
 * Convert a single glob pattern to a RegExp anchored at both ends (^…$).
 *
 * Strategy (segment-based, matches picomatch semantics):
 * 1. Normalize `\` → `/` so Windows and Unix paths use one separator.
 * 2. Collapse consecutive `/` into a single `/`.
 * 3. Split on `/` into segments.
 * 4. A `**` segment is a *globstar*: zero or more complete path segments
 *    (`(?:{non-sep}*{sep})*`).
 * 5. Other segments convert `*` → `{non-sep}*`, `?` → `{non-sep}`, literal
 *    chars are regex-escaped.
 * 6. Adjacent globstars absorb one intervening `/` so the separator between
 *    a globstar and its neighbour is carried inside the globstar repetition.
 */
function globToRegex(pattern: string): RegExp {
  // Normalize separators and collapse runs.
  const normalized = pattern.replace(/\\/gu, "/").replace(/\/{2,}/gu, "/");

  // Split into segments.
  const segments = normalized.split("/");

  // Build an intermediate list of {kind, value} tokens.
  type Token = { kind: "globstar" } | { kind: "segment"; re: string } | { kind: "sep" };
  const tokens: Token[] = [];

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    if (seg === "**") {
      tokens.push({ kind: "globstar" });
    } else {
      tokens.push({ kind: "segment", re: segmentToRegex(seg) });
    }
    // Inter-segment separator — only between non-empty runs and not after the last.
    // A globstar carries its own separators so the `sep` token is suppressed
    // before/after globstars; the globstar absorbs one adjacent `/`.
    if (i < segments.length - 1) {
      tokens.push({ kind: "sep" });
    }
  }

  // Collapse: when a globstar has a `sep` neighbour, absorb the sep into the
  // globstar (the globstar repetition includes its own separator).
  // After collapse, no `sep` token sits directly next to a `globstar`.
  const collapsed: Token[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.kind === "sep") {
      const prev = collapsed[collapsed.length - 1];
      const next = tokens[i + 1];
      if (prev?.kind === "globstar" || next?.kind === "globstar") {
        // Absorbed by adjacent globstar — skip.
        continue;
      }
    }
    collapsed.push(token);
  }

  // Emit regex fragments from collapsed tokens.
  const parts: string[] = [];
  for (const token of collapsed) {
    if (token.kind === "globstar") {
      // Zero or more complete path segments: each segment is non-separator
      // chars followed by a separator.
      parts.push(`(?:${RE_NON_SEPARATOR}*${RE_SEGMENT_SEPARATOR})*`);
    } else if (token.kind === "segment") {
      parts.push(token.re);
    } else {
      // token.kind === "sep"
      parts.push(RE_SEGMENT_SEPARATOR);
    }
  }

  // Trailing globstar: allow a final non-separator run after the last
  // repetition so `foo/**` matches `foo/bar` and `foo/bar/baz` as well as
  // `foo/` (the zero-rep case is already covered by `*` on the repetition).
  // Detect: last token is a globstar → append optional trailing segment.
  const lastToken = collapsed[collapsed.length - 1];
  if (lastToken?.kind === "globstar") {
    parts.push(`${RE_NON_SEPARATOR}*`);
  }

  const regexSource = parts.join("");
  return new RegExp(`^${regexSource}$`, "u");
}

/** Cache compiled regexps by pattern string — hot-path safe. */
const regexCache = new Map<string, RegExp>();

function compiledRegex(pattern: string): RegExp | null {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return null; // empty pattern never matches

  let cached = regexCache.get(trimmed);
  if (!cached) {
    cached = globToRegex(trimmed);
    regexCache.set(trimmed, cached);
  }
  return cached;
}

/**
 * Test whether `input` matches any glob pattern in `globs`.
 *
 * Returns `true` when at least one pattern matches the entire input string.
 * Returns `false` when no pattern matches or when the globs list is empty.
 *
 * A `true` result signals "this input triggered a HITL pattern" — it does NOT
 * auto-approve or bypass hard limits. The caller must still evaluate the full
 * mandate chain (deny rules → hard edges → grants → YOLO → escalation).
 *
 * @param input  Tool name or file path to test.
 * @param globs  Glob patterns to match against. Empty/invalid patterns are
 *               silently skipped (no false positive).
 */
export function requiresHitl(input: string, globs: readonly string[]): boolean {
  if (globs.length === 0) return false;
  // Normalize backslashes so Windows paths match `/`-based globs.
  const normalizedInput = input.replace(/\\/gu, "/");
  for (const pattern of globs) {
    const regex = compiledRegex(pattern);
    if (regex !== null && regex.test(normalizedInput)) {
      return true;
    }
  }
  return false;
}
