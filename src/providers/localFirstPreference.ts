import type { ProviderRouteDescriptor } from "./schemas.js";

/**
 * Prefer ready local Ollama-compatible routes without changing the catalog's
 * direct-first order for every other route.
 */
export function rankProviders(routes: readonly ProviderRouteDescriptor[]): readonly ProviderRouteDescriptor[] {
  return [...routes].sort(compareProviders);
}

function compareProviders(left: ProviderRouteDescriptor, right: ProviderRouteDescriptor): number {
  return localPreferenceRank(left) - localPreferenceRank(right) || left.directFirstRank - right.directFirstRank || left.providerId.localeCompare(right.providerId) || left.modelId.localeCompare(right.modelId) || left.routeId.localeCompare(right.routeId);
}

function localPreferenceRank(route: ProviderRouteDescriptor): number {
  return route.apiFamily === "ollama-openai-compatible" && isReady(route) ? 0 : 1;
}

function isReady(route: ProviderRouteDescriptor): boolean {
  return route.status === "active" || route.status === "ready-unverified";
}
