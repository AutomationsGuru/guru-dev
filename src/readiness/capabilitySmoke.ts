import { getRuntimeInfo } from "../index.js";
import { loadHarnessConfig } from "../config/loadConfig.js";
import type { HonchoMemoryConfig } from "../config/schema.js";
import { createHarnessRuntime, type HarnessRuntime } from "../runtime/session.js";
import { HonchoConfigSchema, type HonchoStatus } from "../honcho/schemas.js";
import { createHonchoClient } from "../honcho/client.js";
import { defineProviderRoute } from "../providers/registry.js";
import type { ProviderRouteDescriptor } from "../providers/schemas.js";
import { createDirectProviderCatalog } from "../providers/catalog.js";
import { scanProviderReadiness, type ProviderAvailability } from "../providers/discovery.js";
import { planRoute } from "../providers/routePlanner.js";
import { getToolParityVerdictCounts } from "../tools/toolParity.js";
import type { ToolObservation, ToolDefinition } from "../tools/registry.js";
import { createExtensionHost } from "../extensions/host.js";
import { LifecycleEvents } from "../extensions/events.js";
import { createHonchoTools } from "../tools/builtins/honchoTools.js";
import { createReadinessTools } from "../readiness/commands.js";
import { DEFAULT_PROVIDER_CLI_CONFIGS } from "../provider-cli/status.js";
import { MemoryStoreStatusSchema, type MemoryStoreStatus } from "../memory/schemas.js";

/**
 * capability-smoke
 *
 * A single-run proof that the GuruHarness nucleus can do the core things a capable agent harness does:
 * load config, resolve repo/AGENTS context, expose a built-in tool inventory,
 * run one safe read-only tool, report Honcho readiness from a real client, report a
 * direct-first provider route shape, probe the extension-host spine (now hosting the
 * real Honcho status + service-readiness tools), surface the provider-CLI inventory,
 * and emit a structured completion block.
 *
 * This is intentionally a small, inspectable nucleus proof — not the full runtime.
 * It composes existing modules and never prints secret values (env NAMES only).
 */

const READ_ONLY_TOOL_ID = "repo.context.resolve";
const HANDOFF_DOC_PATH = "D:\\.projects\\guruharness\\handoffs\\controller-builder-document-handoff.md";

export type SmokeVerdict = "GREEN" | "YELLOW" | "RED";

export interface CapabilitySmokeOptions {
  readonly configPath?: string;
  readonly cwd?: string;
  readonly targetPath?: string;
  /** Construct the runtime owned by this bounded smoke invocation. */
  readonly runtimeFactory?: () => HarnessRuntime;
}

export interface CapabilitySmokeCompletionBlock {
  readonly status: string;
  readonly complete: string;
  readonly tasks: readonly string[];
  readonly followUps: readonly string[];
  readonly doc: string;
  readonly secrets: string;
  readonly constraints: string;
  readonly recap: string;
  readonly next: string;
  readonly handoffNeeded: string;
}

export interface PiEquivalentRouteSummary {
  readonly routeId: string;
  readonly routeType: string;
  readonly status: string;
  readonly availability: string;
  readonly missingEnvVarNames: readonly string[];
  readonly directFirstRank: number;
  readonly allowedRouterFallback: boolean;
}

export interface ExtensionHostProbe {
  readonly available: boolean;
  readonly startedThenStopped: boolean;
  readonly commandsRegistered: number;
  readonly toolFactoriesRegistered: number;
  readonly routesRegistered: number;
  readonly eventRoundTrip: boolean;
  readonly registeredCommandIds: readonly string[];
  readonly registeredToolIds: readonly string[];
  readonly honchoStatusToolReachable: boolean;
  readonly honchoToolStatus: string;
  readonly summary: string;
}

export interface ProviderCliSummary {
  readonly configuredCount: number;
  readonly ids: readonly string[];
  readonly note: string;
}

