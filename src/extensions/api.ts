import type { BeforeCompactHook } from "../compaction/engine.js";
import type { ToolDefinition } from "../tools/registry.js";
import type { LifecycleEventMap, LifecycleEvent } from "./events.js";

export interface ProviderRegistration {
  readonly id: string;
  readonly label: string;
  readonly kind: "model-provider";
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ToolFactoryRegistration {
  readonly factory: () => readonly ToolDefinition[];
}

export interface CommandMetadata {
  readonly description: string;
  readonly usage?: string;
}

export interface CommandHandler {
  (args: readonly string[]): void | Promise<void>;
}

export interface CommandRegistration {
  readonly id: string;
  readonly handler: CommandHandler;
  readonly metadata: CommandMetadata;
}

export interface RouteHandler {
  (request: unknown): Promise<unknown>;
}

export interface RouteRegistration {
  readonly method: string;
  readonly path: string;
  readonly handler: RouteHandler;
}

export interface MessageRenderer {
  (message: unknown): string;
}

export interface MessageRendererRegistration {
  readonly id: string;
  readonly renderer: MessageRenderer;
}

export interface ExtensionApi {
  registerProvider(provider: ProviderRegistration): void;
  registerTool(factory: ToolFactoryRegistration): void;
  registerCommand(id: string, handler: CommandHandler, metadata: CommandMetadata): void;
  registerRoute(method: string, path: string, handler: RouteHandler): void;
  registerMessageRenderer(id: string, renderer: MessageRenderer): void;
  registerBeforeCompact(hook: BeforeCompactHook): void;
  on<T extends LifecycleEvent>(event: T, listener: (payload: LifecycleEventMap[T]) => void): void;
  off<T extends LifecycleEvent>(event: T, listener: (payload: LifecycleEventMap[T]) => void): void;
  sendMessage<T extends LifecycleEvent>(event: T, payload: LifecycleEventMap[T]): void;
  setModel(modelId: string): void;
}
