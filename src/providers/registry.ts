import { ProviderRouteDescriptorSchema, type ProviderRouteDescriptor, type ProviderRouteDescriptorInput } from "./schemas.js";

export interface ProviderRouteRegistry {
  readonly add: (route: ProviderRouteDescriptorInput) => ProviderRouteDescriptor;
  readonly all: () => readonly ProviderRouteDescriptor[];
  readonly findByRouteId: (routeId: string) => ProviderRouteDescriptor | undefined;
  readonly requireByRouteId: (routeId: string) => ProviderRouteDescriptor;
  readonly byProvider: (providerId: string) => readonly ProviderRouteDescriptor[];
  readonly byModel: (providerId: string, modelId: string) => readonly ProviderRouteDescriptor[];
  readonly toSnapshot: () => { readonly routes: readonly ProviderRouteDescriptor[]; readonly generatedAt: string };
}

export function defineProviderRoute(route: ProviderRouteDescriptorInput): ProviderRouteDescriptor {
  return ProviderRouteDescriptorSchema.parse(route);
}

export function createProviderRouteRegistry(initialRoutes: readonly ProviderRouteDescriptor[] = []): ProviderRouteRegistry {
  const routes = new Map<string, ProviderRouteDescriptor>();

  const registry: ProviderRouteRegistry = {
    add(route) {
      const parsed = defineProviderRoute(route);
      if (routes.has(parsed.routeId)) {
        throw new Error(`Duplicate provider route id: ${parsed.routeId}`);
      }
      routes.set(parsed.routeId, parsed);
      return parsed;
    },
    all() {
      return [...routes.values()].sort(compareRoutes);
    },
    findByRouteId(routeId) {
      return routes.get(routeId);
    },
    requireByRouteId(routeId) {
      const route = routes.get(routeId);
      if (!route) {
        throw new Error(`Provider route not found: ${routeId}`);
      }
      return route;
    },
    byProvider(providerId) {
      return registry.all().filter((route) => route.providerId === providerId);
    },
    byModel(providerId, modelId) {
      return registry.all().filter((route) => route.providerId === providerId && route.modelId === modelId);
    },
    toSnapshot() {
      return {
        generatedAt: new Date().toISOString(),
        routes: registry.all()
      };
    }
  };

  for (const route of initialRoutes) {
    registry.add(route);
  }

  return registry;
}

export interface ChatProviderLike {
  readonly id: string;
  readonly provider?: string;
  readonly baseUrl?: string;
  readonly apiKeyEnvVar?: string;
}

export function routeFromChatProvider(provider: ChatProviderLike, modelId: string): ProviderRouteDescriptor {
  return defineProviderRoute({
    providerId: provider.id,
    modelId,
    routeId: `${provider.id}/${modelId}`,
    routeType: "direct-api",
    apiFamily: provider.provider === "openai-compatible" ? "openai-chat-completions" : "custom",
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    credentialSource: provider.apiKeyEnvVar ? { type: "env-var", envVarName: provider.apiKeyEnvVar, envVarNames: [] } : { type: "none", envVarNames: [] },
    capabilities: {
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsStreaming: true,
      supportsTools: false,
      supportsReasoning: false,
      supportsWebSearch: false,
      supportsVision: false,
      supportsJsonMode: false,
      supportsImages: false,
      notes: ["Converted from current src/chat/providers shape for contract compatibility."]
    },
    context: {},
    cost: {},
    status: provider.apiKeyEnvVar ? "missing-credential" : "untested",
    caveats: ["Converted route needs Phase-1 parity metadata before it can be marked active."],
    directFirstRank: 100,
    allowedRouterFallback: true,
    metadata: { source: "src/chat/providers" }
  });
}

function compareRoutes(left: ProviderRouteDescriptor, right: ProviderRouteDescriptor): number {
  return left.directFirstRank - right.directFirstRank || left.providerId.localeCompare(right.providerId) || left.modelId.localeCompare(right.modelId) || left.routeId.localeCompare(right.routeId);
}