export interface CapabilitySmokeReport {
  readonly command: "capability-smoke";
  readonly generatedAt: string;
  readonly verdict: SmokeVerdict;
  readonly summary: string;
  readonly runtime: { readonly name: string; readonly version: string; readonly capability: string };
  readonly config: { readonly status: string; readonly verdict: string; readonly path: string; readonly diagnostics: readonly string[] };
  readonly repo: {
    readonly resolved: boolean;
    readonly repoRoot: string | null;
    readonly targetPath: string | null;
    readonly agentsChainCount: number;
    readonly agentsChainRelativePaths: readonly string[];
    readonly gitStatusSummary: string;
    readonly gitStatus: string;
  };
  readonly tools: { readonly count: number; readonly ids: readonly string[] };
  readonly readOnlyToolRun: ToolObservation;
  readonly memory: MemoryStoreStatus;
  readonly honcho: HonchoStatus;
  readonly providerRouting: {
    readonly routeCount: number;
    readonly catalogSource: "direct-provider-catalog" | "seed-fallback";
    readonly selectedRouteId: string | null;
    readonly selectedRouteType: string | null;
    readonly selectedRouteStatus: string | null;
    readonly selectionKind: string | null;
    readonly policyReason: string;
    readonly directFirstRank: number | null;
    readonly availabilitySummary: Readonly<Record<string, number>>;
    readonly routes: readonly PiEquivalentRouteSummary[];
  };
  readonly providerCli: ProviderCliSummary;
  readonly extensionHost: ExtensionHostProbe;
  readonly toolParity: Readonly<Record<"GREEN" | "YELLOW" | "RED", number>>;
  readonly sessionStatus: string;
  readonly sessionBlockers: readonly string[];
  readonly completionBlock: CapabilitySmokeCompletionBlock;
}

