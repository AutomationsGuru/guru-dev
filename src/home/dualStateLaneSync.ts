/**
 * Dual state lane sync: pure merge of root and lane STATE snapshots
 * with conflict report.
 *
 * A "root" is the base/trunk state snapshot set; a "lane" is a branch
 * snapshot set. The merge produces a unified set plus any conflicts
 * where the same key has diverged.
 */

/** A single state entry keyed by kind + title. Extra fields are preserved. */
export interface StateEntry {
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly [extra: string]: unknown;
}

/** A conflict where root and lane disagree on the body for the same key. */
export interface StateConflict {
  readonly key: string;
  readonly root: StateEntry;
  readonly lane: StateEntry;
}

/** The result of a dual-state merge. */
export interface DualStateMergeResult {
  /** The unified snapshot set. Lane wins on same-key, same-body. */
  readonly merged: readonly StateEntry[];
  /** Divergences where root and lane have different bodies for the same key. */
  readonly conflicts: readonly StateConflict[];
}

function entryKey(entry: StateEntry): string {
  return `${entry.kind}::${entry.title}`;
}

/**
 * Merge two sets of state snapshots — root (base/trunk) and lane (branch).
 *
 * Rules:
 * - Entries unique to root or lane are included as-is.
 * - Entries with the same key and matching body are deduplicated; the lane
 *   entry (typically more current) is retained.
 * - Entries with the same key but different bodies are reported as a
 *   conflict. The lane entry is kept in `merged`.
 */
export function merge(
  root: readonly StateEntry[],
  lane: readonly StateEntry[]
): DualStateMergeResult {
  const rootByKey = new Map<string, StateEntry>();
  for (const e of root) {
    rootByKey.set(entryKey(e), e);
  }

  const laneByKey = new Map<string, StateEntry>();
  for (const e of lane) {
    laneByKey.set(entryKey(e), e);
  }

  const allKeys = new Set([...rootByKey.keys(), ...laneByKey.keys()]);
  const merged: StateEntry[] = [];
  const conflicts: StateConflict[] = [];

  for (const key of allKeys) {
    const rootEntry = rootByKey.get(key);
    const laneEntry = laneByKey.get(key);

    if (rootEntry && laneEntry) {
      if (rootEntry.body === laneEntry.body) {
        // Same key, same body — deduplicate, prefer lane (more current).
        merged.push(laneEntry);
      } else {
        // Same key, different body — conflict.
        conflicts.push({ key, root: rootEntry, lane: laneEntry });
        merged.push(laneEntry);
      }
    } else if (rootEntry) {
      merged.push(rootEntry);
    } else if (laneEntry) {
      merged.push(laneEntry);
    }
  }

  return { merged, conflicts };
}
