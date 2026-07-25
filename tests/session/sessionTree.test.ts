import { describe, expect, it } from "vitest";

import {
  createSessionTree,
  createSessionTreeBuilder,
  findLeaves,
  getAncestors,
  listSessionTree,
  nearestCommonAncestor,
  pathToRoot,
  SessionTreeDuplicateIdError,
  SessionTreeNodeNotFoundError
} from '../../src/session/sessionTree.js';
import {
  buildSessionTreeFromForks,
  forkFromLeaf,
  navigateToNode
} from '../../src/session/sessionTreeFork.js';

describe("sessionTree", () => {
  it("creates a single-root tree", () => {
    const tree = createSessionTree("Root session", "root-1");
    expect(tree.rootId).toBe("root-1");
    expect(tree.nodes.size).toBe(1);
    const root = tree.nodes.get("root-1")!;
    expect(root.parentId).toBeNull();
    expect(root.children).toEqual([]);
    expect(root.label).toBe("Root session");
  });

  it("adds children to a parent and lists them depth-first", () => {
    const builder = createSessionTreeBuilder();
    builder.createRoot({ id: "root", label: "root" });
    builder.createNode({ id: "a", parentId: "root", label: "a" });
    builder.createNode({ id: "b", parentId: "root", label: "b" });
    builder.createNode({ id: "c", parentId: "a", label: "c" });
    const tree = builder.build();

    const listed = listSessionTree(tree);
    expect(listed.map((n) => n.id)).toEqual(["root", "a", "c", "b"]);
  });

  it("throws when a parent is missing", () => {
    const builder = createSessionTreeBuilder();
    builder.createRoot({ label: "root" });
    expect(() => builder.createNode({ id: "x", parentId: "missing", label: "x" })).toThrow(
      SessionTreeNodeNotFoundError
    );
  });

  it("throws on duplicate ids", () => {
    const builder = createSessionTreeBuilder();
    builder.createRoot({ id: "root", label: "root" });
    expect(() => builder.createRoot({ id: "root", label: "root2" })).toThrow(SessionTreeDuplicateIdError);
    expect(() => builder.createNode({ id: "root", parentId: "root", label: "x" })).toThrow(
      SessionTreeDuplicateIdError
    );
  });

  it("computes path to root and ancestors", () => {
    const builder = createSessionTreeBuilder();
    builder.createRoot({ id: "root", label: "root" });
    builder.createNode({ id: "a", parentId: "root", label: "a" });
    builder.createNode({ id: "b", parentId: "a", label: "b" });
    const tree = builder.build();

    expect(pathToRoot(tree, "b")).toEqual(["root", "a", "b"]);
    expect(getAncestors(tree, "b").map((n) => n.id)).toEqual(["root", "a"]);
    expect(pathToRoot(tree, "root")).toEqual(["root"]);
    expect(getAncestors(tree, "root")).toEqual([]);
  });

  it("finds leaves", () => {
    const builder = createSessionTreeBuilder();
    builder.createRoot({ id: "root", label: "root" });
    builder.createNode({ id: "a", parentId: "root", label: "a" });
    builder.createNode({ id: "b", parentId: "root", label: "b" });
    builder.createNode({ id: "c", parentId: "a", label: "c" });
    const tree = builder.build();

    expect(findLeaves(tree).map((n) => n.id)).toEqual(["c", "b"]);
  });

  it("finds nearest common ancestor", () => {
    const builder = createSessionTreeBuilder();
    builder.createRoot({ id: "root", label: "root" });
    builder.createNode({ id: "a", parentId: "root", label: "a" });
    builder.createNode({ id: "b", parentId: "a", label: "b" });
    builder.createNode({ id: "c", parentId: "a", label: "c" });
    const tree = builder.build();

    expect(nearestCommonAncestor(tree, "b", "c")?.id).toBe("a");
    expect(nearestCommonAncestor(tree, "root", "b")?.id).toBe("root");
  });

  it("fork on the builder attaches a checkpoint child", () => {
    const builder = createSessionTreeBuilder();
    builder.createRoot({ id: "root", label: "root" });
    const branch = builder.fork({
      fromId: "root",
      id: "branch-1",
      label: "Branch 1",
      createdAt: "2026-07-18T00:00:00.000Z",
      checkpoint: "explore"
    });
    const tree = builder.build();

    expect(branch.parentId).toBe("root");
    expect(branch.checkpoint).toBe("explore");
    expect(tree.nodes.get("root")?.children).toEqual(["branch-1"]);
    expect(pathToRoot(tree, "branch-1")).toEqual(["root", "branch-1"]);
  });
});

