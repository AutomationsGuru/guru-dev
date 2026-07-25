/**
 * Honest cost display (IDEA-C4 / R-CW-COST).
 *
 * Hard-limit §3.2 (no unapproved spend) applies to display, not just gates:
 * an unknown price is rendered as "unknown", never fabricated as $0 — a $0
 * readout invites unbudgeted spend by looking free. A genuinely zero-cost
 * turn (zero tokens on a metered route, or a plan-included route whose rates
 * are known to be 0) is real data and renders as $0.00.
 *
 * Pure: no I/O, no config reads. Callers pass route cost metadata and token
 * counts; this module only formats. It never invents a price.
 */

import type { TuiCost } from "../tui/schemas.js";

export interface TokenCount {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** USD rate hints needed to price a turn. Either side may be unknown. */
export interface TurnRates {
  readonly inputPerMillionUsd?: number;
  readonly outputPerMillionUsd?: number;
}

function isUsableRate(rate: number | undefined): rate is number {
  return typeof rate === "number" && Number.isFinite(rate) && rate >= 0;
}

/** Format one per-million-token rate; unknown/invalid → "unknown", never $0. */
export function formatRatePerMillion(ratePerMillionUsd: number | undefined): string {
  if (!isUsableRate(ratePerMillionUsd)) {
    return "unknown";
  }
  return `$${ratePerMillionUsd.toFixed(2)}`;
}

/**
 * Token-weighted USD estimate for one turn.
 * Returns null when either rate is unknown — the caller must render that as
 * "unknown", never substitute 0. Zero tokens on known rates yields a real
 * "$0.0000" string.
 */
export function formatTurnCost(tokens: TokenCount, rates: TurnRates | undefined): string | null {
  if (rates === undefined) {
    return null;
  }
  if (!isUsableRate(rates.inputPerMillionUsd) || !isUsableRate(rates.outputPerMillionUsd)) {
    return null;
  }
  const usd =
    (tokens.inputTokens / 1_000_000) * rates.inputPerMillionUsd +
    (tokens.outputTokens / 1_000_000) * rates.outputPerMillionUsd;
  return `$${usd.toFixed(4)}`;
}

/**
 * Accumulated session cost readout for the status foot. An untracked
 * accumulator is "unknown" — the absence of a number is not evidence of $0.
 */
export function formatUsageCost(costUsd: number | undefined): string {
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) {
    return "unknown";
  }
  return `$${costUsd.toFixed(4)}`;
}

/**
 * One-line cost suffix for a model row in the provider picker.
 * Known rates render as "$in/$out per 1M tok"; an unknown side is named
 * "unknown" explicitly; a cost block with no rates renders "cost unknown";
 * a missing cost block contributes nothing ("").
 */
export function renderModelCost(cost: TuiCost | undefined): string {
  if (cost === undefined) {
    return "";
  }
  if (!isUsableRate(cost.inputPerMillionUsd) && !isUsableRate(cost.outputPerMillionUsd)) {
    return " · cost unknown";
  }
  return ` · ${formatRatePerMillion(cost.inputPerMillionUsd)}/${formatRatePerMillion(cost.outputPerMillionUsd)} per 1M tok`;
}
