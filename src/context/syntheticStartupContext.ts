/**
 * Synthetic startup context (IDEA-F125-STARTUP-CTX-01, composes F90 context
 * providers + F99 JIT context). Builds a SMALL system/context block — date, OS,
 * cwd, shallow listing — for chat-model sessions, so a session starts with
 * honest ground truth about where it is WITHOUT a full repo dump. Pure and
 * dependency-injected (no fs/os calls in here): callers read the environment
 * and pass values in, which keeps the kernel light and the block deterministic
 * and unit-testable.
 */

/** Default cap on shallow-listing entries; the rest collapse into one note. */
export const DEFAULT_MAX_LISTING_ENTRIES = 50;

export interface StartupContextInput {
  /** Working directory the session is anchored to. */
  readonly cwd: string;
  /** OS label, e.g. `process.platform` or `linux (x64)`. */
  readonly os: string;
  /** Injected clock — callers pass `new Date()`; tests pass a fixed instant. */
  readonly date: Date;
  /** Shallow (one-level) listing of `cwd`, already read by the caller. */
  readonly listing: readonly string[];
  /** Listing cap; entries past it are replaced by a single omission note. */
  readonly maxListingEntries?: number;
}

/**
 * Render the synthetic startup context block as plain text. Deterministic for
 * a given input: the same `{cwd, os, date, listing}` always yields the same
 * string, so it is safe to snapshot, diff, and cite.
 */
export function buildStartupContext(input: StartupContextInput): string {
  const maxEntries = input.maxListingEntries ?? DEFAULT_MAX_LISTING_ENTRIES;
  const dateStamp = formatDate(input.date);
  const shown = input.listing.slice(0, maxEntries);
  const omitted = input.listing.length - shown.length;

  const lines: string[] = [
    "## Startup context",
    `- Date: ${dateStamp}`,
    `- OS: ${input.os}`,
    `- Working directory: ${input.cwd}`,
    `- Directory listing (${shown.length} of ${input.listing.length} entries shown):`
  ];
  for (const entry of shown) {
    lines.push(`  - ${entry}`);
  }
  if (omitted > 0) {
    lines.push(`  - … ${omitted} more entries omitted (shallow listing cap)`);
  }
  return lines.join("\n");
}

/** UTC calendar date — deterministic regardless of host timezone. */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
