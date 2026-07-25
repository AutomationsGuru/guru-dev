/**
 * Tool output ergonomics (IDEA-E2-TOOL-ERGO-01, ideation review
 * 2026-07-17_agentic-setup): high-traffic built-ins return minimal structured
 * fields, aggregates for large lists, and structured errors — never giant raw
 * dumps. These helpers are pure and dependency-free; the tools own their
 * schemas, this module owns the shared truncation / aggregation / error-code
 * machinery so grep, glob, ls, and bash cap and summarize output consistently.
 *
 * Hard edges are untouched: ergonomics shape what a tool REPORTS, never what a
 * tool is allowed to DO — containment, allowlist, and secret checks resolve
 * before any of this runs.
 */

/** Stable machine-readable error codes for structured tool failures. */
export const TOOL_ERROR_CODES = {
  PATH_ESCAPE: "PATH_ESCAPE",
  INVALID_PATTERN: "INVALID_PATTERN",
  IO_ERROR: "IO_ERROR",
  POLICY_BLOCKED: "POLICY_BLOCKED"
} as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[keyof typeof TOOL_ERROR_CODES];

/** Cap for a single reported match/content line (chars). */
export const DEFAULT_MATCH_LINE_MAX_CHARS = 400;
/** Cap for inline item lists inside human-readable summaries. */
export const DEFAULT_SUMMARY_LIST_LIMIT = 20;

export interface StructuredToolError {
  readonly code: ToolErrorCode;
  readonly blocker: string;
  readonly summary: string;
}

/** Structured error triple: stable code + human blocker + human summary. */
export function buildError(code: ToolErrorCode, blocker: string, summary: string): StructuredToolError {
  return { code, blocker, summary };
}

export interface Utf8Truncation {
  readonly value: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
}

/**
 * Byte-bounded truncation that never splits a UTF-8 sequence (the boundary
 * walk mirrors bashTool's own truncate): the byte AT the cut must be a lead
 * byte, and a partial multibyte char at the edge is dropped whole.
 */
export function truncateUtf8(value: string, maxBytes: number): Utf8Truncation {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) {
    return { value, truncated: false, originalBytes: buffer.length };
  }
  let cut = maxBytes;
  while (cut > 0 && (buffer[cut]! & 0xc0) === 0x80) {
    cut -= 1;
  }
  if (cut > 0 && (buffer[cut - 1]! & 0xc0) === 0xc0) {
    const lead = buffer[cut - 1]!;
    const seqLen = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (cut - 1 + seqLen > maxBytes) {
      cut -= 1;
    }
  }
  return { value: buffer.subarray(0, cut).toString("utf8"), truncated: true, originalBytes: buffer.length };
}

export interface LineTruncation {
  readonly value: string;
  readonly truncated: boolean;
  readonly originalChars: number;
  readonly elidedChars: number;
}

/** Char-bounded single-line cap with an explicit elision marker. */
export function truncateLine(line: string, maxChars: number = DEFAULT_MATCH_LINE_MAX_CHARS): LineTruncation {
  if (line.length <= maxChars) {
    return { value: line, truncated: false, originalChars: line.length, elidedChars: 0 };
  }
  const kept = line.slice(0, maxChars);
  const elided = line.length - maxChars;
  return { value: `${kept}…[+${elided} chars elided]`, truncated: true, originalChars: line.length, elidedChars: elided };
}

export interface KeyCount {
  readonly key: string;
  readonly count: number;
}

export interface CountAggregate {
  readonly total: number;
  readonly uniqueKeys: number;
  readonly top: readonly KeyCount[];
}

