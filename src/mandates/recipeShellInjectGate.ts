/**
 * Recipe shell-injection gate (IDEA-F530-RECIPE-01).
 *
 * Pure guard that blocks shell-injection patterns in a single recipe arg before it
 * ever reaches a shell. Returns `true` when the arg **may** inject (reject it);
 * returns `false` when the arg is structurally safe.
 *
 * The gate is deliberately fail-closed: ambiguous patterns are treated as
 * injection so a novel bypass shape cannot silently pass.
 *
 * Detected patterns:
 * - Command substitution: `$(…)` and backtick execution `` `…` ``
 * - Shell metacharacters: `;` `|` `&` `&&` `||`
 * - Redirections: `>` `>>` `<`
 * - Embedded newlines (command boundaries)
 * - Shell variable/parameter expansion: `${…}` `$VAR`
 * - Brace expansion: `{…,…}`
 *
 * NOT detected (and therefore safe):
 * - Parentheses without a leading `$`
 * - Literal dollar signs in single-quote-like contexts (out-of-scope)
 * - Data that coincidentally contains “safe” metacharacters (`.` `-` `_` `/`)
 */

/** Shell metacharacters that signal command chaining or injection in an arg. */
const SHELL_METACHAR_PATTERN = /[;&|><]/u;

/** `$(…)` command substitution. */
const DOLLAR_PAREN_PATTERN = /\$\(/u;

/** Backtick command substitution. */
const BACKTICK_PATTERN = /`/u;

/** Bare `$VAR` or `${VAR}` expansion — a shell-processed arg signal. */
const SHELL_EXPANSION_PATTERN = /\$\{?[A-Za-z_]/u;

/** `{a,b}` brace expansion. */
const BRACE_EXPANSION_PATTERN = /\{[^{}]*,[^{}]*\}/u;

/** Embedded newline (could terminate/inject a command boundary). */
const NEWLINE_PATTERN = /\n/u;

/** `&&` or `||` — shell AND/OR list operators. */
const SHELL_LIST_OPERATOR = /&&|\|\|/u;

/**
 * Returns `true` when `arg` contains a pattern that could inject shell commands.
 * Empty / whitespace-only args are safe (no injection surface).
 */
export function mayInject(arg: string): boolean {
  // An empty or whitespace-only arg has nothing to inject.
  if (arg.trim().length === 0) {
    return false;
  }

  // Command substitution — the most direct injection vector.
  if (DOLLAR_PAREN_PATTERN.test(arg)) {
    return true;
  }

  // Backtick command substitution (legacy POSIX form).
  if (BACKTICK_PATTERN.test(arg)) {
    return true;
  }

  // `&&` / `||` — explicit shell list operators (checked before
  // SHELL_METACHAR_PATTERN to avoid partial-match ambiguity).
  if (SHELL_LIST_OPERATOR.test(arg)) {
    return true;
  }

  // Shell metacharacters: `;` `|` `&` `>` `<`.
  if (SHELL_METACHAR_PATTERN.test(arg)) {
    return true;
  }

  // Shell variable / parameter expansion.
  if (SHELL_EXPANSION_PATTERN.test(arg)) {
    return true;
  }

  // Brace expansion.
  if (BRACE_EXPANSION_PATTERN.test(arg)) {
    return true;
  }

  // Embedded newline — a command separator in most shells.
  if (NEWLINE_PATTERN.test(arg)) {
    return true;
  }

  return false;
}
