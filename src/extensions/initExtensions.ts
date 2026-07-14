import type { ToolDefinition } from "../tools/registry.js";
import { createExtensionHost, type ExtensionHost } from "./host.js";
import { createHonchoTools } from "../tools/builtins/honchoTools.js";
import { createReadinessTools } from "../readiness/commands.js";
import { createHonchoClient } from "../honcho/client.js";
import { HonchoConfigSchema } from "../honcho/schemas.js";
import { createFileMemoryStore } from "../memory/store.js";
import { createConfiguredMemoryStore, type MemoryFactStore } from "../memory/provider.js";
import { createMemoryTools } from "../memory/tools.js";
import { getSharedSwarmManager, type SwarmManager } from "../swarm/manager.js";
import { createSwarmTools } from "../swarm/tools.js";
import { createResolverTools } from "../selfbuild/resolverTool.js";
import { createTodoTools } from "../tools/builtins/todoTools.js";
import { createWebFetchTools } from "../tools/builtins/webFetchTool.js";
import { createWebSearchTools } from "../tools/builtins/webSearchTool.js";
import { createMcpStatusTools } from "../tools/builtins/mcpStatusTool.js";
import { createProviderCliTools } from "../tools/builtins/providerCliTools.js";
import { createDesktopTools } from "../tools/builtins/desktopTools.js";
import { registerShellHooks } from "./shellHooks.js";
import type { SwarmConfig } from "../swarm/schema.js";
import { MemoryConfigSchema, type MemoryConfig } from "../config/schema.js";

export interface HarnessExtensions {
  readonly host: ExtensionHost;
  readonly tools: readonly ToolDefinition[];
  readonly memoryStore: MemoryFactStore;
  readonly swarm: SwarmManager;
}

export interface InitExtensionsOptions {
  /** Memory directory override (tests). Defaults to ~/.guruharness/memory. */
  readonly memoryDirectory?: string;
  readonly sessionId?: string;
  /** Memory storage and Honcho options from guruharness.config.json. */
  readonly memoryConfig?: MemoryConfig;
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
let sharedHost: ExtensionHost | null = null;
let sharedTools: readonly ToolDefinition[] | null = null;
let sharedMemoryStore: MemoryFactStore | null = null;
let sharedSwarm: SwarmManager | null = null;
let sharedMemoryConfigSignature: string | null = null;

export function initExtensions(options: InitExtensionsOptions = {}): HarnessExtensions {
  const requestedMemoryConfig = options.memoryConfig ?? MemoryConfigSchema.parse({});
  // The store location is just as important as its provider configuration.
  // Without it, a test/project-specific home could inherit the first process
  // session's user-home memory store.
  const requestedSignature = JSON.stringify({
    memoryConfig: requestedMemoryConfig,
    memoryDirectory: options.memoryDirectory ?? null
  });
  // Extension tools are process-shared, but a caller that explicitly starts a
  // session with a different memory configuration must not inherit whichever
  // backend happened to initialize first. Config changes are startup/session
  // boundaries, so safely rebuild the host before wiring the new registry.
  if (sharedHost && requestedSignature !== sharedMemoryConfigSignature) {
    sharedHost.stop();
    void sharedMemoryStore?.close?.();
    sharedHost = null;
    sharedTools = null;
    sharedMemoryStore = null;
    sharedMemoryConfigSignature = null;
  }
  if (!sharedHost) {
    sharedHost = createExtensionHost();
    const memoryConfig = requestedMemoryConfig;
    sharedMemoryConfigSignature = JSON.stringify(memoryConfig);
    const honchoClient = createHonchoClient({
      config: HonchoConfigSchema.parse({
        enabled: memoryConfig.honcho.enabled,
        apiKeyEnvVar: memoryConfig.honcho.apiKeyEnvVar,
        workspaceId: memoryConfig.honcho.workspaceId,
        sessionId: memoryConfig.honcho.sessionId,
        userPeerId: memoryConfig.honcho.userPeerId,
        agentPeerId: memoryConfig.honcho.agentPeerId,
        ...(memoryConfig.honcho.baseUrl ? { baseUrl: memoryConfig.honcho.baseUrl } : {}),
        timeoutMs: memoryConfig.honcho.timeoutMs,
        writeEnabled: memoryConfig.honcho.enabled
      })
    });
    const markdownStore = createFileMemoryStore({
      ...(options.memoryDirectory ? { directory: options.memoryDirectory } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {})
    });
    sharedMemoryStore = createConfiguredMemoryStore(memoryConfig.storage, markdownStore, {
      ...(options.sessionId ? { sessionId: options.sessionId } : {})
    });
    sharedSwarm = getSharedSwarmManager(options.swarmConfig ?? {});

    sharedHost.registerExtension((api) => {
      api.registerTool({ factory: () => createHonchoTools({ client: honchoClient }) });
      api.registerTool({ factory: () => createReadinessTools({ honchoClient }) });
      api.registerTool({ factory: () => createMemoryTools({ store: sharedMemoryStore! }) });
      api.registerTool({ factory: () => createSwarmTools({ manager: sharedSwarm! }) });
      api.registerTool({ factory: () => createResolverTools() });
      // Session task board + bounded web fetch/search (harness baseline parity, 2026-07-10).
      api.registerTool({ factory: () => createTodoTools() });
      api.registerTool({ factory: () => createWebFetchTools() });
      api.registerTool({ factory: () => createWebSearchTools() });
      api.registerTool({ factory: () => createMcpStatusTools() });
      // Provider CLI status + dry-run-first delegated run (parity RED → GREEN, 2026-07-10).
      api.registerTool({ factory: () => createProviderCliTools() });
      // Desktop / PyAutoGUI-class tools — dry-run-first, failsafe, live gated (2026-07-10).
      api.registerTool({ factory: () => createDesktopTools() });
    });
    // Shell hooks: side-effecting lifecycle listeners (.guru/hooks/*.sh|bat|ps1). Must
    // be registered BEFORE start() so the first start() iterates its body — the
    // host only re-runs `start()` bodies for extensions already in the registry.
    // A dynamic import here would race start() and silently miss the first session.
    sharedHost.registerExtension(registerShellHooks);

    sharedHost.start();
    sharedTools = sharedHost.getToolFactories().flatMap((factory) => [...factory.factory()]);
  }

  return { host: sharedHost, tools: sharedTools!, memoryStore: sharedMemoryStore!, swarm: sharedSwarm! };
}

/** Collect the extension-contributed tool definitions for the session tool registry. */
export function collectExtensionTools(): readonly ToolDefinition[] {
  return initExtensions().tools;
}
