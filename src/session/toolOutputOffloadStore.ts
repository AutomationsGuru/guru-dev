/**
 * Tool output offload store — when a tool result exceeds a size threshold,
 * the full body is parked process-locally under a ref id and the caller swaps
 * in a short pointer instead. Keeps oversized tool output from bloating the
 * in-context message history (composes with the F130 condenser / F117 compact
 * route); retrieval by id returns the untouched original.
 *
 * Not durable across process restarts — refs are valid for the live session.
 */

export interface OffloadOutcome {
  /** Content to place in the message: the original result, or a short pointer when offloaded. */
  readonly display: string;
  /** Ref id under which the full body was stored; absent when nothing was offloaded. */
  readonly ref?: string;
}

const bodies = new Map<string, string>();
let nextId = 0;

export function maybeOffload(result: string, threshold: number): OffloadOutcome {
  if (result.length <= threshold) {
    return { display: result };
  }

  nextId += 1;
  const ref = `offload:${nextId}`;
  bodies.set(ref, result);
  return {
    display: `[tool output offloaded: ${result.length} chars stored under ${ref}; retrieve with get("${ref}")]`,
    ref
  };
}

/** Retrieve the full body for a ref, or undefined when the ref is unknown. */
export function get(ref: string): string | undefined {
  return bodies.get(ref);
}
