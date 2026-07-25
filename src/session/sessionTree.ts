/**
 * SessionTree — shared-core session-tree primitives (Session Tree / F23).
 *
 * A lightweight, in-memory tree model for session lineage: every node has an id,
 * an optional parent, an ordered list of children, a display label, and a
 * creation timestamp. `fork` creates a new branch node pointing back at the
 * source node as a checkpoint. `list` and `pathToRoot` provide the two traversal
 * helpers every caller (TUI, RPC, tests) needs without importing TUI or RPC code.
 *
 * This is the honest shared core: it does not render, persist, or wire into any
 * surface. Surfaces compose with it by building a tree from their own source
 * of truth and calling these helpers.
 *
 * Distinct from `src/guru/sessionTree.ts`, which models a single session's
 * message chain for `/tree` / `/fork <n>` rendering. This module owns abstract
 * session-lineage trees that both TUI and RPC can share.
 */

export interface SessionTreeNode {
  readonly id: string;
  /** Parent node id; `null` for the root. */
  readonly parentId: string | null;
  /** Ordered child ids. */
  readonly children: readonly string[];
  /** Display label for the node (session title, turn summary, etc.). */
  readonly label: string;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** Optional checkpoint note for fork nodes. */
  readonly checkpoint?: string;
}

export interface SessionTree {
  readonly rootId: string;
  readonly nodes: ReadonlyMap<string, SessionTreeNode>;
}

export interface CreateNodeOptions {
  readonly id?: string | undefined;
  readonly parentId?: string | null | undefined;
  readonly label: string;
  readonly createdAt?: string | undefined;
  readonly checkpoint?: string | undefined;
}

export interface ForkOptions {
  /** Id of the node to fork from. */
  readonly fromId: string;
  /** Optional id for the new node; a random id is generated if omitted. */
  readonly id?: string | undefined;
  /** Label for the new branch. */
  readonly label: string;
  /** ISO-8601 creation timestamp; defaults to now. */
  readonly createdAt?: string | undefined;
  /** Optional checkpoint note describing the fork point. */
  readonly checkpoint?: string | undefined;
}

/** Error raised when a tree operation references a node that does not exist. */
export class SessionTreeNodeNotFoundError extends Error {
  constructor(readonly nodeId: string) {
    super(`SessionTree node not found: ${nodeId}`);
    this.name = "SessionTreeNodeNotFoundError";
  }
}

