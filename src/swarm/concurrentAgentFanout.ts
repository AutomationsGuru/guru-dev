/**
 * Concurrent agent fan-out (IDEA-F521-CONC-01) — pure, deterministic
 * application of one caller-supplied task to every keyed agent.
 *
 * This primitive owns no model, provider, tool, network, persistence, retry,
 * cancellation, or runtime-registration behavior. It only starts the supplied
 * functions together and collects their results. The caller owns any policy
 * around those functions; this helper preserves the original rejection when an
 * agent fails instead of inventing a partial-result or error representation.
 */

/** A caller-supplied agent that receives the same task as every sibling. */
export type ConcurrentAgent<TTask, TResult> = (
  task: TTask
) => TResult | PromiseLike<TResult>;

/**
 * Run all keyed agents concurrently with the same task and collect their
 * results in a fresh map.
 *
 * Map iteration order is preserved in the returned map, regardless of the order
 * in which the agents settle. Every agent is invoked exactly once. If any agent
 * rejects, the original rejection propagates and no partial result map is
 * returned; already-started sibling calls are not cancelled.
 */
export async function runConcurrent<TTask, TResult>(
  agents: ReadonlyMap<string, ConcurrentAgent<TTask, TResult>>,
  task: TTask
): Promise<ReadonlyMap<string, TResult>> {
  const entries = [...agents.entries()];
  const results = await Promise.all(
    entries.map(([, agent]) => Promise.resolve().then(() => agent(task)))
  );

  return new Map(entries.map(([id], index) => [id, results[index]!])) as ReadonlyMap<string, TResult>;
}
