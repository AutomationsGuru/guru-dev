/**
 * Crush-inspired provider/model browser (Dev 4 / D4.2).
 *
 * Maps Dev 2's `ProviderRouteDescriptor` (src/providers/schemas.ts) into the frozen
 * TUI view-model `TuiProviderEntry`, renders the picker + readiness panels, and
 * provides a secret-safe env-presence scan for auto-lighting (crush §1.4).
 *
 * Pure: no I/O. The host passes routes + an optional env snapshot; the mapper never
 * reads process.env directly and never stores credential values.
 */

import type { ProviderRouteDescriptor, RouteStatus, CredentialSourceType } from "../providers/schemas.js";
import type {
  TuiCapability,
  TuiCredentialSourceType,
  TuiModelEntry,
  TuiProviderEntry,
  TuiProviderGroup
} from "./schemas.js";
import { directFirstRank } from "./state.js";
import { type AnsiTheme, STATUS_COLOR, colorize, dim } from "./ansi.js";

/** Dev 2 route status → frozen TUI 9-value vocabulary (crush §1.3). */
const ROUTE_STATUS_TO_TUI: Record<RouteStatus, TuiProviderEntry["status"]> = {
  active: "active",
  guarded: "active",
  "ready-unverified": "ready-unverified",
  "missing-credential": "missing-key",
  "needs-login": "needs-login",
  "router-offline": "router-offline",
  "pending-quota": "pending-quota",
  "works-with-caveat": "works-with-caveat",
  untested: "ready-unverified",
  failing: "works-with-caveat",
  delegated: "delegated",
  deferred: "works-with-caveat",
  "excluded-by-policy": "excluded-by-policy"
};

const STATUS_RANK: Record<TuiProviderEntry["status"], number> = {
  active: 0,
  "ready-unverified": 1,
  delegated: 2,
  "works-with-caveat": 3,
  "pending-quota": 4,
  "needs-login": 5,
  "missing-key": 6,
  "router-offline": 7,
  "excluded-by-policy": 8
};

/** crush §4 display order: direct/oauth → router → provider-cli → local → mcp → api-key. */
const GROUP_RANK: Record<TuiProviderGroup, number> = {
  direct: 0,
  oauth: 1,
  router: 2,
  "provider-cli": 3,
  local: 4,
  mcp: 5,
  "api-key": 6
};

/** crush §1.5: one safe next action (names only) for non-selectable providers. */
function deriveSetupHint(status: TuiProviderEntry["status"], requiredEnvNames: readonly string[]): string | undefined {
  switch (status) {
    case "missing-key":
      return `set required env var(s): ${requiredEnvNames.join(", ") || "(none named)"}`;
    case "needs-login":
      return "run provider login";
    case "router-offline":
      return "direct-api route or start LiteLLM for bridge (ctrl+k)";
    default:
      return undefined;
  }
}

const CRED_TYPE_TO_TUI: Record<CredentialSourceType, TuiCredentialSourceType> = {
  "env-var": "process-env",
  "windows-user-env": "user-env",
  "auth-file": "auth-file",
  "oauth-cache": "oauth-cache",
  "guru-oauth": "oauth-cache",
  "native-cli-token": "auth-file",
  adc: "adc",
  "command-helper": "none",
  "router-key": "router",
  none: "none"
};

