import type { LiteLlmAlias } from "../router/schemas.js";
import type { ProviderRouteDescriptor } from "./schemas.js";

export type RoutePlanVerdict = "selected" | "rejected" | "not-found";
export type RoutePlanChoiceKind = "direct" | "operator-plan" | "native-cli" | "router-bridge" | "delegated" | "deferred" | "excluded";

export interface RoutePlanRequest {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly routeId?: string;
  readonly targetHarness?: string;
  readonly allowRouterBridge?: boolean;
  readonly requireRouterBridge?: boolean;
}

export interface RoutePlanDecision {
  readonly verdict: RoutePlanVerdict;
  readonly choice?: ProviderRouteDescriptor;
  readonly routerAlias?: LiteLlmAlias;
  readonly choiceKind?: RoutePlanChoiceKind;
  readonly policyReason: string;
  readonly caveats: readonly string[];
}

export function planRoute(
  request: RoutePlanRequest,
  routes: readonly ProviderRouteDescriptor[],
  routerAliases: readonly LiteLlmAlias[] = []
): RoutePlanDecision {
  if (request.providerId === "openrouter" || request.routeId?.startsWith("openrouter/")) {
    return reject("OpenRouter is excluded by Phase-1 policy.", ["Matthew must explicitly re-approve OpenRouter before it can be routed."]);
  }

  const candidates = findRouteCandidates(request, routes);
  const excluded = candidates.find((route) => route.routeType === "excluded" || route.status === "excluded-by-policy");
  if (excluded) {
    return {
      verdict: "rejected",
      choice: excluded,
      choiceKind: "excluded",
      policyReason: excluded.exclusionReason ?? "Route is excluded by policy.",
      caveats: excluded.caveats
    };
  }

  const usableDirect = candidates
    .filter((route) => route.routeType === "direct-api" && route.status !== "failing" && route.status !== "missing-credential")
    .sort(compareRoutePreference)[0];

  if (usableDirect && !request.requireRouterBridge) {
    return select(usableDirect, "direct", "Direct-first policy selected a native/direct provider route.");
  }

  const operatorPlan = candidates.find((route) => route.routeType === "operator-provider-plan-auth");
  if (operatorPlan && request.requireRouterBridge) {
    return reject("Operator-owned provider-plan/native auth tokens cannot be routed through LiteLLM.", operatorPlan.caveats, operatorPlan);
  }

  if (operatorPlan && !request.allowRouterBridge) {
    return select(operatorPlan, "operator-plan", "Direct-first policy selected operator-owned provider-plan/native auth route.");
  }

  const nativeCli = candidates.find((route) => route.routeType === "native-cli");
  if (nativeCli && !request.requireRouterBridge) {
    return select(nativeCli, "native-cli", "Selected native CLI route because no preferred direct API route was usable.");
  }

  if (request.allowRouterBridge || request.requireRouterBridge) {
    const routerAlias = findRouterAlias(request, routerAliases);
    if (routerAlias) {
      const route = candidates.find((candidate) => candidate.routeType === "router-bridge" || candidate.allowedRouterFallback) ?? routeFromAlias(routerAlias);
      if (route.routeType === "operator-provider-plan-auth") {
        return reject("Refused to route operator-owned provider-plan/native auth through LiteLLM.", route.caveats, route);
      }

      return {
        verdict: "selected",
        choice: route,
        routerAlias,
        choiceKind: "router-bridge",
        policyReason: request.requireRouterBridge ? "Explicit router bridge requested and policy allows this API-key/router-compatible route." : "No direct route was usable; router bridge fallback is policy-approved.",
        caveats: [...route.caveats, ...(routerAlias.providerGroup === "vertex-claude" ? ["Vertex Claude aliases may be pending quota."] : [])]
      };
    }
  }

  const deferred = candidates.find((route) => route.routeType === "deferred" || route.status === "deferred");
  if (deferred) {
    return select(deferred, "deferred", "Route is known but deferred until its adapter or credential lane is implemented.");
  }

  return {
    verdict: "not-found",
    policyReason: "No matching GuruHarness direct/native/delegated/router route is registered.",
    caveats: []
  };
}

function findRouteCandidates(request: RoutePlanRequest, routes: readonly ProviderRouteDescriptor[]): ProviderRouteDescriptor[] {
  if (request.routeId) {
    return routes.filter((route) => route.routeId === request.routeId);
  }

  return routes.filter((route) => {
    if (request.providerId && route.providerId !== request.providerId) return false;
    if (request.modelId && route.modelId !== request.modelId) return false;
    return true;
  });
}

function findRouterAlias(request: RoutePlanRequest, aliases: readonly LiteLlmAlias[]): LiteLlmAlias | undefined {
  if (request.routeId?.startsWith("router-")) {
    return aliases.find((alias) => alias.alias === request.routeId);
  }

  if (request.modelId?.startsWith("router-")) {
    return aliases.find((alias) => alias.alias === request.modelId);
  }

  return aliases.find((alias) => alias.alias === request.routeId || alias.alias === request.modelId || alias.model === request.modelId || alias.providerGroup === request.providerId);
}

function routeFromAlias(alias: LiteLlmAlias): ProviderRouteDescriptor {
  return {
    providerId: "litellm-router",
    modelId: alias.alias,
    routeId: `litellm-router/${alias.alias}`,
    routeType: "router-bridge",
    apiFamily: "litellm-openai-compatible",
    credentialSource: { type: "router-key", envVarNames: alias.credentialEnvVarNames },
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], supportsTools: false, supportsStreaming: true, supportsReasoning: false, supportsWebSearch: false, supportsVision: false, supportsJsonMode: false, supportsImages: false, notes: [] },
    context: {},
    cost: { currency: "USD", notes: [] },
    status: alias.providerGroup === "vertex-claude" ? "pending-quota" : "ready-unverified",
    caveats: [],
    compat: {},
    directFirstRank: 500,
    allowedRouterFallback: true,
    metadata: { routerAlias: alias.alias, providerGroup: alias.providerGroup }
  };
}

function select(route: ProviderRouteDescriptor, choiceKind: RoutePlanChoiceKind, policyReason: string): RoutePlanDecision {
  return { verdict: "selected", choice: route, choiceKind, policyReason, caveats: route.caveats };
}

function reject(policyReason: string, caveats: readonly string[], choice?: ProviderRouteDescriptor): RoutePlanDecision {
  return { verdict: "rejected", ...(choice ? { choice } : {}), policyReason, caveats };
}

function compareRoutePreference(left: ProviderRouteDescriptor, right: ProviderRouteDescriptor): number {
  return left.directFirstRank - right.directFirstRank || left.routeId.localeCompare(right.routeId);
}
