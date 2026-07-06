export const LifecycleEvents = {
  SESSION_START: "session:start",
  SESSION_END: "session:end",
  TURN_START: "turn:start",
  TURN_END: "turn:end",
  TOOL_EXECUTE: "tool:execute",
  TOOL_RESULT: "tool:result",
  PROVIDER_SELECT: "provider:select",
  MODEL_SELECT: "model:select",
  PROJECT_TRUST: "project:trust",
  INPUT_RECEIVED: "input:received",
  RESOURCE_LOADED: "resource:loaded"
} as const;

export type LifecycleEvent = (typeof LifecycleEvents)[keyof typeof LifecycleEvents];

export interface SessionEventPayload {
  readonly sessionId: string;
}

export interface TurnEventPayload {
  readonly sessionId: string;
  readonly turnIndex?: number;
}

export interface ToolExecutePayload {
  readonly toolId: string;
  readonly input: unknown;
}

export interface ToolResultPayload {
  readonly toolId: string;
  readonly output: unknown;
}

export interface ProviderEventPayload {
  readonly providerId: string;
}

export interface ModelEventPayload {
  readonly modelId: string;
}

export interface ProjectTrustPayload {
  readonly projectId: string;
  readonly trusted: boolean;
}

export interface InputReceivedPayload {
  readonly sessionId: string;
  readonly input: string;
}

export interface ResourceLoadedPayload {
  readonly resourceId: string;
}

export interface LifecycleEventMap {
  "session:start": SessionEventPayload;
  "session:end": SessionEventPayload;
  "turn:start": TurnEventPayload;
  "turn:end": TurnEventPayload;
  "tool:execute": ToolExecutePayload;
  "tool:result": ToolResultPayload;
  "provider:select": ProviderEventPayload;
  "model:select": ModelEventPayload;
  "project:trust": ProjectTrustPayload;
  "input:received": InputReceivedPayload;
  "resource:loaded": ResourceLoadedPayload;
}

export type LifecycleEventListener<T extends LifecycleEvent> = (payload: LifecycleEventMap[T]) => void;

export interface EventBus {
  on<T extends LifecycleEvent>(event: T, listener: LifecycleEventListener<T>): void;
  off<T extends LifecycleEvent>(event: T, listener: LifecycleEventListener<T>): void;
  emit<T extends LifecycleEvent>(event: T, payload: LifecycleEventMap[T]): void;
  listenerCount(event: LifecycleEvent): number;
  removeAllListeners(): void;
}

export function createEventBus(): EventBus {
  const listeners = new Map<LifecycleEvent, Set<LifecycleEventListener<LifecycleEvent>>>();

  const bus: EventBus = {
    on<T extends LifecycleEvent>(event: T, listener: LifecycleEventListener<T>): void {
      const existing = listeners.get(event);

      if (existing) {
        existing.add(listener as LifecycleEventListener<LifecycleEvent>);
      } else {
        listeners.set(event, new Set([listener as LifecycleEventListener<LifecycleEvent>]));
      }
    },
    off<T extends LifecycleEvent>(event: T, listener: LifecycleEventListener<T>): void {
      const existing = listeners.get(event);

      if (existing) {
        existing.delete(listener as LifecycleEventListener<LifecycleEvent>);
      }
    },
    emit<T extends LifecycleEvent>(event: T, payload: LifecycleEventMap[T]): void {
      const existing = listeners.get(event);

      if (existing) {
        for (const listener of existing) {
          listener(payload);
        }
      }
    },
    listenerCount(event: LifecycleEvent): number {
      const existing = listeners.get(event);

      return existing ? existing.size : 0;
    },
    removeAllListeners(): void {
      listeners.clear();
    }
  };

  return bus;
}
