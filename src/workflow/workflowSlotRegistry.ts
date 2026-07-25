/**
 * Workflow slot registry: named slots hold optional step handlers.
 * Missing slot returns null; re-registering the same id overwrites.
 *
 * Lightweight Map-backed registry with no framework dependency —
 * follows the GuruHarness runtime-ownership contract (§1.1).
 */

export type WorkflowStepHandler = (...args: unknown[]) => Promise<void> | void;

export interface WorkflowSlotRegistry {
  /** Register (or overwrite) a handler for a named slot. */
  readonly register: (id: string, handler: WorkflowStepHandler) => void;
  /** Return the handler registered for id, or null when no slot exists. */
  readonly get: (id: string) => WorkflowStepHandler | null;
  /** Remove a slot. No-op when the slot does not exist. */
  readonly remove: (id: string) => void;
  /** True when no slots are registered. */
  readonly isEmpty: () => boolean;
  /** Number of registered slots. */
  readonly size: () => number;
  /** All registered slot ids (insertion order). */
  readonly ids: () => readonly string[];
}

export function createWorkflowSlotRegistry(): WorkflowSlotRegistry {
  const slots = new Map<string, WorkflowStepHandler>();

  return {
    register(id, handler) {
      slots.set(id, handler);
    },

    get(id) {
      return slots.get(id) ?? null;
    },

    remove(id) {
      slots.delete(id);
    },

    isEmpty() {
      return slots.size === 0;
    },

    size() {
      return slots.size;
    },

    ids() {
      return [...slots.keys()];
    },
  };
}
