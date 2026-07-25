import type { RouteCost } from "../providers/schemas.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** A single usage observation — typically one turn or one response. */
export interface UsageEntry {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

/** Per-model aggregated usage with honest cost estimation. */
export interface AggregatedUsage {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /**
   * Cents of estimated cost.
   * - `null`  → pricing unknown for this model (honest: we don't know).
   * - `0`     → pricing known and the computed cost genuinely rounds to zero
   *             (typically zero tokens with known pricing).
   */
  estimatedCostCents: number | null;
}

// ── formatCost ──────────────────────────────────────────────────────────────

/**
 * Format a cost-in-cents value for display.
 *
 * - `null`  → `"unknown"`  (price data missing — never say "$0" when we don't
 *   know)
 * - `0`     → `"$0.00"`    (genuinely free, known pricing)
 * - numeric → formatted USD with two decimals
 */
export function formatCost(cents: number | null): string {
  if (cents === null) return "unknown";
  // Round to whole cents before formatting
  const rounded = Math.round(cents);
  const dollars = (rounded / 100).toFixed(2);
  return `$${dollars}`;
}

// ── aggregateUsage ──────────────────────────────────────────────────────────

/**
 * Aggregate usage entries by model id, computing honest per-model totals.
 *
 * Each unique `modelId` gets its own bucket so a mid-session model switch
 * preserves counters separately.  A single model's usage across turns is summed.
 *
 * Cost estimation:
 * - When both `inputPerMillionTokens` and `outputPerMillionTokens` are present
 *   on the route's cost descriptor, the cost is computed and rounded to whole
 *   cents.
 * - When pricing info is absent (either field is `undefined`), `estimatedCostCents`
 *   is `null` — we honestly report that the cost is unknown instead of claiming $0.
 * - Zero tokens with known pricing yields `estimatedCostCents: 0`.
 *
 * @param entries    raw usage observations (one per turn/response)
 * @param costLookup function that resolves a model id to a {@link RouteCost}
 *                   (or `undefined` if the model isn't in the catalog)
 */
export function aggregateUsage(
  entries: readonly UsageEntry[],
  costLookup: (modelId: string) => RouteCost | undefined,
): Map<string, AggregatedUsage> {
  const byModel = new Map<string, AggregatedUsage>();

  for (const entry of entries) {
    let bucket = byModel.get(entry.modelId);
    if (!bucket) {
      bucket = {
        modelId: entry.modelId,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostCents: null,
      };
      byModel.set(entry.modelId, bucket);
    }

    bucket.inputTokens += entry.inputTokens;
    bucket.outputTokens += entry.outputTokens;
    bucket.totalTokens += entry.inputTokens + entry.outputTokens;
  }

  // Second pass: compute estimated costs for each model
  for (const [, bucket] of byModel) {
    const cost = costLookup(bucket.modelId);
    bucket.estimatedCostCents = computeCostCents(
      bucket.inputTokens,
      bucket.outputTokens,
      cost,
    );
  }

  return byModel;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute the cost in cents given token counts and a cost descriptor.
 *
 * Returns `null` when the pricing fields needed for the computation are absent
 * (honest: we don't know the cost), and `0` when tokens are non-zero but the
 * price is genuinely zero.
 */
function computeCostCents(
  inputTokens: number,
  outputTokens: number,
  cost: RouteCost | undefined,
): number | null {
  if (!cost) return null;

  const { inputPerMillionTokens, outputPerMillionTokens } = cost;

  // Both pricing fields must be present for an honest estimate.
  if (inputPerMillionTokens === undefined || outputPerMillionTokens === undefined) {
    return null;
  }

  const inputCost = (inputTokens / 1_000_000) * inputPerMillionTokens * 100;
  const outputCost = (outputTokens / 1_000_000) * outputPerMillionTokens * 100;

  return Math.round(inputCost + outputCost);
}
