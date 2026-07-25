/**
 * Goal coordinator DAG — computes topological waves (parallelizable levels)
 * from goals with optional dependencies. Used by the goal coordinator to
 * schedule work in dependency-respecting waves.
 *
 * A wave is a set of goals whose dependencies are all satisfied by prior waves.
 * Pure function; no side effects.
 */

export interface Goal {
  readonly id: string;
  readonly deps?: readonly string[];
}

/**
 * Compute topological waves for the given goals.
 * Returns array of waves; each wave is array of goal ids that can execute
 * after all previous waves complete.
 *
 * Throws on cycle detection.
 * Unknown dep ids (not present in the goals list) are treated as already-satisfied
 * external prerequisites.
 */
export function waves(goals: readonly Goal[]): string[][] {
  if (goals.length === 0) {
    return [];
  }

  const idToGoal = new Map<string, Goal>();
  for (const g of goals) {
    if (idToGoal.has(g.id)) {
      // duplicate id: treat as last wins or error? for simplicity keep first, but assume unique
    } else {
      idToGoal.set(g.id, g);
    }
  }

  // indegree: count of unsatisfied internal deps
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>(); // reverse? for Kahn we need outgoing? actually for levels use incoming count

  for (const g of goals) {
    const deps = g.deps ?? [];
    const internalDeps = deps.filter((d) => idToGoal.has(d));
    indegree.set(g.id, internalDeps.length);
    // build reverse adj for processing: who depends on me
    for (const d of internalDeps) {
      if (!adj.has(d)) adj.set(d, []);
      adj.get(d)!.push(g.id);
    }
    if (!adj.has(g.id)) adj.set(g.id, []);
  }

  // init queue with 0 indegree
  const queue: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id);
  }

  const result: string[][] = [];
  let processed = 0;

  while (queue.length > 0) {
    // sort for deterministic output within wave (lex)
    queue.sort();
    const wave = [...queue];
    result.push(wave);
    queue.length = 0; // clear for next wave

    for (const id of wave) {
      processed++;
      const dependents = adj.get(id) ?? [];
      for (const depId of dependents) {
        const newDeg = (indegree.get(depId) ?? 0) - 1;
        indegree.set(depId, newDeg);
        if (newDeg === 0) {
          queue.push(depId);
        }
      }
    }
  }

  if (processed !== goals.length) {
    throw new Error("Cycle detected in goal dependencies");
  }

  return result;
}