export async function runCapabilitySmoke(options: CapabilitySmokeOptions = {}): Promise<CapabilitySmokeReport> {
  const generatedAt = new Date().toISOString();
  const cwd = options.cwd ?? process.cwd();
  const runtimeInfo = getRuntimeInfo();

  const configResult = loadHarnessConfig({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    cwd
  });

  const runtime = options.runtimeFactory?.() ?? createHarnessRuntime();
  try {
    const session = await runtime.startSession({
      ...(options.configPath ? { configPath: options.configPath } : {}),
      cwd,
      ...(options.targetPath ? { targetPath: options.targetPath } : {})
    });

  const toolIds = session.tools.map((tool) => tool.id);
  const repo = session.repo;
  const agentsChainRelativePaths = repo ? repo.agentsChain.map((agentsFile) => agentsFile.relativePath) : [];

  const readOnlyToolRun = await runtime.executeTool(session.id, READ_ONLY_TOOL_ID, { cwd });
  const memoryStatusRun = await runtime.executeTool(session.id, "memory_status", {});
  const memory =
    memoryStatusRun.status === "succeeded"
      ? MemoryStoreStatusSchema.parse(memoryStatusRun.output)
      : MemoryStoreStatusSchema.parse({
          provider: configResult.config.memory.storage.provider,
          status: "error",
          summary: "Memory status tool could not run.",
          missingEnvNames: [],
          location: "unavailable"
        });
  const honcho = await resolveHonchoReadiness(configResult.config.memory.honcho);

  // Real direct-first routing: the folded provider catalog + env-name readiness scan +
  // route planner. The seed route remains only as a fallback for an empty catalog.
  const catalog = createDirectProviderCatalog();
  const catalogSource = catalog.length > 0 ? ("direct-provider-catalog" as const) : ("seed-fallback" as const);
  const routes = catalog.length > 0 ? catalog : [buildSeedDirectFirstRoute()];
  const availability = scanProviderReadiness(routes);
  const availabilityByRouteId = new Map(availability.map((row) => [row.routeId, row]));
  const routePlan = planRoute({}, routes);
  const selectedRoute = routePlan.verdict === "selected" ? routePlan.choice ?? null : null;
  const availabilitySummary = summarizeAvailability(availability);

  const providerCli: ProviderCliSummary = {
    configuredCount: DEFAULT_PROVIDER_CLI_CONFIGS.length,
    ids: DEFAULT_PROVIDER_CLI_CONFIGS.map((config) => config.id),
    note: "Provider-CLI status runtime is folded in; live version probing + the full readiness report are reachable via the registered service_readiness_report tool. The smoke lists the configured inventory only (no subprocess spawning)."
  };

  const extensionHost = await probeExtensionHost();

  const criticalFailures: string[] = [];
  if (configResult.verdict === "RED") {
    criticalFailures.push("config load returned RED");
  }
  if (!repo) {
    criticalFailures.push("repository/AGENTS context could not be resolved");
  }
  if (readOnlyToolRun.status !== "succeeded") {
    criticalFailures.push(`read-only tool ${READ_ONLY_TOOL_ID} did not succeed`);
  }
  if (memoryStatusRun.status !== "succeeded") {
    criticalFailures.push("memory status tool did not succeed");
  }
  if (session.status !== "ready") {
    criticalFailures.push(`harness session status is ${session.status}`);
  }
  if (!extensionHost.available) {
    criticalFailures.push("extension-host spine is unavailable");
  }

  const degradations: string[] = [];
  if (configResult.verdict === "YELLOW") {
    degradations.push("config using safe defaults (YELLOW)");
  }
  if (memory.status !== "ready") {
    degradations.push(`Memory storage readiness is ${memory.status}.`);
  }
  if (configResult.config.memory.honcho.enabled && honcho.status !== "ready") {
    degradations.push(`Configured Honcho readiness is ${honcho.status}.`);
  }
  if (!selectedRoute) {
    degradations.push(`route planner could not select a route: ${routePlan.policyReason}`);
  } else if ((availability.filter((row) => row.status === "active").length) === 0) {
    degradations.push("no provider route is verified active yet (env-name presence only; live verification pending)");
  }

  const verdict: SmokeVerdict = criticalFailures.length > 0 ? "RED" : degradations.length > 0 ? "YELLOW" : "GREEN";
  const summary = `GuruHarness ${runtimeInfo.version} capability nucleus ${
    verdict === "RED" ? "failed a core probe" : "is runnable"
  }: config ${configResult.verdict}, ${agentsChainRelativePaths.length} AGENTS.md in chain, ${toolIds.length} built-in tools, read-only tool ${readOnlyToolRun.status}, memory ${memory.provider}/${memory.status}, Honcho ${honcho.status}, ${routes.length} catalog route(s) (${catalogSource}), ${providerCli.configuredCount} provider-CLIs configured, extension-host ${
    extensionHost.available ? "hosting real tools" : "unavailable"
  } (Honcho status tool ${extensionHost.honchoStatusToolReachable ? "reachable" : "absent"}).`;

  const followUps = [...criticalFailures, ...degradations];

  const completionBlock: CapabilitySmokeCompletionBlock = {
    status: `${verdict} — capability nucleus ${verdict === "RED" ? "failed core probes" : "runnable"}`,
    complete: `Ran capability-smoke: config load, repo/AGENTS context, ${toolIds.length} built-in tools, one read-only tool execution, configured memory status, Honcho readiness, direct-first route shape, provider-CLI inventory, extension-host hosting Honcho+readiness tools, completion block.`,
    tasks: [
      `config load -> ${configResult.verdict} (${configResult.status})`,
      `repo/AGENTS context -> ${repo ? `${agentsChainRelativePaths.length} AGENTS.md in chain` : "unresolved"}`,
      `built-in tools -> ${toolIds.length} registered`,
      `read-only tool ${READ_ONLY_TOOL_ID} -> ${readOnlyToolRun.status}`,
      `memory storage -> ${memory.provider}/${memory.status}`,
      `Honcho readiness -> ${honcho.status}`,
      `direct-first route -> ${
        selectedRoute
          ? `${selectedRoute.routeId} (${routePlan.choiceKind ?? "direct"}; ${selectedRoute.status}) from ${routes.length}-route catalog`
          : `none (${routePlan.policyReason})`
      }`,
      `provider-CLI inventory -> ${providerCli.configuredCount} configured`,
      `extension-host -> ${
        extensionHost.available
          ? `hosting ${extensionHost.registeredToolIds.length} tool(s); Honcho status tool -> ${extensionHost.honchoToolStatus}; service_readiness_report registered=${extensionHost.registeredToolIds.includes("service_readiness_report")}`
          : "unavailable"
      }`,
      "completion block -> produced"
    ],
    followUps: followUps.length > 0 ? followUps : ["none"],
    doc: HANDOFF_DOC_PATH,
    secrets: "none — env variable NAMES only, no values printed",
    constraints: "read-only tool execution; extends existing modules; provider-CLI live probing available via tool but not spawned in the smoke; no MCP/sidecar/self-improvement in this slice",
    recap: `One CLI command proves the core capability nucleus is runnable: extension host live with real tools, honest optional-Honcho readiness from the configured client, provider-CLI runtime folded, and direct-first routing now selects from the real ${routes.length}-route provider catalog with env-name availability scanning.`,
    next:
      verdict === "RED"
        ? "Resolve the failed core probe(s) before proceeding."
        : "Controller review; then wire a first real end-to-end agent turn over the selected direct-first route.",
    handoffNeeded: "yes — Controller to confirm this slice and select the next fold-in target"
  };

    return {
      command: "capability-smoke",
      generatedAt,
      verdict,
      summary,
      runtime: runtimeInfo,
      config: {
        status: configResult.status,
        verdict: configResult.verdict,
        path: configResult.path,
        diagnostics: [...configResult.diagnostics]
      },
      repo: {
        resolved: repo !== null,
        repoRoot: repo ? repo.repoRoot : null,
        targetPath: repo ? repo.targetPath : null,
        agentsChainCount: agentsChainRelativePaths.length,
        agentsChainRelativePaths,
        gitStatusSummary: repo ? summarizeGitStatus(repo.gitStatus) : "repository context unavailable",
        gitStatus: repo ? repo.gitStatus : "repository context unavailable"
      },
      tools: { count: toolIds.length, ids: toolIds },
      readOnlyToolRun,
      memory,
      honcho,
      providerRouting: {
        routeCount: routes.length,
        catalogSource,
        selectedRouteId: selectedRoute ? selectedRoute.routeId : null,
        selectedRouteType: selectedRoute ? selectedRoute.routeType : null,
        selectedRouteStatus: selectedRoute ? selectedRoute.status : null,
        selectionKind: routePlan.choiceKind ?? null,
        policyReason: routePlan.policyReason,
        directFirstRank: selectedRoute ? selectedRoute.directFirstRank : null,
        availabilitySummary,
        routes: routes.map((route) => ({
          routeId: route.routeId,
          routeType: route.routeType,
          status: route.status,
          availability: availabilityByRouteId.get(route.routeId)?.status ?? "unknown",
          missingEnvVarNames: availabilityByRouteId.get(route.routeId)?.missingEnvVarNames ?? [],
          directFirstRank: route.directFirstRank,
          allowedRouterFallback: route.allowedRouterFallback
        }))
      },
      providerCli,
      extensionHost,
      toolParity: getToolParityVerdictCounts(),
      sessionStatus: session.status,
      sessionBlockers: [...session.blockers],
      completionBlock
    };
  } finally {
    await runtime.close();
  }
}

