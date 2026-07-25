/**
 * Magic keyword turn flags — detect trigger keywords (ultrathink, orchestrate,
 * workflowz) in user prose while ignoring fenced code blocks.
 *
 * IDEA-F447-MAGIC-01 · ADR 2026-07-19-magic-keyword-turn-flags
 *
 * These keywords activate special turn behaviors: "ultrathink" enables
 * extended reasoning, "orchestrate" enables multi-agent fan-out, and
 * "workflowz" enables workflow-driven execution. Detection is case-insensitive
 * and keyword content inside triple-backtick fenced code blocks is excluded
 * so that code examples don't accidentally trigger behaviors.
 *
 * ## Design decisions
 *
 * - **Substring, not word-boundary**: keywords are artificial enough that
 *   substring matching is intentional (e.g. "ultrathinking" triggers).
 * - **Fenced blocks only**: inline code spans (`like this`) are treated as
 *   prose — the user typed them in the message body. Only triple-backtick
 *   blocks (``` … ```) are excluded.
 * - **Unclosed fence → safe default**: an unclosed opening ``` treats the
 *   remainder of the text as code so a stray fence in a model response or
 *   truncated input doesn't accidentally trigger behavior.
 * - **Case-insensitive**: magic keywords are trigger words, not identifiers;
 *   "ULTRATHINK" and "ultrathink" are equivalent.
 */

export const MAGIC_KEYWORDS = ["ultrathink", "orchestrate", "workflowz"] as const;

/** Union of the three canonical magic keywords. */
export type MagicKeyword = (typeof MAGIC_KEYWORDS)[number];

/**
 * Strip fenced code blocks (``` … ```) from `text`, replacing each block
 * with the same number of newline characters so line counts are preserved
 * for downstream consumers that may rely on line positions.
 *
 * An unclosed opening fence (no matching ```) removes everything from the
 * fence to end-of-text — safe default: better to miss a keyword than to
 * false-trigger on code.
 */
function stripFencedCodeBlocks(text: string): string {
  // Match ``` optionally followed by a language tag, then everything
  // (non-greedy) until a closing ```, all at start-of-line.
  // Falls back to removing to end-of-string if unclosed.
  const FENCE = /^```[^\n]*\n[\s\S]*?^```/gm;

  let result = text;
  // First pass: strip well-formed fenced blocks.
  result = result.replace(FENCE, (match) => {
    // Replace with the same count of newlines to preserve line indexing.
    const newlineCount = (match.match(/\n/g) ?? []).length;
    return "\n".repeat(newlineCount);
  });

  // Second pass: handle unclosed fences — an opening ``` at line start
  // with no matching close. Remove from fence to end-of-text.
  const UNCLOSED_FENCE = /^```[^\n]*\n[\s\S]*$/m;
  result = result.replace(UNCLOSED_FENCE, (match) => {
    const newlineCount = (match.match(/\n/g) ?? []).length;
    return "\n".repeat(newlineCount);
  });

  return result;
}

/**
 * Detect which magic keywords appear in `text`.
 *
 * Keywords inside fenced code blocks (``` … ```) are ignored; keywords
 * anywhere else — including inline code spans — are detected.
 * Matching is case-insensitive. Each keyword is returned at most once.
 *
 * @returns the set of detected magic keywords, in canonical order
 */
export function detect(text: string): MagicKeyword[] {
  if (!text || !text.trim()) return [];

  const prose = stripFencedCodeBlocks(text);
  const lower = prose.toLowerCase();

  return MAGIC_KEYWORDS.filter((kw) => lower.includes(kw));
}
