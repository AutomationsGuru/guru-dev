import type { ToolDefinition } from "../tools/registry.js";
import { createExtensionHost, type ExtensionHost } from "./host.js";
import { createHonchoTools } from "../tools/builtins/honchoTools.js";
import { createReadinessTools } from "../readiness/commands.js";
import { createInMemoryHonchoClient } from "../honcho/client.js";
import { HonchoConfigSchema } from "../honcho/schemas.js";
import { createFileMemoryStore, type FileMemoryStore } from "../memory/store.js";
import { createMemoryTools } from "../memory/tools.js";
import { getSharedSwarmManager, type SwarmManager } from "../swarm/manager.js";
import { createSwarmTools } from "../swarm/tools.js";
import { createResolverTools } from "../selfbuild/resolverTool.js";
import { createTodoTools } from "../tools/builtins/todoTools.js";
import { createWebFetchTools } from "../tools/builtins/webFetchTool.js";
import { createWebSearchTools } from "../tools/builtins/webSearchTool.js";
import { createAskQuestionTools } from "../tools/builtins/askQuestionTool.js";
import { createMcpStatusTools } from "../tools/builtins/mcpStatusTool.js";
import { createProviderCliTools } from "../tools/builtins/providerCliTools.js";
import type { SwarmConfig } from "../swarm/schema.js";

/** Env var NAMES (never values) the Honcho runtime requires. */
const HONCHO_REQUIRED_ENV_NAMES = ["HONCHO_API_KEY"] as const;

export interface HarnessExtensions {
  readonly host: ExtensionHost;
  readonly tools: readonly ToolDefinition[];
  readonly memoryStore: FileMemoryStore;
  readonly swarm: SwarmManager;
}

export interface InitExtensionsOptions {
  /** Memory directory override (tests). Defaults to ~/.guruharness/memory. */
  readonly memoryDirectory?: string;
  readonly sessionId?: string;
  /** Swarm ceilings (from harness config); schema hard-caps apply regardless. */
  readonly swarmConfig?: Partial<SwarmConfig>;
}

/**
 * Build the live extension host: create the host, register the folded capability
 * tools (Honcho + service readiness) as extensions, start it, and collect the
 * contributed tool definitions so the runtime can expose them in real sessions.
 *
 * This is the wiring seam that makes the extension-centric design real — capabilities
 * flow into the session tool registry through the extension host rather than being
 * hardcoded. Env NAMES only; nothing here reads or prints secret values.
 */
export function initExtensions(options: InitExtensionsOptions = {}): HarnessExtensions {
  const host = createExtensionHost();
  const honchoClient = createInMemoryHonchoClient({
    config: HonchoConfigSchema.parse({
      workspaceId: "guruharness",
      writeEnabled: false,
      requiredEnvNames: [...HONCHO_REQUIRED_ENV_NAMES]
    })
  });
  const memoryStore = createFileMemoryStore({
    ...(options.memoryDirectory ? { directory: options.memoryDirectory } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {})
  });
  const swarm = getSharedSwarmManager(options.swarmConfig ?? {});

  host.registerExtension((api) => {
    api.registerTool({ factory: () => createHonchoTools({ client: honchoClient }) });
    api.registerTool({ factory: () => createReadinessTools({ honchoClient }) });
    // Memory organ (Foundation Wave PR 2) — self-registered, no api.ts change.
    api.registerTool({ factory: () => createMemoryTools({ store: memoryStore }) });
    // Swarm v1 (Phase F) — bounded contract per the 2026-07-04 swarm ADR.
    api.registerTool({ factory: () => createSwarmTools({ manager: swarm }) });
    // Never-stuck resolver (Phase G) — context late-bound by the live session.
    api.registerTool({ factory: () => createResolverTools() });
    // Session task board + bounded web fetch (harness baseline parity, 2026-07-10).
    api.registerTool({ factory: () => createTodoTools() });
    api.registerTool({ factory: () => createWebFetchTools() });
    api.registerTool({ factory: () => createWebSearchTools() });
    api.registerTool({ factory: () => createAskQuestionTools() });
    api.registerTool({ factory: () => createMcpStatusTools() });
    // Provider CLI status + dry-run-first delegated run (parity RED → GREEN, 2026-07-10).
    api.registerTool({ factory: () => createProviderCliTools() });
  });

  host.start();

  const tools = host.getToolFactories().flatMap((factory) => [...factory.factory()]);

  return { host, tools, memoryStore, swarm };
}

/** Collect the extension-contributed tool definitions for the session tool registry. */
export function collectExtensionTools(): readonly ToolDefinition[] {
  return initExtensions().tools;
}
