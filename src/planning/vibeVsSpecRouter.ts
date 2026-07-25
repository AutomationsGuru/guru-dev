import { z } from "zod";

export const RouterModeSchema = z.enum(["vibe", "spec", "bugfix"]);
export type RouterMode = z.infer<typeof RouterModeSchema>;

export const RouteResultSchema = z
  .object({
    mode: RouterModeSchema,
    confidence: z.number().min(0).max(1),
    reasons: z.array(z.string().trim().min(1))
  })
  .strict();
export type RouteResult = z.infer<typeof RouteResultSchema>;

/**
 * Trivial-fix signals: a prompt mentioning "fix" alongside one of these is a
 * small ad-hoc touch-up (typo, comment, wording, one-liner), so it routes to
 * vibe instead of bugfix.
 */
export const TRIVIAL_FIX_KEYWORDS: readonly string[] = Object.freeze([
  "typo",
  "spelling",
  "grammar",
  "comment",
  "wording",
  "whitespace",
  "formatting",
  "one-liner",
  "one liner",
  "tiny",
  "small fix",
  "quick fix",
  "rename"
]);

/**
 * Substantive bugfix signals: regressions, crashes, failures, and explicit
 * defect language that implies diagnosis and a real repair.
 */
export const BUGFIX_KEYWORDS: readonly string[] = Object.freeze([
  "bug",
  "regression",
  "broken",
  "crash",
  "hotfix",
  "not working",
  "doesn't work",
  "does not work",
  "fails",
  "failing",
  "failing test",
  "stack trace",
  "stacktrace",
  "exception",
  "error",
  "fix"
]);

/**
 * Structured-work signals: prompts describing larger builds, new features, or
 * multi-file/multi-component scope.
 */
export const SPEC_KEYWORDS: readonly string[] = Object.freeze([
  "implement",
  "build",
  "design",
  "architect",
  "architecture",
  "add support for",
  "add a feature",
  "new feature",
  "feature",
  "system",
  "end-to-end",
  "end to end",
  "across",
  "multiple files",
  "multiple components",
  "multi-file",
  "multi-component",
  "refactor",
  "migrate",
  "scaffold"
]);

/**
 * Small ad-hoc signals: tweak-style one-off asks that default to vibe.
 */
export const VIBE_KEYWORDS: readonly string[] = Object.freeze([
  "tweak",
  "adjust",
  "rename",
  "typo",
  "comment",
  "wording",
  "one-off",
  "quick"
]);

/**
 * Classification precedence (first match wins):
 *
 * 1. bugfix — a substantive defect signal (BUGFIX_KEYWORDS) is present AND the
 *    prompt is not framed as a trivial fix. A trivial fix (e.g. "fix the typo",
 *    "quick wording fix") mentions "fix" but means a small touch-up, so the
 *    TRIVIAL_FIX_KEYWORDS check vetoes the bugfix route and the prompt falls
 *    through to the spec/vibe checks below.
 * 2. spec — structured-work signals (SPEC_KEYWORDS) such as "implement",
 *    "build", "system", or multi-file scope ("across", "multiple files").
 * 3. vibe — default for everything else: short, small, ad-hoc asks.
 *
 * Empty or whitespace-only prompts route to vibe with zero matched reasons;
 * an empty ask carries no structure, so the smallest mode is the safe default.
 */
export function route(prompt: string): RouteResult {
  const normalized = prompt.toLowerCase();
  const reasons: string[] = [];

  const trivialFix = containsAny(normalized, TRIVIAL_FIX_KEYWORDS);
  const bugfixMatches = findMatches(normalized, BUGFIX_KEYWORDS);

  if (bugfixMatches.length > 0 && !trivialFix) {
    reasons.push(...bugfixMatches.map((keyword) => `bugfix signal: "${keyword}"`));

    return { mode: "bugfix", confidence: 0.8, reasons };
  }

  const specMatches = findMatches(normalized, SPEC_KEYWORDS);

  if (specMatches.length > 0) {
    reasons.push(...specMatches.map((keyword) => `spec signal: "${keyword}"`));

    return { mode: "spec", confidence: 0.7, reasons };
  }

  const vibeMatches = findMatches(normalized, VIBE_KEYWORDS);
  reasons.push(...vibeMatches.map((keyword) => `vibe signal: "${keyword}"`));

  if (trivialFix) {
    reasons.push("trivial fix signal: small touch-up, not a substantive bugfix");
  }

  if (prompt.trim().length === 0) {
    reasons.push("empty prompt: defaulting to the smallest mode");
  }

  if (reasons.length === 0) {
    reasons.push("no structured-work or bugfix signals: defaulting to vibe");
  }

  return { mode: "vibe", confidence: 0.6, reasons };
}

function findMatches(haystack: string, keywords: readonly string[]): string[] {
  return keywords.filter((keyword) => haystack.includes(keyword));
}

function containsAny(haystack: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => haystack.includes(keyword));
}