/** Error raised when a duplicate node id is inserted. */
export class SessionTreeDuplicateIdError extends Error {
  constructor(readonly nodeId: string) {
    super(`SessionTree duplicate node id: ${nodeId}`);
    this.name = "SessionTreeDuplicateIdError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

let _idCounter = 0;
function generateId(): string {
  _idCounter += 1;
  return `node-${Date.now().toString(36)}-${_idCounter.toString(36)}`;
}

/** Internal mutable builder used to construct and mutate a tree. */
class SessionTreeBuilder {
  private readonly nodes = new Map<string, SessionTreeNode>();
  private rootId: string | null = null;

  getNode(id: string): SessionTreeNode | undefined {
    return this.nodes.get(id);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  createRoot(options: Omit<CreateNodeOptions, "parentId">): SessionTreeNode {
    const id = options.id ?? generateId();
    if (this.nodes.has(id)) throw new SessionTreeDuplicateIdError(id);
    const base: SessionTreeNode = {
      id,
      parentId: null,
      children: [],
      label: options.label,
      createdAt: options.createdAt ?? nowIso()
    };
    const node = options.checkpoint !== undefined ? { ...base, checkpoint: options.checkpoint } : base;
    this.nodes.set(id, node);
    this.rootId = id;
    return node;
  }

  createNode(options: CreateNodeOptions): SessionTreeNode {
    const parentId = options.parentId ?? null;
    const id = options.id ?? generateId();
    if (this.nodes.has(id)) throw new SessionTreeDuplicateIdError(id);

    if (parentId !== null && !this.nodes.has(parentId)) {
      throw new SessionTreeNodeNotFoundError(parentId);
    }

    const base: SessionTreeNode = {
      id,
      parentId,
      children: [],
      label: options.label,
      createdAt: options.createdAt ?? nowIso()
    };
    const node = options.checkpoint !== undefined ? { ...base, checkpoint: options.checkpoint } : base;
    this.nodes.set(id, node);

    if (parentId !== null) {
      const parent = this.nodes.get(parentId)!;
      this.nodes.set(parentId, { ...parent, children: [...parent.children, id] });
    } else if (this.rootId === null) {
      this.rootId = id;
    }

    return node;
  }

  /**
   * Fork a new branch from `fromId`. The new node is a child of the source node
   * and carries a checkpoint pointer (default: `"forked from <id>"`).
   * Returns the new branch node; the builder remains mutable until `build()`.
   */
  fork(options: ForkOptions): SessionTreeNode {
    const fromNode = this.nodes.get(options.fromId);
    if (fromNode === undefined) throw new SessionTreeNodeNotFoundError(options.fromId);

    const checkpoint = options.checkpoint ?? `forked from ${fromNode.id}`;
    return this.createNode({
      id: options.id,
      parentId: options.fromId,
      label: options.label,
      createdAt: options.createdAt,
      checkpoint
    });
  }

  build(): SessionTree {
    if (this.rootId === null) throw new Error("SessionTree has no root");
    return {
      rootId: this.rootId,
      // Fresh Map so callers cannot mutate the builder's internal store through the freeze.
      nodes: new Map(this.nodes)
    };
  }
}

/** Create a tree builder. Use `builder.build()` to freeze to a {@link SessionTree}. */
export function createSessionTreeBuilder(): SessionTreeBuilder {
  return new SessionTreeBuilder();
}

/** Convenience: build a single-root tree from a root label. */
export function createSessionTree(rootLabel: string, rootId?: string): SessionTree {
  const builder = createSessionTreeBuilder();
  builder.createRoot({ id: rootId, label: rootLabel });
  return builder.build();
}

/** List every node in the tree, depth-first from the root (pre-order, children left-to-right). */
export function listSessionTree(tree: SessionTree): readonly SessionTreeNode[] {
  const result: SessionTreeNode[] = [];
  const stack = [tree.rootId];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = tree.nodes.get(id);
    if (node === undefined) continue;
    result.push(node);
    // Push children in reverse so they are processed in original order.
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const childId = node.children[i];
      if (childId !== undefined) stack.push(childId);
    }
  }
  return result;
}

/** Return ids from root down to `nodeId` (inclusive), root first. */
export function pathToRoot(tree: SessionTree, nodeId: string): readonly string[] {
  const path: string[] = [];
  let current: string | null = nodeId;
  const seen = new Set<string>();
  while (current !== null) {
    if (seen.has(current)) throw new Error(`SessionTree cycle detected at ${current}`);
    seen.add(current);
    const node = tree.nodes.get(current);
    if (node === undefined) throw new SessionTreeNodeNotFoundError(current);
    path.unshift(current);
    current = node.parentId;
  }
  return path;
}

/**
 * Return all ancestors of `nodeId`, root first, excluding `nodeId` itself.
 * Empty for the root.
 */
export function getAncestors(tree: SessionTree, nodeId: string): readonly SessionTreeNode[] {
  const path = pathToRoot(tree, nodeId);
  // path is root-first inclusive of nodeId; drop the last entry (self).
  const ancestorIds = path.slice(0, -1);
  return ancestorIds.map((id) => {
    const node = tree.nodes.get(id);
    if (node === undefined) throw new SessionTreeNodeNotFoundError(id);
    return node;
  });
}

/** Find the nearest common ancestor of two node ids, or `null` if none. */
export function nearestCommonAncestor(tree: SessionTree, aId: string, bId: string): SessionTreeNode | null {
  const aPath = new Set(pathToRoot(tree, aId));
  const bPath = pathToRoot(tree, bId);
  for (let i = bPath.length - 1; i >= 0; i -= 1) {
    const id = bPath[i];
    if (id === undefined) continue;
    if (aPath.has(id)) {
      const node = tree.nodes.get(id);
      if (node !== undefined) return node;
    }
  }
  return null;
}

/** Find all leaf nodes (nodes with no children), depth-first order. */
export function findLeaves(tree: SessionTree): readonly SessionTreeNode[] {
  return listSessionTree(tree).filter((node) => node.children.length === 0);
}