async function resolveHonchoReadiness(config: HonchoMemoryConfig): Promise<HonchoStatus> {
  return createHonchoClient({
    config: HonchoConfigSchema.parse({
      enabled: config.enabled,
      apiKeyEnvVar: config.apiKeyEnvVar,
      workspaceId: config.workspaceId,
      sessionId: config.sessionId,
      userPeerId: config.userPeerId,
      agentPeerId: config.agentPeerId,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      timeoutMs: config.timeoutMs,
      writeEnabled: config.enabled
    })
  }).status();
}

function buildSeedDirectFirstRoute(): ProviderRouteDescriptor {
  return defineProviderRoute({
    providerId: "guruharness-seed",
    modelId: "seed-planner-model",
    routeId: "guruharness/seed-direct-first",
    displayName: "Seed direct-first planner route",
    routeType: "direct-api",
    apiFamily: "openai-chat-completions",
    credentialSource: { type: "env-var", envVarName: "GURUHARNESS_SEED_API_KEY", envVarNames: [] },
    status: "ready-unverified",
    caveats: ["Seed route: replace with real direct-first provider routes in the Wave 2 routing lane."],
    directFirstRank: 0,
    allowedRouterFallback: true,
    metadata: { source: "capability-smoke", seed: true }
  });
}

/**
 * Probe the extension-host spine and confirm it can HOST real capabilities: register a
 * demo extension that wires the folded Honcho tools + service-readiness tool + a command,
 * route, and lifecycle listener; start the host; execute the Honcho status tool through
 * the host's registered factories; then stop it. Read-only; nothing is wired into the
 * live runtime and no secret values are read.
 */