describe("sessionTreeFork", () => {
  it("forks from a leaf with isolation from the original tree", () => {
    const tree = createSessionTree("Main", "main");
    const builder = createSessionTreeBuilder();
    builder.createRoot({ id: tree.rootId, label: "Main" });
    builder.createNode({ id: "turn-1", parentId: "main", label: "turn 1", createdAt: "2026-07-18T00:00:00.000Z" });
    const base = builder.build();

    const { tree: forked, branch } = forkFromLeaf({
      tree: base,
      leafId: "turn-1",
      id: "branch-a",
      label: "Branch A",
      createdAt: "2026-07-18T00:01:00.000Z",
      checkpoint: "explore option A"
    });

    expect(branch.parentId).toBe("turn-1");
    expect(branch.label).toBe("Branch A");
    expect(branch.checkpoint).toBe("explore option A");
    expect(forked.nodes.get("turn-1")?.children).toEqual(["branch-a"]);
    expect(pathToRoot(forked, "branch-a")).toEqual(["main", "turn-1", "branch-a"]);

    // Isolation: original tree is untouched.
    expect(base.nodes.get("turn-1")?.children).toEqual([]);
    expect(base.nodes.has("branch-a")).toBe(false);
  });

  it("forks from the first leaf when leafId is omitted", () => {
    const builder = createSessionTreeBuilder();
    builder.createRoot({ id: "root", label: "root" });
    builder.createNode({ id: "leaf", parentId: "root", label: "leaf" });
    const tree = builder.build();

    const { branch } = forkFromLeaf({ tree, label: "new branch" });
    expect(branch.parentId).toBe("leaf");
  });

  it("builds a tree from fork descriptors", () => {
    const tree = buildSessionTreeFromForks({
      rootLabel: "Home",
      rootId: "home",
      branches: [
        { id: "b1", parentId: "home", label: "Branch 1", createdAt: "t1", checkpoint: "c1" },
        { id: "b2", parentId: "b1", label: "Branch 2", createdAt: "t2", checkpoint: "c2" }
      ]
    });

    expect(tree.rootId).toBe("home");
    expect(listSessionTree(tree).map((n) => n.id)).toEqual(["home", "b1", "b2"]);
    const b2 = tree.nodes.get("b2")!;
    expect(b2.parentId).toBe("b1");
    expect(b2.checkpoint).toBe("c2");
  });

  it("navigateToNode returns path, siblings, children and move flags", () => {
    const builder = createSessionTreeBuilder();
    builder.createRoot({ id: "root", label: "root" });
    builder.createNode({ id: "a", parentId: "root", label: "a" });
    builder.createNode({ id: "b", parentId: "root", label: "b" });
    builder.createNode({ id: "c", parentId: "a", label: "c" });
    const tree = builder.build();

    const nav = navigateToNode(tree, "a");
    expect(nav.current.id).toBe("a");
    expect(nav.path.map((n) => n.id)).toEqual(["root"]);
    expect(nav.siblings.map((n) => n.id)).toEqual(["b"]);
    expect(nav.children.map((n) => n.id)).toEqual(["c"]);
    expect(nav.canGoUp).toBe(true);
    expect(nav.canGoDown).toBe(true);
    expect(nav.canGoToSibling).toBe(true);
  });

  it("navigateToNode at root has no up/sibling moves", () => {
    const tree = createSessionTree("Root", "root");
    const nav = navigateToNode(tree, "root");
    expect(nav.path).toEqual([]);
    expect(nav.siblings).toEqual([]);
    expect(nav.canGoUp).toBe(false);
    expect(nav.canGoDown).toBe(false);
    expect(nav.canGoToSibling).toBe(false);
  });
});
