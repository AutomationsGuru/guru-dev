export type RouterMode = "vibe" | "spec" | "bugfix";

const TRIVIAL_FIX_SIGNALS = [
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
] as const;

const BUGFIX_SIGNALS = [
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
  "stack trace",
  "stacktrace",
  "exception",
  "error",
  "fix"
] as const;

const SPEC_SIGNALS = [
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
] as const;

/**
 * Classify a task prompt without executing it or consulting a model.
 *
 * Substantive defect language wins first, except for small touch-ups such as
 * typo and wording fixes. Structured-work language wins next; all other asks
 * stay in the lightweight ad-hoc mode.
 */
export function route(prompt: string): RouterMode {
  const normalized = prompt.toLowerCase();
  const hasTrivialFix = containsAny(normalized, TRIVIAL_FIX_SIGNALS);

  if (containsAny(normalized, BUGFIX_SIGNALS) && !hasTrivialFix) {
    return "bugfix";
  }

  if (containsAny(normalized, SPEC_SIGNALS)) {
    return "spec";
  }

  return "vibe";
}

function containsAny(value: string, signals: readonly string[]): boolean {
  return signals.some((signal) => value.includes(signal));
}