async function probeExtensionHost(): Promise<ExtensionHostProbe> {
  try {
    const host = createExtensionHost();
    let eventRoundTrip = false;

    host.registerExtension((api) => {
      api.on(LifecycleEvents.SESSION_START, () => {
        eventRoundTrip = true;
      });
      api.registerCommand("smoke.demo", () => {}, {
        description: "Demo command registered by the capability-smoke extension probe."
      });
      api.registerTool({ factory: () => createHonchoTools() });
      api.registerTool({ factory: () => createReadinessTools({}) });
      api.registerRoute("GET", "/smoke/demo", async () => ({ ok: true }));
    });

    host.start();

    const commandsRegistered = host.getCommandRegistry().size;
    const registeredCommandIds = [...host.getCommandRegistry().keys()];
    const toolFactories = host.getToolFactories();
    const routesRegistered = host.getRouteRegistry().length;

    const registeredToolDefs: ToolDefinition[] = toolFactories.flatMap((factory) => [...factory.factory()]);
    const registeredToolIds = registeredToolDefs.map((tool) => tool.id);
    const honchoStatusTool = registeredToolDefs.find((tool) => tool.id === "honcho_memory_status");
    const honchoStatusToolReachable = honchoStatusTool !== undefined;

    let honchoToolStatus = "unavailable";
    if (honchoStatusTool) {
      const output = (await honchoStatusTool.execute({}, {})) as { status?: string };
      honchoToolStatus = output.status ?? "unknown";
    }

    host.stop();

    const available = commandsRegistered > 0 && eventRoundTrip && honchoStatusToolReachable;

    return {
      available,
      startedThenStopped: true,
      commandsRegistered,
      toolFactoriesRegistered: toolFactories.length,
      routesRegistered,
      eventRoundTrip,
      registeredCommandIds,
      registeredToolIds,
      honchoStatusToolReachable,
      honchoToolStatus,
      summary: available
        ? "Extension-host spine hosts real registered tools: Honcho status + service readiness report are reachable through the host, with lifecycle events dispatching."
        : "Extension-host spine present but did not register/dispatch/host tools as expected."
    };
  } catch (error) {
    return {
      available: false,
      startedThenStopped: false,
      commandsRegistered: 0,
      toolFactoriesRegistered: 0,
      routesRegistered: 0,
      eventRoundTrip: false,
      registeredCommandIds: [],
      registeredToolIds: [],
      honchoStatusToolReachable: false,
      honchoToolStatus: "unavailable",
      summary: `Extension-host spine unavailable: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function summarizeAvailability(rows: readonly ProviderAvailability[]): Readonly<Record<string, number>> {
  return rows.reduce<Record<string, number>>((counts, row) => {
    counts[row.status] = (counts[row.status] ?? 0) + 1;

    return counts;
  }, {});
}

function summarizeGitStatus(gitStatus: string): string {
  const lines = gitStatus.split(/\r?\n/u).filter((line) => line.length > 0);
  const branchLine = lines.find((line) => line.startsWith("##"));
  const changeCount = lines.filter((line) => !line.startsWith("##")).length;
  const branchSummary = branchLine ? branchLine.replace(/^##\s*/u, "branch ") : "branch (unknown)";

  return `${branchSummary} — ${changeCount} change(s)`;
}
