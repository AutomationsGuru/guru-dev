import type { ToolDefinition } from "../tools/registry.js";
import {
  type ExtensionApi,
  type CommandMetadata,
  type CommandHandler,
  type CommandRegistration,
  type MessageRenderer,
  type MessageRendererRegistration,
  type ProviderRegistration,
  type RouteHandler,
  type RouteRegistration,
  type ToolFactoryRegistration
} from "./api.js";
import { type EventBus, createEventBus, type LifecycleEvent, type LifecycleEventMap } from "./events.js";

export interface CommandEntry {
  readonly handler: CommandHandler;
  readonly metadata: CommandMetadata;
}

export interface RouteEntry {
  readonly method: string;
  readonly path: string;
  readonly handler: RouteHandler;
}

export interface ExtensionRegistration {
  readonly extension: (api: ExtensionApi) => void;
}

export type ToolFactory = () => readonly ToolDefinition[];

export interface ExtensionHost {
  registerExtension(extension: (api: ExtensionApi) => void): void;
  getCommandRegistry(): ReadonlyMap<string, CommandEntry>;
  getRouteRegistry(): readonly RouteEntry[];
  getToolFactories(): readonly ToolFactoryRegistration[];
  sendMessage<T extends LifecycleEvent>(event: T, payload: LifecycleEventMap[T]): void;
  start(): void;
  stop(): void;
}

export function createExtensionHost(): ExtensionHost {
  const commandRegistry = new Map<string, CommandEntry>();
  const routeRegistry: RouteEntry[] = [];
  const toolFactoryList: ToolFactoryRegistration[] = [];
  const providerRegistrations: ProviderRegistration[] = [];
  const messageRendererRegistrations: MessageRendererRegistration[] = [];
  const extensionRegistrations: ExtensionRegistration[] = [];
  const bus: EventBus = createEventBus();
  let activeModelId: string | null = null;
  let active = false;

  const api: ExtensionApi = {
    registerProvider(provider: ProviderRegistration): void {
      providerRegistrations.push(provider);
    },

    registerTool(factory: ToolFactoryRegistration): void {
      toolFactoryList.push(factory);
    },

    registerCommand(id: string, handler: CommandHandler, metadata: CommandMetadata): void {
      // A duplicate command id warns + keeps the FIRST registration (review 2026-07-08):
      // the old throw poisoned the host spine for every other extension when two
      // valid-in-isolation extensions happened to collide on a command id.
      if (commandRegistry.has(id)) {
        // eslint-disable-next-line no-console
        console.warn(`[extensions] Command already registered: ${id} — keeping the first, ignoring the duplicate.`);
        return;
      }

      commandRegistry.set(id, { handler, metadata });
    },

    registerRoute(method: string, path: string, handler: RouteHandler): void {
      routeRegistry.push({ method, path, handler });
    },

    registerMessageRenderer(id: string, renderer: MessageRenderer): void {
      messageRendererRegistrations.push({ id, renderer });
    },

    on<T extends LifecycleEvent>(event: T, listener: (payload: LifecycleEventMap[T]) => void): void {
      bus.on(event, listener);
    },

    off<T extends LifecycleEvent>(event: T, listener: (payload: LifecycleEventMap[T]) => void): void {
      bus.off(event, listener);
    },

    sendMessage<T extends LifecycleEvent>(event: T, payload: LifecycleEventMap[T]): void {
      bus.emit(event, payload);
    },

    setModel(modelId: string): void {
      activeModelId = modelId;
      bus.emit("model:select", { modelId });
    }
  };

  const host: ExtensionHost = {
    registerExtension(extension: (api: ExtensionApi) => void): void {
      extensionRegistrations.push({ extension });

      if (active) {
        extension(api);
      }
    },

    getCommandRegistry(): ReadonlyMap<string, CommandEntry> {
      return commandRegistry;
    },

    getRouteRegistry(): readonly RouteEntry[] {
      return routeRegistry;
    },

    getToolFactories(): readonly ToolFactoryRegistration[] {
      return toolFactoryList;
    },

    sendMessage<T extends LifecycleEvent>(event: T, payload: LifecycleEventMap[T]): void {
      bus.emit(event, payload);
    },

    start(): void {
      // Reset registries at the top of start() (review 2026-07-08): the old code
      // re-ran every extension body on every start() WITHOUT clearing the arrays,
      // so a second start() (hot-reload, multi-session) DOUBLED every tool/route/
      // provider/renderer registration — the registry then threw "Tool already
      // registered" and the session never reached ready. Clear first so each
      // start() rebuilds from a clean slate.
      commandRegistry.clear();
      routeRegistry.length = 0;
      toolFactoryList.length = 0;
      providerRegistrations.length = 0;
      messageRendererRegistrations.length = 0;

      // Isolate each extension (review 2026-07-08): a throw in one extension's
      // registration body (a bad tool factory, a missing field) used to abort the
      // whole loop — extensions registered AFTER it never ran, `active` stayed
      // false, and session:start never fired. Wrap each so one bad neighbor can't
      // take down the block; warn and continue.
      for (const registration of extensionRegistrations) {
        try {
          registration.extension(api);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn(`[extensions] An extension threw during activation and was skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      active = true;
      bus.emit("session:start", { sessionId: "host" });
    },

    stop(): void {
      bus.emit("session:end", { sessionId: "host" });
      bus.removeAllListeners();
      active = false;
    }
  };

  return host;
}