export interface MapRoutesOptions {
  readonly lastCheckedAt: string;
  /** Optional env snapshot to compute presence (auto-lighting). Values never stored. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface ProviderAcc {
  readonly providerId: string;
  displayName: string;
  group: TuiProviderGroup;
  statusRank: number;
  required: Set<string>;
  credTypes: Set<TuiCredentialSourceType>;
  docs: Set<string>;
  setupHint: string | undefined;
  models: TuiModelEntry[];
}

function routeCapabilities(route: ProviderRouteDescriptor): TuiCapability[] {
  const caps: TuiCapability[] = ["text"];
  const c = route.capabilities;
  if (c.supportsVision || c.inputModalities.includes("image")) {
    caps.push("vision");
  }
  if (c.supportsTools) {
    caps.push("tools");
  }
  if (c.supportsWebSearch) {
    caps.push("web");
  }
  if (c.supportsReasoning) {
    caps.push("reasoning");
  }
  if ((route.context.contextWindowTokens ?? 0) >= 128000) {
    caps.push("long-context");
  }
  switch (route.routeType) {
    case "direct-api":
      caps.push("direct");
      break;
    case "operator-provider-plan-auth":
    case "native-cli":
      caps.push("oauth");
      break;
    case "router-bridge":
      caps.push("router");
      break;
    default:
      break;
  }
  const credType = route.credentialSource.type;
  if (credType === "env-var" || credType === "windows-user-env" || credType === "router-key") {
    caps.push("api-key");
  }
  if (route.apiFamily === "ollama-openai-compatible") {
    caps.push("local");
  }
  return [...new Set(caps)];
}

function routeGroup(route: ProviderRouteDescriptor): TuiProviderGroup {
  switch (route.routeType) {
    case "router-bridge":
      return "router";
    case "operator-provider-plan-auth":
      return "oauth";
    case "native-cli":
    case "delegated":
      return "provider-cli";
    default:
      if (route.apiFamily === "ollama-openai-compatible") {
        return "local";
      }
      return "direct";
  }
}

function routeEnvNames(route: ProviderRouteDescriptor): string[] {
  const source = route.credentialSource;
  return [source.envVarName, ...source.envVarNames].filter(
    (name): name is string => typeof name === "string" && name.length > 0
  );
}

/** Names-only presence scan (crush §3.2): returns the subset present in env. Never stores values. */
export function scanEnvPresence(
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>>
): string[] {
  return names.filter((name) => {
    const value = env[name];
    return typeof value === "string" && value.length > 0;
  });
}

/**
 * Map flat route descriptors into grouped TUI provider entries (providers first,
 * models nested). Routes under one providerId collapse into a single row.
 */
export function mapRoutesToProviders(
  routes: readonly ProviderRouteDescriptor[],
  options: MapRoutesOptions
): TuiProviderEntry[] {
  const acc = new Map<string, ProviderAcc>();

  for (const route of routes) {
    const existing = acc.get(route.providerId);
    const entry = existing ?? {
      providerId: route.providerId,
      displayName: route.displayName ?? route.providerId,
      group: routeGroup(route),
      statusRank: STATUS_RANK["excluded-by-policy"],
      required: new Set<string>(),
      credTypes: new Set<TuiCredentialSourceType>(),
      docs: new Set<string>(),
      setupHint: route.exclusionReason,
      models: []
    };
    if (existing === undefined) {
      acc.set(route.providerId, entry);
    }

    const tuiStatus = ROUTE_STATUS_TO_TUI[route.status];
    entry.statusRank = Math.min(entry.statusRank, STATUS_RANK[tuiStatus]);

    const caveats = [...route.caveats];
    if (route.status === "failing") {
      caveats.push("last smoke failed");
    }
    if (route.status === "deferred") {
      caveats.push("deferred");
    }

    const aliasesRaw = route.metadata?.router_aliases;
    const aliases = Array.isArray(aliasesRaw) ? aliasesRaw.filter((x): x is string => typeof x === "string") : [];

    const limits =
      route.context.contextWindowTokens !== undefined || route.context.maxOutputTokens !== undefined
        ? {
            ...(route.context.contextWindowTokens !== undefined
              ? { contextWindow: route.context.contextWindowTokens }
              : {}),
            ...(route.context.maxOutputTokens !== undefined
              ? { maxOutputTokens: route.context.maxOutputTokens }
              : {})
          }
        : undefined;

    const cost =
      route.cost.inputPerMillionTokens !== undefined || route.cost.outputPerMillionTokens !== undefined
        ? {
            lane: route.cost.currency,
            ...(route.cost.inputPerMillionTokens !== undefined
              ? { inputPerMillionUsd: route.cost.inputPerMillionTokens }
              : {}),
            ...(route.cost.outputPerMillionTokens !== undefined
              ? { outputPerMillionUsd: route.cost.outputPerMillionTokens }
              : {})
          }
        : undefined;

    const model: TuiModelEntry = {
      modelId: route.modelId,
      label: route.displayName ?? route.modelId,
      aliases,
      routeType: route.routeType,
      capabilities: routeCapabilities(route),
      ...(limits !== undefined ? { limits } : {}),
      ...(cost !== undefined ? { cost } : {}),
      status: tuiStatus,
      caveats,
      ...(route.status === "failing"
        ? { verificationMarker: "failing" }
        : route.status === "excluded-by-policy" || route.routeType === "excluded"
          ? { verificationMarker: "excluded" }
          : {})
    };
    entry.models.push(model);

    for (const name of routeEnvNames(route)) {
      entry.required.add(name);
    }
    entry.credTypes.add(CRED_TYPE_TO_TUI[route.credentialSource.type]);
  }

  return [...acc.values()]
    .map((entry) => {
      const requiredEnvNames = [...entry.required];
      const presentEnvNames = options.env !== undefined ? scanEnvPresence(requiredEnvNames, options.env) : [];
      const status = bestStatus(entry.statusRank);
      const setupHint = entry.setupHint ?? deriveSetupHint(status, requiredEnvNames);
      return {
        providerId: entry.providerId,
        displayName: entry.displayName,
        group: entry.group,
        status,
        requiredEnvNames,
        presentEnvNames,
        credentialSourceTypes: [...entry.credTypes],
        models: entry.models,
        docs: [...entry.docs],
        ...(setupHint !== undefined ? { safeSetupHint: setupHint } : {}),
        lastCheckedAt: options.lastCheckedAt
      } satisfies TuiProviderEntry;
    })
    .sort((a, b) => GROUP_RANK[a.group] - GROUP_RANK[b.group] || a.displayName.localeCompare(b.displayName));
}

function bestStatus(rank: number): TuiProviderEntry["status"] {
  const entries = Object.entries(STATUS_RANK) as Array<[TuiProviderEntry["status"], number]>;
  let best: TuiProviderEntry["status"] = "excluded-by-policy";
  let bestRank = Number.POSITIVE_INFINITY;
  for (const [status, statusRank] of entries) {
    if (statusRank === rank && statusRank < bestRank) {
      best = status;
      bestRank = statusRank;
    }
  }
  return best;
}

export interface ReadinessSummary {
  readonly active: number;
  readonly readyUnverified: number;
  readonly missingOrLogin: number;
  readonly caveatedOrOffline: number;
  readonly excluded: number;
  readonly totalModels: number;
}

export function summarizeReadiness(providers: readonly TuiProviderEntry[]): ReadinessSummary {
  const summary = { active: 0, readyUnverified: 0, missingOrLogin: 0, caveatedOrOffline: 0, excluded: 0, totalModels: 0 };
  for (const provider of providers) {
    for (const model of provider.models) {
      summary.totalModels += 1;
      switch (model.status) {
        case "active":
          summary.active += 1;
          break;
        case "ready-unverified":
          summary.readyUnverified += 1;
          break;
        case "missing-key":
        case "needs-login":
          summary.missingOrLogin += 1;
          break;
        case "router-offline":
        case "pending-quota":
        case "works-with-caveat":
        case "delegated":
          summary.caveatedOrOffline += 1;
          break;
        case "excluded-by-policy":
          summary.excluded += 1;
          break;
        default:
          break;
      }
    }
  }
  return summary;
}

/** Render the provider/model picker as lines (crush §2.2). */
export function renderProviderPicker(providers: readonly TuiProviderEntry[], theme: AnsiTheme): string[] {
  const lines: string[] = ["Providers"];
  if (providers.length === 0) {
    lines.push(dim(theme, "  (no routes discovered yet)"));
    return lines;
  }
  for (const provider of providers) {
    const statusColor = STATUS_COLOR[provider.status] ?? "default";
    const present = provider.presentEnvNames.length;
    const required = provider.requiredEnvNames.length;
    const ready = present > 0 || provider.status === "active";
    const marker = ready ? "●" : "○";
    lines.push(`  ${colorize(theme, statusColor, marker)} ${provider.displayName} [${provider.group}]`);
    lines.push(dim(theme, `     ${required} required credential name(s), ${present} present · ${provider.models.length} model(s)`));
    for (const model of [...provider.models].sort((a, b) => directFirstRank(a.routeType) - directFirstRank(b.routeType))) {
      const badges = model.capabilities.join(",");
      const limits = model.limits?.contextWindow !== undefined ? ` · ${Math.round(model.limits.contextWindow / 1000)}k ctx` : "";
      lines.push(`     - ${model.label} (${model.routeType}) [${badges}]${limits}`);
    }
  }
  return lines;
}

/** Render the startup readiness summary (crush §2.1). */
export function renderReadinessSummary(summary: ReadinessSummary, theme: AnsiTheme): string[] {
  return [
    "Readiness",
    `  ${colorize(theme, "green", String(summary.active))} active · ${colorize(theme, "cyan", String(summary.readyUnverified))} ready-unverified`,
    `  ${colorize(theme, "yellow", String(summary.missingOrLogin))} missing/login · ${colorize(theme, "yellow", String(summary.caveatedOrOffline))} caveated/offline`,
    `  ${colorize(theme, "red", String(summary.excluded))} excluded · ${summary.totalModels} total model(s)`
  ];
}
