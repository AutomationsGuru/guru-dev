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
import { registerShellHooks } from "./shellHooks.js";
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
let sharedHost: ExtensionHost | null = null;
let sharedTools: readonly ToolDefinition[] | null = null;
let sharedMemoryStore: FileMemoryStore | null = null;
let sharedSwarm: SwarmManager | null = null;

export function initExtensions(options: InitExtensionsOptions = {}): HarnessExtensions {
  if (!sharedHost) {
    sharedHost = createExtensionHost();
    const honchoClient = createInMemoryHonchoClient({
      config: HonchoConfigSchema.parse({
        workspaceId: "guruharness",
        writeEnabled: false,
        requiredEnvNames: [...HONCHO_REQUIRED_ENV_NAMES]
      })
    });
    sharedMemoryStore = createFileMemoryStore({
      ...(options.memoryDirectory ? { directory: options.memoryDirectory } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {})
    });
    sharedSwarm = getSharedSwarmManager(options.swarmConfig ?? {});

    sharedHost.registerExtension((api) => {
      api.registerTool({ factory: () => createHonchoTools({ client: honchoClient }) });
      api.registerTool({ factory: () => createReadinessTools({ honchoClient }) });
      api.registerTool({ factory: () => createMemoryTools({ store: sharedMemoryStore! }) });
      api.registerTool({ factory: () => createSwarmTools({ manager: sharedSwarm! }) });
      api.registerTool({ factory: () => createResolverTools() });
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
