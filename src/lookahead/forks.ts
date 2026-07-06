import type { FileMemoryStore } from "../memory/store.js";
import type { ForkEnumerator } from "./engine.js";

/**
 * Fork enumeration (v1): the top-K likely ways a pending tool step surprises the
 * commit plane, from two cheap/free sources —
 *   1. the tool's declared failure surface (every mutating tool has a known
 *      failure axis: it fails, it's blocked by policy, or it returns nothing);
 *   2. garage path-outcome priors (which forks actually occurred for this tool).
 * Source 2 keeps the frontier targeted; both are free of extra model calls.
 */

const GENERIC_FORKS: Readonly<Record<string, ReadonlyArray<{ triggerCondition: string; prompt: string }>>> = {
  bash: [
    { triggerCondition: "bash command failed nonzero exit error", prompt: "The command failed. Read the error, fix the invocation or the underlying cause, and retry." },
    { triggerCondition: "bash blocked by approval policy", prompt: "The command was blocked. Explain the gate, or ask for the mandate/allow-writes that would permit it." }
  ],
  edit: [
    { triggerCondition: "edit failed old_string not found", prompt: "The edit target didn't match. Re-read the file, find the exact current text, and redo the edit." }
  ],
  write: [
    { triggerCondition: "write blocked path risky secret", prompt: "The write was blocked (risky path or secret). Choose a safe path or remove the sensitive content." }
  ]
};

const DEFAULT_FORKS: ReadonlyArray<{ triggerCondition: string; prompt: string }> = [
  { triggerCondition: "tool failed error", prompt: "The tool failed. Read the error and either fix and retry or choose a different approach." }
];

export function createForkEnumerator(memory?: FileMemoryStore): ForkEnumerator {
  return (pendingToolId, k) => {
    const generic = GENERIC_FORKS[pendingToolId] ?? DEFAULT_FORKS;
    const priors: Array<{ triggerCondition: string; prompt: string }> = [];
    if (memory) {
      // Garage priors: forks this tool has actually hit, mined from path-outcome facts.
      for (const entry of memory.list()) {
        if (entry.fact.type === "path-outcome" && entry.body.includes(pendingToolId) && priors.length < k) {
          priors.push({
            triggerCondition: `${pendingToolId} historically forked here`,
            prompt: `Garage prior: the ${entry.fact.name} suit has hit a fork on ${pendingToolId} before — check that record before committing.`
          });
        }
      }
    }
    return [...priors, ...generic].slice(0, k);
  };
}
