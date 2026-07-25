/**
 * Pure, bounded observability for completed swarm nodes.
 *
 * The caller owns the event array. Each completion returns a fresh array and
 * retains only the newest events, keeping node completion history bounded.
 */

/** A recorded swarm-node completion. */
export interface SwarmNodeEvent {
  readonly nodeId: string;
}

/** Alias naming the event's completion lifecycle explicitly. */
export type SwarmNodeCompletionEvent = SwarmNodeEvent;

/** Maximum number of completion events retained by the pure hook. */
export const SWARM_NODE_EVENT_CAPACITY = 256;

/**
 * Record a completed node without mutating the supplied history.
 *
 * The returned array is always a new array. When the history reaches the
 * bounded capacity, the oldest events are evicted and the newest are kept.
 */
export function onComplete(
  events: readonly SwarmNodeEvent[],
  nodeId: string
): SwarmNodeEvent[] {
  return [...events, { nodeId }].slice(-SWARM_NODE_EVENT_CAPACITY);
}

/** Descriptive alias for callers wiring a node-completion callback. */
export const onNodeComplete = onComplete;