/** Frequency aggregate over a key stream: totals, unique keys, top-N by count. */
export function aggregateCounts(keys: Iterable<string>, limit: number = DEFAULT_SUMMARY_LIST_LIMIT): CountAggregate {
  const counts = new Map<string, number>();
  let total = 0;
  for (const key of keys) {
    total += 1;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
    .slice(0, Math.max(0, limit));
  return { total, uniqueKeys: counts.size, top };
}

/** Bounded inline list: `a (2), b (1), … +N more`. */
function formatCountedList(top: readonly KeyCount[], uniqueKeys: number, limit: number): string {
  const rendered = top.map((entry) => `${entry.key} (${entry.count})`).join(", ");
  const remainder = uniqueKeys - Math.min(uniqueKeys, Math.max(0, limit));
  return remainder > 0 ? `${rendered}, … +${remainder} more` : rendered;
}

/** Bounded inline list of plain items: `a, b, … +N more`. */
function formatItemList(items: readonly string[], limit: number): string {
  const shown = items.slice(0, Math.max(0, limit));
  const remainder = items.length - shown.length;
  const rendered = shown.join(", ");
  return remainder > 0 ? `${rendered}, … +${remainder} more` : rendered;
}

/**
 * Match-set summary with per-file aggregation: `N match(es) across M file(s)
 * (truncated): file (count), …` — large file sets collapse into the top list.
 */
export function buildMatchSummary(
  matches: readonly { readonly file: string; readonly [key: string]: unknown }[],
  truncated: boolean,
  limit: number = DEFAULT_SUMMARY_LIST_LIMIT
): string {
  if (matches.length === 0) {
    return `0 match(es)${truncated ? " (truncated)" : ""}.`;
  }
  const perFile = aggregateCounts(matches.map((match) => match.file), limit);
  const files = formatCountedList(perFile.top, perFile.uniqueKeys, limit);
  return `${matches.length} match(es) across ${perFile.uniqueKeys} file(s)${truncated ? " (truncated)" : ""}: ${files}.`;
}

export interface ListSummaryInput {
  readonly noun: string;
  readonly shownCount: number;
  readonly totalCount: number;
  readonly truncated: boolean;
  readonly items?: readonly string[];
  readonly limit?: number;
}

/**
 * List summary with shown-of-total aggregation: `K of N path(s) (truncated):
 * item, … +M more` — oversized listings report the aggregate, not the flood.
 */
export function buildListSummary(input: ListSummaryInput): string {
  const head = input.truncated ? `${input.shownCount} of ${input.totalCount}` : `${input.totalCount}`;
  const suffix = input.truncated ? " (truncated)" : "";
  if (input.items === undefined || input.items.length === 0) {
    return `${head} ${input.noun}(s)${suffix}.`;
  }
  return `${head} ${input.noun}(s)${suffix}: ${formatItemList(input.items, input.limit ?? DEFAULT_SUMMARY_LIST_LIMIT)}.`;
}

export interface LineProfile {
  readonly lineCount: number;
  readonly uniqueLines: number;
  readonly repeatedLines: number;
  readonly maxLineChars: number;
  readonly topLines: readonly KeyCount[];
}

/** Full line profile for a stream: counts, repetition, and width aggregates. */
export function summarizeLines(output: string, limit: number = 5): LineProfile {
  if (output.length === 0) {
    return { lineCount: 0, uniqueLines: 0, repeatedLines: 0, maxLineChars: 0, topLines: [] };
  }
  const lines = output.split("\n");
  // A trailing newline terminates the last line; it is not an empty extra line.
  const effective = lines.length > 1 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  const counts = new Map<string, number>();
  let maxLineChars = 0;
  for (const line of effective) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
    if (line.length > maxLineChars) {
      maxLineChars = line.length;
    }
  }
  let repeatedLines = 0;
  for (const count of counts.values()) {
    if (count > 1) {
      repeatedLines += 1;
    }
  }
  const topLines = [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
    .slice(0, Math.max(0, limit));
  return { lineCount: effective.length, uniqueLines: counts.size, repeatedLines, maxLineChars, topLines };
}

/** Banner prefix marking an aggregated (not raw) oversized-output payload. */
export const OUTPUT_SUMMARY_BANNER = "[guru output summary]";

/**
 * Render an aggregate profile banner for an oversized stream: the model gets
 * the line/repetition/width profile plus a bounded excerpt of the head, never
 * the raw flood.
 */
export function renderOutputSummary(profile: LineProfile, originalBytes: number, excerpt: string): string {
  const parts = [
    `${OUTPUT_SUMMARY_BANNER} ${profile.lineCount} line(s), ${originalBytes} byte(s), ${profile.uniqueLines} unique, ${profile.repeatedLines} repeated, longest line ${profile.maxLineChars} char(s).`
  ];
  if (profile.topLines.some((entry) => entry.count > 1)) {
    const repeated = profile.topLines
      .filter((entry) => entry.count > 1)
      .map((entry) => `"${truncateLine(entry.key, 80).value}" ×${entry.count}`)
      .join(", ");
    parts.push(`Top repeated: ${repeated}.`);
  }
  parts.push("--- head excerpt ---", excerpt);
  return parts.join("\n");
}
