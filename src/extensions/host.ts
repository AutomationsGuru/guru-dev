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
      if (commandRegistry.has(id)) {
        throw new Error(`Command already registered: ${id}`);
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

    start(): void {
      for (const registration of extensionRegistrations) {
        registration.extension(api);
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
