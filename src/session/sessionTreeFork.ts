/**
 * SessionTreeFork — higher-level fork helpers built on the shared session-tree
 * core (Session Tree / F23).
 *
 * These helpers bridge the gap between a low-level tree and the practical
 * "checkpoint + branch" model both TUI and RPC surfaces need. They are pure
 * functions: no I/O, no rendering, no persistence.
 */

import {
  createSessionTree,
  createSessionTreeBuilder,
  findLeaves,
  getAncestors,
  listSessionTree,
  nearestCommonAncestor,
  pathToRoot,
  type SessionTree,
  type SessionTreeNode
} from "./sessionTree.js";

export interface ForkBranchDescriptor {
  readonly id: string;
  readonly parentId: string;
  readonly label: string;
  readonly createdAt: string;
  readonly checkpoint: string;
}

export interface SessionTreeForkResult {
  readonly tree: SessionTree;
  readonly branch: SessionTreeNode;
}

export interface ForkFromLeafOptions {
  readonly tree: SessionTree;
  /** Leaf node to fork from; if omitted, the first leaf is used. */
  readonly leafId?: string | undefined;
  readonly label: string;
  readonly id?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly checkpoint?: string | undefined;
}

/**
 * Fork from a leaf node. This is the common primary-operator-path case where the
 * current conversation end becomes the start of a new branch. If `leafId` is
 * omitted, forks from the first leaf.
 *
 * Isolation: the input `tree` is not mutated. A new tree is returned that
 * shares structure only by value (nodes are rebuilt into a fresh builder).
 */
export function forkFromLeaf(options: ForkFromLeafOptions): SessionTreeForkResult {
  const leafId = options.leafId ?? findLeaves(options.tree)[0]?.id;
  if (leafId === undefined) {
    throw new Error("Cannot fork from leaf: tree has no leaves");
  }

  const builder = treeToBuilder(options.tree);
  const branch = builder.fork({
    fromId: leafId,
    id: options.id,
    label: options.label,
    createdAt: options.createdAt,
    checkpoint: options.checkpoint ?? `branch from leaf ${leafId}`
  });
  return { tree: builder.build(), branch };
}

export interface BuildSessionTreeFromForksOptions {
  readonly rootLabel: string;
  readonly rootId?: string;
  readonly rootCreatedAt?: string;
  readonly branches: readonly ForkBranchDescriptor[];
}

/**
 * Build a tree from a root and a list of fork descriptors. Descriptors are
 * applied in order; each `parentId` must refer to a node that already exists in
 * the tree (either the root or a previously applied branch).
 */
export function buildSessionTreeFromForks(options: BuildSessionTreeFromForksOptions): SessionTree {
  const builder = createSessionTreeBuilder();
  builder.createRoot({
    id: options.rootId,
    label: options.rootLabel,
    createdAt: options.rootCreatedAt
  });

  for (const branch of options.branches) {
    builder.fork({
      fromId: branch.parentId,
      id: branch.id,
      label: branch.label,
      createdAt: branch.createdAt,
      checkpoint: branch.checkpoint
    });
  }

  return builder.build();
}

export interface NavigateResult {
  readonly current: SessionTreeNode;
  /** Ancestors from root toward the parent of `current` (root first). */
  readonly path: readonly SessionTreeNode[];
  readonly siblings: readonly SessionTreeNode[];
  readonly children: readonly SessionTreeNode[];
  readonly canGoUp: boolean;
  readonly canGoDown: boolean;
  readonly canGoToSibling: boolean;
}

/**
 * Return everything a UI or RPC needs to render navigation around a node:
 * the node itself, its path to root (ancestors only, root first), its siblings,
 * its children, and booleans describing what moves are available.
 */
export function navigateToNode(tree: SessionTree, nodeId: string): NavigateResult {
  const current = tree.nodes.get(nodeId);
  if (current === undefined) {
    throw new Error(`Cannot navigate: node ${nodeId} not found`);
  }

  // getAncestors is root-first excluding self — that is the path for navigation.
  const path = getAncestors(tree, nodeId);
  const parent = current.parentId !== null ? tree.nodes.get(current.parentId) ?? null : null;
  const siblings = parent !== null
    ? parent.children
        .filter((id) => id !== current.id)
        .map((id) => tree.nodes.get(id))
        .filter((n): n is SessionTreeNode => n !== undefined)
    : [];
  const children = current.children
    .map((id) => tree.nodes.get(id))
    .filter((n): n is SessionTreeNode => n !== undefined);

  return {
    current,
    path,
    siblings,
    children,
    canGoUp: current.parentId !== null,
    canGoDown: children.length > 0,
    canGoToSibling: siblings.length > 0
  };
}

/** Reconstruct a mutable builder from an existing tree (deep copy by value). */
function treeToBuilder(tree: SessionTree): ReturnType<typeof createSessionTreeBuilder> {
  const builder = createSessionTreeBuilder();
  const root = tree.nodes.get(tree.rootId);
  if (root === undefined) {
    throw new Error("SessionTree root missing");
  }
  const rootOptions = {
    id: root.id,
    label: root.label,
    createdAt: root.createdAt,
    checkpoint: root.checkpoint
  };
  builder.createRoot(rootOptions);

  // BFS from root to recreate nodes in parent-first order.
  const queue = [...root.children];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) continue;
    const node = tree.nodes.get(id);
    if (node === undefined) continue;
    const parentId = node.parentId;
    if (parentId === null) continue;
    builder.createNode({
      id: node.id,
      parentId,
      label: node.label,
      createdAt: node.createdAt,
      checkpoint: node.checkpoint
    });
    queue.push(...node.children);
  }

  return builder;
}

export {
  createSessionTree,
  createSessionTreeBuilder,
  findLeaves,
  getAncestors,
  listSessionTree,
  nearestCommonAncestor,
  pathToRoot,
  type SessionTree,
  type SessionTreeNode
};
