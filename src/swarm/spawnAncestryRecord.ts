/**
 * Spawn ancestry record — immutable parent→child relationship tracking for the
 * swarm module. Supports depth-bounded recursion checks and allowlist-based
 * spawning authorization.
 */

/** Sentinel for top-level spawns (parent session). */
export const ROOT_PARENT_ID = "__root__";

/** Immutable record of a parent→child spawn relationship. */
export interface SpawnAncestryRecord {
  readonly childId: string;
  readonly parentId: string;
  readonly depth: number;
  readonly spawnedAt: string;
}

/** Discriminated result from a maySpawn check. */
export type MaySpawnResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** Registry of parent→child spawn relationships with depth and allowlist enforcement. */
export interface AncestryRegistry {
  readonly register: (childId: string, parentId: string, depth: number) => SpawnAncestryRecord;
  readonly maySpawn: (depth: number, parentId: string, allowlist?: ReadonlySet<string>) => MaySpawnResult;
  readonly getChildren: (parentId: string) => readonly SpawnAncestryRecord[];
  readonly getParent: (childId: string) => SpawnAncestryRecord | undefined;
  readonly getAncestryChain: (childId: string) => readonly SpawnAncestryRecord[];
  readonly size: () => number;
}

/**
 * Create an ancestry registry with a depth ceiling and optional allowlist.
 *
 * @param maxDepth - The depth limit (default 3). depth > maxDepth is rejected.
 * @param allowlist - Optional set of parent IDs permitted to spawn. When defined
 *   and non-empty, spawns from parents not in the allowlist are rejected.
 */
export function createAncestryRegistry(
  maxDepth: number = 3,
  allowlist?: ReadonlySet<string>
): AncestryRegistry {
  const records = new Map<string, SpawnAncestryRecord>();
  // childId → parentId for fast reverse lookups
  const childToParent = new Map<string, string>();
  // parentId → Set<childId> for fast child enumeration
  const parentToChildren = new Map<string, Set<string>>();

  const register = (childId: string, parentId: string, depth: number): SpawnAncestryRecord => {
    const record: SpawnAncestryRecord = {
      childId,
      parentId,
      depth,
      spawnedAt: new Date().toISOString()
    };
    records.set(childId, record);
    childToParent.set(childId, parentId);

    let children = parentToChildren.get(parentId);
    if (!children) {
      children = new Set();
      parentToChildren.set(parentId, children);
    }
    children.add(childId);

    return record;
  };

  const maySpawn = (depth: number, parentId: string, runtimeAllowlist?: ReadonlySet<string>): MaySpawnResult => {
    const effectiveAllowlist = runtimeAllowlist ?? allowlist;

    if (depth > maxDepth) {
      return { allowed: false, reason: `depth ${depth} exceeds limit ${maxDepth}` };
    }

    if (effectiveAllowlist !== undefined && effectiveAllowlist.size > 0 && !effectiveAllowlist.has(parentId)) {
      return { allowed: false, reason: `parent '${parentId}' not in allowlist` };
    }

    return { allowed: true };
  };

  const getChildren = (parentId: string): readonly SpawnAncestryRecord[] => {
    const childIds = parentToChildren.get(parentId);
    if (!childIds) {
      return [];
    }
    const result: SpawnAncestryRecord[] = [];
    for (const childId of childIds) {
      const record = records.get(childId);
      if (record) {
        result.push(record);
      }
    }
    return result;
  };

  const getParent = (childId: string): SpawnAncestryRecord | undefined => {
    const parentId = childToParent.get(childId);
    if (parentId === undefined) {
      return undefined;
    }
    return records.get(parentId);
  };

  const getAncestryChain = (childId: string): readonly SpawnAncestryRecord[] => {
    const chain: SpawnAncestryRecord[] = [];
    let current = childId;
    while (true) {
      const record = records.get(current);
      if (!record) {
        return chain;
      }
      chain.push(record);
      if (record.parentId === ROOT_PARENT_ID) {
        return chain;
      }
      current = record.parentId;
    }
  };

  const size = (): number => records.size;

  return {
    register,
    maySpawn,
    getChildren,
    getParent,
    getAncestryChain,
    size
  };
}