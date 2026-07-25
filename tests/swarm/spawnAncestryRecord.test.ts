import { describe, expect, it } from "vitest";

import {
  ROOT_PARENT_ID,
  createAncestryRegistry
} from '../../src/swarm/spawnAncestryRecord.js';

describe("SpawnAncestryRecord", () => {
  it("ROOT_PARENT_ID is the expected sentinel", () => {
    expect(ROOT_PARENT_ID).toBe("__root__");
  });

  it("register creates and returns a SpawnAncestryRecord with all fields", () => {
    const registry = createAncestryRegistry();
    const record = registry.register("child-1", ROOT_PARENT_ID, 0);

    expect(record.childId).toBe("child-1");
    expect(record.parentId).toBe(ROOT_PARENT_ID);
    expect(record.depth).toBe(0);
    expect(record.spawnedAt).toBeTruthy();
    // spawnedAt must be a valid ISO timestamp
    expect(new Date(record.spawnedAt).toISOString()).toBe(record.spawnedAt);
  });

  it("maySpawn allows spawn within depth limit", () => {
    const registry = createAncestryRegistry(3);

    expect(registry.maySpawn(0, ROOT_PARENT_ID)).toEqual({ allowed: true });
    expect(registry.maySpawn(1, "parent-a")).toEqual({ allowed: true });
    expect(registry.maySpawn(3, "parent-b")).toEqual({ allowed: true });
  });

  it("maySpawn rejects spawn exceeding depth limit", () => {
    const registry = createAncestryRegistry(3);

    const result = registry.maySpawn(4, "parent-x");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("depth 4 exceeds limit 3");
    }
  });

  it("maySpawn rejects when parent not in allowlist", () => {
    const allowlist = new Set(["allowed-parent"]);
    const registry = createAncestryRegistry(3, allowlist);

    const result = registry.maySpawn(1, "unlisted-parent");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("parent 'unlisted-parent' not in allowlist");
    }
  });

  it("maySpawn allows when parent is in allowlist (and depth ok)", () => {
    const allowlist = new Set(["allowed-parent", "also-allowed"]);
    const registry = createAncestryRegistry(3, allowlist);

    expect(registry.maySpawn(2, "allowed-parent")).toEqual({ allowed: true });
    expect(registry.maySpawn(3, "also-allowed")).toEqual({ allowed: true });
  });

  it("maySpawn rejects when parent not in allowlist AND depth exceeds limit (depth checked first)", () => {
    const allowlist = new Set(["allowed-parent"]);
    const registry = createAncestryRegistry(3, allowlist);

    // Depth failure takes precedence
    const result = registry.maySpawn(4, "unlisted-parent");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("depth 4 exceeds limit 3");
    }
  });

  it("getChildren returns direct children of a parent", () => {
    const registry = createAncestryRegistry();
    registry.register("a", ROOT_PARENT_ID, 0);
    registry.register("b", ROOT_PARENT_ID, 0);
    registry.register("c", "a", 1);

    const rootChildren = registry.getChildren(ROOT_PARENT_ID);
    expect(rootChildren).toHaveLength(2);
    expect(rootChildren.map((r) => r.childId).sort()).toEqual(["a", "b"]);

    const aChildren = registry.getChildren("a");
    expect(aChildren).toHaveLength(1);
    expect(aChildren[0]?.childId).toBe("c");

    // Empty for parent with no children
    const emptyChildren = registry.getChildren("nonexistent");
    expect(emptyChildren).toHaveLength(0);
  });

  it("getParent returns the parent record for a child", () => {
    const registry = createAncestryRegistry();
    const rootRecord = registry.register("root-child", ROOT_PARENT_ID, 0);
    registry.register("nested-child", "root-child", 1);

    const parent = registry.getParent("nested-child");
    expect(parent).toBeDefined();
    expect(parent?.childId).toBe("root-child");
    expect(parent?.parentId).toBe(ROOT_PARENT_ID);

    // The parent of a root-spawned child is the ROOT_PARENT_ID sentinel itself, but
    // getParent looks up a *record* by childId — ROOT_PARENT_ID is never registered
    // as a record, so getting the parent of a root-spawned child returns undefined.
    const rootParent = registry.getParent("root-child");
    expect(rootParent).toBeUndefined();

    // Unknown child returns undefined
    expect(registry.getParent("nonexistent")).toBeUndefined();
  });

  it("getAncestryChain walks from child to root", () => {
    const registry = createAncestryRegistry();
    // Build chain: ROOT_PARENT_ID → a → b → c
    const aRecord = registry.register("a", ROOT_PARENT_ID, 0);
    const bRecord = registry.register("b", "a", 1);
    const cRecord = registry.register("c", "b", 2);

    const chain = registry.getAncestryChain("c");
    expect(chain).toHaveLength(3);
    expect(chain[0]?.childId).toBe("c");
    expect(chain[0]?.parentId).toBe("b");
    expect(chain[1]?.childId).toBe("b");
    expect(chain[1]?.parentId).toBe("a");
    expect(chain[2]?.childId).toBe("a");
    expect(chain[2]?.parentId).toBe(ROOT_PARENT_ID);
  });

  it("getAncestryChain returns empty array for unknown child", () => {
    const registry = createAncestryRegistry();
    const chain = registry.getAncestryChain("nonexistent");
    expect(chain).toHaveLength(0);
  });

  it("getAncestryChain stops at root for a direct root spawn", () => {
    const registry = createAncestryRegistry();
    registry.register("direct", ROOT_PARENT_ID, 0);

    const chain = registry.getAncestryChain("direct");
    expect(chain).toHaveLength(1);
    expect(chain[0]?.childId).toBe("direct");
    expect(chain[0]?.parentId).toBe(ROOT_PARENT_ID);
  });

  it("size returns total records stored", () => {
    const registry = createAncestryRegistry();
    expect(registry.size()).toBe(0);

    registry.register("a", ROOT_PARENT_ID, 0);
    expect(registry.size()).toBe(1);

    registry.register("b", "a", 1);
    expect(registry.size()).toBe(2);

    registry.register("c", "b", 2);
    expect(registry.size()).toBe(3);
  });

  it("registry works with no allowlist (all parents allowed)", () => {
    // No allowlist passed
    const registry = createAncestryRegistry(3);

    expect(registry.maySpawn(0, ROOT_PARENT_ID)).toEqual({ allowed: true });
    expect(registry.maySpawn(1, "any-parent")).toEqual({ allowed: true });
    expect(registry.maySpawn(2, "another-parent")).toEqual({ allowed: true });
    expect(registry.maySpawn(3, "some-other")).toEqual({ allowed: true });

    // Only depth gates
    const rejected = registry.maySpawn(4, "any-parent");
    expect(rejected.allowed).toBe(false);
  });

  it("depth limit boundary — exactly at limit is allowed, limit+1 is rejected", () => {
    const registry = createAncestryRegistry(3);

    // Exactly at limit: allowed (matches manager.ts depth > maxSpawnDepth behavior)
    expect(registry.maySpawn(3, ROOT_PARENT_ID)).toEqual({ allowed: true });

    // One past limit: rejected
    const rejected = registry.maySpawn(4, ROOT_PARENT_ID);
    expect(rejected.allowed).toBe(false);
    if (!rejected.allowed) {
      expect(rejected.reason).toBe("depth 4 exceeds limit 3");
    }

    // Below limit: allowed
    expect(registry.maySpawn(2, ROOT_PARENT_ID)).toEqual({ allowed: true });
    expect(registry.maySpawn(1, ROOT_PARENT_ID)).toEqual({ allowed: true });
    expect(registry.maySpawn(0, ROOT_PARENT_ID)).toEqual({ allowed: true });
  });

  it("empty allowlist (size 0) is treated as no allowlist — all parents allowed", () => {
    // An empty Set is not a restriction — it means "no allowlist"
    const registry = createAncestryRegistry(3, new Set<string>());

    expect(registry.maySpawn(1, "any-parent")).toEqual({ allowed: true });
    expect(registry.maySpawn(3, ROOT_PARENT_ID)).toEqual({ allowed: true });
  });

  it("runtime allowlist parameter overrides the registry's allowlist", () => {
    const registry = createAncestryRegistry(3, new Set(["builtin-parent"]));

    // With built-in allowlist, unlisted parent is rejected
    const builtinReject = registry.maySpawn(1, "unlisted");
    expect(builtinReject.allowed).toBe(false);

    // Runtime allowlist overrides: allows a different parent
    expect(registry.maySpawn(1, "runtime-parent", new Set(["runtime-parent"]))).toEqual({ allowed: true });

    // Runtime allowlist still rejects unauthorized parents
    const runtimeReject = registry.maySpawn(1, "unlisted", new Set(["runtime-parent"]));
    expect(runtimeReject.allowed).toBe(false);
  });

  it("register does not validate — caller must check maySpawn first", () => {
    const allowlist = new Set(["allowed"]);
    const registry = createAncestryRegistry(2, allowlist);

    // register succeeds even for disallowed spawns
    const record = registry.register("illegal", "blocked-parent", 99);
    expect(record.childId).toBe("illegal");
    expect(record.depth).toBe(99);

    // But maySpawn would reject it
    const check = registry.maySpawn(99, "blocked-parent");
    expect(check.allowed).toBe(false);
  });

  it("getAncestryChain ordering: first element is the target child", () => {
    const registry = createAncestryRegistry();
    registry.register("grandparent", ROOT_PARENT_ID, 0);
    registry.register("parent", "grandparent", 1);
    registry.register("child", "parent", 2);

    // Walking from child: [child_record, parent_record, grandparent_record]
    const chain = registry.getAncestryChain("child");
    expect(chain).toHaveLength(3);
    expect(chain[0]?.childId).toBe("child");
    expect(chain[0]?.depth).toBe(2);
    expect(chain[1]?.childId).toBe("parent");
    expect(chain[1]?.depth).toBe(1);
    expect(chain[2]?.childId).toBe("grandparent");
    expect(chain[2]?.depth).toBe(0);

    // Walking from parent: [parent_record, grandparent_record]
    const parentChain = registry.getAncestryChain("parent");
    expect(parentChain).toHaveLength(2);
    expect(parentChain[0]?.childId).toBe("parent");
    expect(parentChain[1]?.childId).toBe("grandparent");

    // Walking from grandparent: [grandparent_record] only
    const gpChain = registry.getAncestryChain("grandparent");
    expect(gpChain).toHaveLength(1);
    expect(gpChain[0]?.childId).toBe("grandparent");
  });
});