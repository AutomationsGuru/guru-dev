import type { ProviderRouteDescriptor } from "../providers/schemas.js";

export type RemainingBudget = "unknown" | number;

export interface QuotaRouteHints {
  /** Remaining budget in the same currency as the route costs, or 'unknown'. */
  readonly remainingBudget?: RemainingBudget;
  /** When true, prefer cheaper routes and deprioritize routes with unknown cost. */
  readonly preferEconomy?: boolean;
}

/**
 * Rank routes by optional quota/budget hints. The sort is stable and never
 * invents costs: routes with unknown cost sort after routes with known cost
 * when economy mode is active with a known budget, and the original order is
 * preserved otherwise.
 *
 * This is a hint, not a spend approval mechanism. Unknown cost is not free.
 */
export function rankRoutes(
  routes: readonly ProviderRouteDescriptor[],
  hints: QuotaRouteHints = {}
): ProviderRouteDescriptor[] {
  if (!hints.preferEconomy || !hasKnownBudget(hints.remainingBudget)) {
    return [...routes];
  }

  return [...routes].sort((left, right) => {
    const leftKnown = isCostKnown(left.cost);
    const rightKnown = isCostKnown(right.cost);

    if (leftKnown && rightKnown) return compareCost(left.cost, right.cost);

    if (leftKnown && !rightKnown) return -1;
    if (!leftKnown && rightKnown) return 1;

    return 0;
  });
}

function hasKnownBudget(remainingBudget: RemainingBudget | undefined): remainingBudget is number {
  return typeof remainingBudget === "number" && Number.isFinite(remainingBudget);
}

function isCostKnown(cost: ProviderRouteDescriptor["cost"]): boolean {
  return typeof cost.inputPerMillionTokens === "number" && typeof cost.outputPerMillionTokens === "number";
}

function compareCost(left: ProviderRouteDescriptor["cost"], right: ProviderRouteDescriptor["cost"]): number {
  const leftCost = left.inputPerMillionTokens! + left.outputPerMillionTokens!;
  const rightCost = right.inputPerMillionTokens! + right.outputPerMillionTokens!;
  return leftCost - rightCost;
}
