import type { RouterHealthReport } from "../router/health.js";
import type { ProviderRouteDescriptor, RouteStatus } from "./schemas.js";

export type ProviderAvailabilityStatus = "active" | "ready-unverified" | "missing-key" | "needs-login" | "router-offline" | "pending-quota" | "works-with-caveat" | "delegated" | "excluded-by-policy";

export interface ProviderAvailability {
  readonly providerId: string;
  readonly modelId: string;
  readonly routeId: string;
  readonly routeType: ProviderRouteDescriptor["routeType"];
  readonly status: ProviderAvailabilityStatus;
  readonly requiredEnvVarNames: readonly string[];
  readonly presentEnvVarNames: readonly string[];
  readonly missingEnvVarNames: readonly string[];
  readonly credentialSourceType: ProviderRouteDescriptor["credentialSource"]["type"];
  readonly caveats: readonly string[];
  readonly setupHints: readonly string[];
}

export interface EnvironmentNameReader {
  readonly has: (name: string) => boolean;
}

export interface FilePresenceReader {
  readonly exists: (path: string) => boolean;
}

export interface ProviderDiscoveryOptions {
  readonly env?: EnvironmentNameReader;
  readonly userEnv?: EnvironmentNameReader;
  readonly files?: FilePresenceReader;
  readonly routerHealth?: RouterHealthReport;
  /** Env-var names held in the guru vault — count as PRESENT (the vault is an env alternative). */
  readonly vaultNames?: ReadonlySet<string>;
}

export function scanProviderReadiness(routes: readonly ProviderRouteDescriptor[], options: ProviderDiscoveryOptions = {}): readonly ProviderAvailability[] {
  const env = options.env ?? envReader(process.env);
  const userEnv = options.userEnv;
  const files = options.files;
  const vaultNames = options.vaultNames;

  return routes.map((route) => {
    const requiredEnvVarNames = requiredEnvNamesForRoute(route);
    const presentEnvVarNames = requiredEnvVarNames.filter((name) => env.has(name) || (userEnv?.has(name) ?? false) || (vaultNames?.has(name) ?? false));
    const missingEnvVarNames = requiredEnvVarNames.filter((name) => !presentEnvVarNames.includes(name));
    const status = availabilityStatusForRoute(route, missingEnvVarNames, files, options.routerHealth);

    return {
      providerId: route.providerId,
      modelId: route.modelId,
      routeId: route.routeId,
      routeType: route.routeType,
      status,
      requiredEnvVarNames,
      presentEnvVarNames,
      missingEnvVarNames,
      credentialSourceType: route.credentialSource.type,
      caveats: route.caveats,
      setupHints: setupHintsFor(route, missingEnvVarNames, status)
    };
  });
}

function availabilityStatusForRoute(route: ProviderRouteDescriptor, missingEnvVarNames: readonly string[], files: FilePresenceReader | undefined, routerHealth: RouterHealthReport | undefined): ProviderAvailabilityStatus {
  if (route.status === "excluded-by-policy" || route.routeType === "excluded") return "excluded-by-policy";
  if (route.status === "pending-quota") return "pending-quota";
  if (route.status === "works-with-caveat") return missingEnvVarNames.length > 0 ? "missing-key" : "works-with-caveat";
  if (route.status === "delegated" || route.routeType === "native-cli" || route.routeType === "delegated") return "delegated";
  if (route.routeType === "router-bridge" && routerHealth?.status !== "online") return "router-offline";

  if (route.credentialSource.type === "none") return route.status === "active" ? "active" : "ready-unverified";
  if (route.credentialSource.type === "env-var" || route.credentialSource.type === "windows-user-env" || route.credentialSource.type === "router-key") {
    return missingEnvVarNames.length > 0 ? "missing-key" : route.status === "active" ? "active" : "ready-unverified";
  }

  if (route.credentialSource.type === "auth-file" || route.credentialSource.type === "oauth-cache") {
    const filePath = route.credentialSource.filePath;
    if (!filePath || filePath.startsWith("<")) return "needs-login";
    return files?.exists(filePath) ? "ready-unverified" : "needs-login";
  }

  if (route.credentialSource.type === "adc") {
    return missingEnvVarNames.length === requiredEnvNamesForRoute(route).length ? "needs-login" : "ready-unverified";
  }

  if (route.credentialSource.type === "native-cli-token" || route.credentialSource.type === "command-helper") {
    return "needs-login";
  }

  return statusToAvailability(route.status);
}

function statusToAvailability(status: RouteStatus): ProviderAvailabilityStatus {
  if (status === "active") return "active";
  if (status === "pending-quota") return "pending-quota";
  if (status === "works-with-caveat") return "works-with-caveat";
  if (status === "delegated") return "delegated";
  if (status === "excluded-by-policy") return "excluded-by-policy";
  if (status === "needs-login") return "needs-login";
  if (status === "router-offline") return "router-offline";
  return "ready-unverified";
}

function requiredEnvNamesForRoute(route: ProviderRouteDescriptor): readonly string[] {
  return [...new Set([...(route.credentialSource.envVarName ? [route.credentialSource.envVarName] : []), ...route.credentialSource.envVarNames])].sort();
}

function setupHintsFor(route: ProviderRouteDescriptor, missingEnvVarNames: readonly string[], status: ProviderAvailabilityStatus): readonly string[] {
  if (status === "missing-key") return [`Set required env var name(s): ${missingEnvVarNames.join(", ")}.`];
  if (status === "needs-login") return [`Complete login or credential presence for ${route.providerId}; values must stay outside logs.`];
  if (status === "router-offline") return ["Start or repair LiteLLM router before selecting router bridge aliases."];
  if (status === "excluded-by-policy") return [route.exclusionReason ?? "Route is excluded by policy."];
  return [];
}

function envReader(env: NodeJS.ProcessEnv): EnvironmentNameReader {
  return { has: (name) => typeof env[name] === "string" && (env[name]?.length ?? 0) > 0 };
}
