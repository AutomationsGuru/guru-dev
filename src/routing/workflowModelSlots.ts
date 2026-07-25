import {
  type ModelBinding,
  type WorkflowModelSlot,
  type WorkflowModelSlotsConfig
} from "./workflowModelSlotsSchema.js";

/** Result of resolving a phase: the winning binding plus the slot that supplied it. */
export interface ResolvedModelSlot {
  slot: WorkflowModelSlot;
  binding: ModelBinding;
}

/**
 * Resolve the model binding for a workflow phase without re-reading ad-hoc env.
 *
 * Walk order for `phase`:
 *   1. The phase's own slot binding, when set (explicit binding always wins).
 *   2. The slot's explicit fallback chain (`config.fallbacks[phase]`), in order.
 *   3. The default chain: `normal`.
 *
 * Every hop first checks the hop slot's own binding, then continues down that
 * slot's explicit chain. Throws when the chain terminates with no binding —
 * including when `normal` itself is unbound — and when explicit chains form a cycle.
 */
export function resolveSlot(config: WorkflowModelSlotsConfig, phase: WorkflowModelSlot): ResolvedModelSlot {
  const chain = buildChain(config, phase);

  for (const slot of chain) {
    const binding = config[slot];
    if (binding !== undefined) {
      return { slot, binding };
    }
  }

  throw new Error(
    `workflowModelSlots: no model binding for phase "${phase}"; walked chain [${chain.join(" -> ")}] without finding a bound slot. Bind "normal" or add a fallback chain.`
  );
}

/**
 * Flatten the walk order for `phase` into a de-duplicated slot list, throwing on cycles.
 *
 * The walk is linear: at each hop, if the slot is unbound we follow that slot's
 * explicit fallback chain in order (or, when no explicit chain is set, the
 * default hop to `normal`). We stop expanding as soon as a bound slot is found,
 * so a cycle in a branch never reached does not fail resolution. A cycle is only
 * an error when the walk actually loops back to a slot already on the path.
 */
function buildChain(config: WorkflowModelSlotsConfig, phase: WorkflowModelSlot): WorkflowModelSlot[] {
  const order: WorkflowModelSlot[] = [];
  const visited = new Set<WorkflowModelSlot>();

  const visit = (slot: WorkflowModelSlot): void => {
    if (visited.has(slot)) {
      throw new Error(
        `workflowModelSlots: cycle detected in explicit fallback chains involving slot "${slot}".`
      );
    }
    visited.add(slot);
    order.push(slot);

    if (config[slot] !== undefined) {
      return; // bound — the walk stops here
    }

    const explicit = config.fallbacks[slot];
    const next = explicit !== undefined && explicit.length > 0 ? explicit : slot !== "normal" ? ["normal" as const] : [];
    for (const hop of next) {
      visit(hop);
      if (config[hop] !== undefined) {
        return; // a later hop in this chain bound — stop walking siblings
      }
    }
  };

  visit(phase);
  return order;
}
