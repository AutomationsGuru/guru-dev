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

/**
 * Pre-tool hook decision vocabulary (IDEA-D5). A deciding pre-tool hook returns
 * exactly one of these; an observer hook returns void and is structurally unable
 * to rewrite the call (deciding lane: `registerPreToolHook` in `shellHooks.ts`;
 * observer lane: the `on()` event bus, which has no decision channel).
 *
 * - `allow`        — proceed to the next gate unchanged.
 * - `ask`          — escalate to the operator before proceeding.
 * - `deny`         — refuse the call. Terminal: no later hook, YOLO flag, or
 *                    soft policy may lift it.
 * - `updatedInput` — proceed with a rewritten input payload.
 *
 * Precedence on merge is fixed and non-configurable: deny > ask > allow, and the
 * LAST `updatedInput` among non-denied hooks wins. This ordering is what keeps
 * mandate and hard-limit floors ahead of every hook: a hook may only ever tighten
 * a call (allow → ask → deny, or rewrite input), it can never un-deny or widen
 * what a higher-precedence hook or the mandate floor already refused.
 */
export type PreToolHookDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "ask"; readonly reason: string }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "updatedInput"; readonly input: unknown };

export const PRE_TOOL_DECISION_ALLOW: PreToolHookDecision = Object.freeze({ kind: "allow" });

/**
 * Numeric rank used only to order the merge — higher always wins. `updatedInput`
 * sits between allow and ask: it is stronger than a bare allow (it changes the
 * call) but it never outranks an ask or a deny, and a later updatedInput replaces
 * an earlier one at the same rank.
 */
function decisionRank(decision: PreToolHookDecision): number {
  switch (decision.kind) {
    case "deny":
      return 3;
    case "ask":
      return 2;
    case "updatedInput":
      return 1;
    case "allow":
      return 0;
  }
}

/**
 * Merge an ordered list of hook decisions into one effective decision.
 *
 * Rules (structural order, not policy prose):
 *  1. Any `deny` wins outright; the FIRST deny's reason is kept because it is the
 *     earliest hard refusal and later hooks ran after the call was already dead.
 *  2. Else any `ask` wins over allow/updatedInput; the first ask's reason is kept.
 *  3. Else the LAST `updatedInput` wins (later hooks see and re-rewrite earlier
 *     rewrites, so the final one is the composed result).
 *  4. Else `allow`.
 *
 * A hook cannot "un-deny": once a deny is present in the list the merge is deny
 * regardless of what follows. This is the code-level guarantee that hook merges
 * preserve mandate / hard-limit precedence — a soft hook layer can never lift a
 * refusal, only add one.
 */
export function mergePreToolHookDecisions(decisions: readonly PreToolHookDecision[]): PreToolHookDecision {
  let firstDeny: PreToolHookDecision | null = null;
  let firstAsk: PreToolHookDecision | null = null;
  let lastUpdatedInput: PreToolHookDecision | null = null;

  for (const decision of decisions) {
    const rank = decisionRank(decision);
    if (rank === 3) {
      if (firstDeny === null) firstDeny = decision;
    } else if (rank === 2) {
      if (firstAsk === null) firstAsk = decision;
    } else if (rank === 1) {
      lastUpdatedInput = decision;
    }
  }

  if (firstDeny !== null) return firstDeny;
  if (firstAsk !== null) return firstAsk;
  if (lastUpdatedInput !== null) return lastUpdatedInput;
  return PRE_TOOL_DECISION_ALLOW;
}

/**
 * Payload handed to a deciding pre-tool hook. `hookId` identifies which hook is
 * being invoked so one hook can be re-run in isolation.
 */
export interface PreToolHookInvocation {
  readonly hookId: string;
  readonly toolId: string;
  readonly input: unknown;
}

/**
 * A deciding pre-tool hook. It receives the invocation and returns a decision —
 * it is the ONLY extension surface that may rewrite or refuse a tool call before
 * soft policy. Deciding hooks are registered through the shellHooks decision
 * lane (`registerPreToolHook` in `shellHooks.ts`), NOT through the `on()` event
 * bus, so the type system keeps the two lanes apart: `on()` listeners return
 * void and are pure observers; they cannot rewrite by construction (no decision
 * channel exists on that path — their stdout is never even captured).
 */
export type PreToolHook = (invocation: PreToolHookInvocation) => PreToolHookDecision | Promise<PreToolHookDecision>;

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
