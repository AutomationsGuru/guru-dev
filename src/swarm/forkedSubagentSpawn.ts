import { randomUUID } from "node:crypto";

/**
 * Forked subagent spawn (IDEA-F186-FORK-SUB-01, letta-code review residual).
 *
 * Forking clones the parent's context SNAPSHOT id for a child worker: the child
 * receives its own id plus a reference to a freshly frozen snapshot of the
 * parent's state at fork time. The spawner deals in pure ids only — it never
 * hands the child a handle to the parent's mutable state, so a forked worker
 * cannot mutate what its parent or siblings observe (sibling isolation, the
 * same property the swarm manager's mandate snapshot enforces at §9).
 *
 * Snapshot CONTENT capture stays with the owning session (which injects a
 * snapshot provider when one is wired); this module owns id minting and the
 * snapshotRef → parentId registry so a fork lineage stays resolvable.
 */

export interface ForkedSubagentSpawnResult {
  /** The child worker's unique id — never reused across forks. */
  readonly childId: string;
  /** Reference to the parent's context snapshot frozen at fork time. */
  readonly snapshotRef: string;
}

export interface ForkedSubagentSpawner {
  /** Clone the parent's context snapshot id for a child worker. */
  fork(parentId: string): ForkedSubagentSpawnResult;
  /** Resolve which parent a snapshot ref was forked from (undefined if unknown). */
  snapshotParent(snapshotRef: string): string | undefined;
}

export function createForkedSubagentSpawner(): ForkedSubagentSpawner {
  const snapshotLineage = new Map<string, string>();

  return {
    fork(parentId) {
      const trimmed = parentId.trim();
      if (trimmed.length === 0) {
        throw new Error("Cannot fork a subagent from a blank parent id.");
      }
      const childId = `child-${randomUUID().slice(0, 8)}`;
      const snapshotRef = `snap-${randomUUID()}`;
      snapshotLineage.set(snapshotRef, trimmed);
      return { childId, snapshotRef };
    },
    snapshotParent(snapshotRef) {
      return snapshotLineage.get(snapshotRef);
    }
  };
}
