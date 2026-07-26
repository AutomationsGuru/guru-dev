import { createDirectProviderCatalog, DIRECT_PROVIDER_CATALOG } from "../providers/catalog.js";
import type { ProviderRouteDescriptor } from "../providers/schemas.js";

/**
 * Read-only metadata projection over the canonical provider catalog
 * (`src/providers/catalog.ts`).  This stub exists so harness profile code
 * can query model→provider defaults through one thin surface without
 * depending on catalog internals.
 *
 * **It is NOT a second catalog.**  The source of truth stays in the
 * canonical `DIRECT_PROVIDER_CATALOG` / `createDirectProviderCatalog()`.
 * Any residual merged here should eventually land in the F101 / canonical
 * provider-selection surface after review.
 *
 * Coordinator constraint: no credentials, provider invocation, route
 * selection, router/LiteLLM mutation, network probe, favored-provider
 * default, or duplicate provider registry.  Unknown models remain explicit.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Lightweight profile view of one catalog entry. */
export interface ProviderProfile {
  readonly providerId: string;
  readonly modelId: string;
  readonly routeId: string;
  readonly apiFamily?: string;
  readonly status: string;
  readonly context: {
    readonly contextWindowTokens?: number;
    readonly maxOutputTokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the full canonical provider catalog.
 *
 * Every call returns a fresh snapshot; the underlying catalog is immutable
 * per process lifetime (sheet-derived + codex-direct + ollama-local).
 */
export function loadCatalog(): readonly ProviderRouteDescriptor[] {
  return createDirectProviderCatalog();
}

/**
 * Resolve a bare model name to its default harness profile.
 *
 * When multiple providers serve the same model the highest-ranked route
 * (lowest `directFirstRank`) wins.  The canonical catalog's direct-first
 * ranking is the sole defaulting mechanism — this function never invents a
 * default, never favors a specific provider, and never probes the network.
 *
 * @returns The default profile, or `null` when the model is unknown.
 *          Unknown → explicit null, never a silent fallback.
 */
export function defaultProfile(model: string): ProviderProfile | null {
  const catalog = DIRECT_PROVIDER_CATALOG;
  const candidates = catalog.filter(
    (route) => route.modelId === model || route.routeId === model || route.routeId.endsWith(`/${model}`),
  );

  if (candidates.length === 0) return null;

  // Highest rank = lowest directFirstRank; break ties on routeId stability.
  candidates.sort((a, b) => a.directFirstRank - b.directFirstRank || a.routeId.localeCompare(b.routeId));

  const best = candidates[0];
  return {
    providerId: best.providerId,
    modelId: best.modelId,
    routeId: best.routeId,
    apiFamily: best.apiFamily,
    status: best.status,
    context: {
      contextWindowTokens: best.context.contextWindowTokens,
      maxOutputTokens: best.context.maxOutputTokens,
    },
  };
}
