import type { MemoryFactEntry } from "./store.js";

/**
 * Global memory injection budget (IDEA-F27-MEM-BUDGET-01).
 *
 * Enforces a token/size ceiling on the home (global) memory block injected at
 * boot. Selection prefers recent, highly-cited facts so the injected context
 * stays lean and relevant rather than growing without bound. Secret values are
 * never selected by this module; it operates only on already-scrubbed fact
 * metadata (title/description), not bodies.
 */

export interface GlobalMemoryBudgetOptions {
  /** Maximum characters for the rendered memory block (not raw tokens). */
  readonly maxChars?: number;
  /** Maximum number of fact lines to inject. */
  readonly maxLines?: number;
  /** Optional decay half-life in days for the recency score (default 30). */
  readonly recencyHalfLifeDays?: number;
  /** Optional now source for deterministic tests. */
  readonly now?: () => Date;
}

export interface RankedMemoryFact {
  readonly entry: MemoryFactEntry;
  readonly score: number;
}

export interface TrimmedGlobalMemory {
  /** Selected facts in final injection order (highest score first). */
  readonly selected: readonly MemoryFactEntry[];
  /** Number of facts that did not fit under the budget. */
  readonly omitted: number;
  /** True when at least one fact was dropped due to the budget. */
  readonly trimmed: boolean;
}

/** Default modest budget: roughly one typical model message worth of context. */
export const DEFAULT_GLOBAL_MEMORY_BUDGET_CHARS = 2_048;
export const DEFAULT_GLOBAL_MEMORY_BUDGET_LINES = 50;
export const DEFAULT_RECENCY_HALF_LIFE_DAYS = 30;

/** Approximate character cost of one fact line after formatting. */
function factLineChars(entry: MemoryFactEntry): number {
  // conservative estimate: bullet + space + title + url + em-dash + description
  return 3 + entry.fact.title.length + entry.fact.name.length + 3 + entry.fact.description.length;
}

/** Recency score decays exponentially with age; updatedAt is the ISO timestamp. */
function recencyScore(updatedAt: string, nowMs: number, halfLifeDays: number): number {
  const ageMs = nowMs - Date.parse(updatedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return 1;
  }
  const ageDays = ageMs / (86_400_000);
  return 2 ** (-ageDays / halfLifeDays);
}

/** Quality/citation score from confidence (0-1), mapped to a positive multiplier. */
function qualityScore(confidence: number): number {
  const raw = typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 1;
  const clamped = Math.max(0, Math.min(1, raw));
  return 0.5 + clamped; // range [0.5, 1.5]: high-confidence facts float up, low-confidence sink.
}

/**
 * Compute a composite score for each global memory fact.
 *
 * Score = citationScore * recencyScore, so fresh, frequently-cited facts
 * surface first. This is the ranking half of the knowledge flywheel's
 * EXTRACT → GATE → STORE → INJECT → CITE → DECAY loop.
 */
export function rankGlobalMemoryFacts(
  entries: readonly MemoryFactEntry[],
  options: GlobalMemoryBudgetOptions = {}
): readonly RankedMemoryFact[] {
  const now = options.now?.() ?? new Date();
  const nowMs = now.getTime();
  const halfLifeDays = options.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;

  const scored = entries.map((entry) => ({
    entry,
    score: qualityScore(entry.fact.confidence) * recencyScore(entry.fact.updatedAt, nowMs, halfLifeDays)
  }));

  return scored.sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (scoreDelta !== 0) return scoreDelta;
    // Tie-break newest first, then alphabetically by name for determinism.
    const updatedAtDelta = right.entry.fact.updatedAt.localeCompare(left.entry.fact.updatedAt);
    if (updatedAtDelta !== 0) return updatedAtDelta;
    return left.entry.fact.name.localeCompare(right.entry.fact.name);
  });
}

/**
 * Select a subset of global memory facts that fit under the configured
 * character and line budget. Returns the selected entries, the omitted count,
 * and a trimmed flag.
 */
export function trimGlobalMemoryToBudget(
  entries: readonly MemoryFactEntry[],
  options: GlobalMemoryBudgetOptions = {}
): TrimmedGlobalMemory {
  const maxChars = options.maxChars ?? DEFAULT_GLOBAL_MEMORY_BUDGET_CHARS;
  const maxLines = options.maxLines ?? DEFAULT_GLOBAL_MEMORY_BUDGET_LINES;

  const ranked = rankGlobalMemoryFacts(entries, options);
  const selected: MemoryFactEntry[] = [];
  let usedChars = 0;
  let usedLines = 0;

  for (const { entry } of ranked) {
    if (usedLines >= maxLines) break;
    const lineCost = factLineChars(entry);
    if (usedChars + lineCost > maxChars && usedLines > 0) break;
    selected.push(entry);
    usedChars += lineCost;
    usedLines += 1;
  }

  return {
    selected,
    omitted: entries.length - selected.length,
    trimmed: selected.length < entries.length
  };
}

/**
 * Render the selected global memory facts into the injection block format used
 * by `inject.ts`. Secret values are structurally excluded: only title/name/description
 * (already scrubbed at write time) are rendered.
 */
export function renderGlobalMemoryBlock(selected: readonly MemoryFactEntry[]): string {
  if (selected.length === 0) return "";
  const lines = selected.map(
    (entry) => `- [${entry.fact.title}](${entry.fact.name}.md) — ${entry.fact.description}`
  );
  return ["", "## Guru memory (point-in-time facts — verify stale facts against current state; read bodies with memory_get)", ...lines].join("\n");
}

/**
 * Full budgeted injection pipeline for global (home) memory.
 *
 * Combines ranking, trimming, rendering, and metadata so callers can cite the
 * injected facts and report how much was omitted.
 */
export interface GlobalMemoryBudgetResult {
  readonly block: string;
  readonly selected: readonly MemoryFactEntry[];
  readonly omitted: number;
  readonly trimmed: boolean;
}

export function buildGlobalMemoryBudgetInjection(
  entries: readonly MemoryFactEntry[],
  options: GlobalMemoryBudgetOptions = {}
): GlobalMemoryBudgetResult {
  const { selected, omitted, trimmed } = trimGlobalMemoryToBudget(entries, options);
  return {
    block: renderGlobalMemoryBlock(selected),
    selected,
    omitted,
    trimmed
  };
}
