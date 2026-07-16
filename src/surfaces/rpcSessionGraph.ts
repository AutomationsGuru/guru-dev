import type { AgentSession } from "../session/agentSession.js";

const MAX_RPC_SESSION_NODES = 64;

export interface RpcForkSession {
  readonly sessionId: string;
  readonly session: AgentSession;
  /** Roll back a newly created live session when registration fails. */
  readonly close?: () => Promise<void>;
}

export type RpcForkSessionFactory = () => Promise<RpcForkSession>;

export interface RpcSessionGraphNode {
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly forkHistoryIndex: number | null;
  readonly historyLength: number;
  readonly childSessionIds: readonly string[];
  readonly active: boolean;
}

export interface RpcSessionGraphTree {
  readonly activeSessionId: string;
  readonly nodes: readonly RpcSessionGraphNode[];
}

export interface RpcForkResult {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly copiedHistoryLength: number;
}

export interface RpcSessionGraph {
  readonly activeSessionId: string;
  readonly activeSession: AgentSession;
  tree(): RpcSessionGraphTree;
  fork(options: { readonly parentSessionId?: string; readonly throughHistoryIndex: number }): Promise<RpcForkResult>;
  switchSession(sessionId: string): { readonly sessionId: string };
  withActiveTurn<T>(run: (session: AgentSession) => Promise<T>): Promise<T>;
  subscribeActiveSession(listener: (sessionId: string, session: AgentSession) => void): () => void;
}

interface InternalNode {
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly forkHistoryIndex: number | null;
  readonly session: AgentSession;
  readonly childSessionIds: string[];
}

class InMemoryRpcSessionGraph implements RpcSessionGraph {
  private readonly nodes = new Map<string, InternalNode>();
  private readonly activeListeners = new Set<(sessionId: string, session: AgentSession) => void>();
  private readonly sessionsWithRunningTurn = new Set<string>();
  private currentSessionId: string;

  constructor(
    rootSessionId: string,
    rootSession: AgentSession,
    private readonly createForkSession?: RpcForkSessionFactory
  ) {
    if (rootSessionId.trim().length === 0) {
      throw new Error("RPC session graph: root session id is required.");
    }
    this.currentSessionId = rootSessionId;
    this.nodes.set(rootSessionId, {
      sessionId: rootSessionId,
      parentSessionId: null,
      forkHistoryIndex: null,
      session: rootSession,
      childSessionIds: []
    });
  }

  get activeSessionId(): string {
    return this.currentSessionId;
  }

  get activeSession(): AgentSession {
    return this.requireNode(this.currentSessionId).session;
  }

  tree(): RpcSessionGraphTree {
    return {
      activeSessionId: this.currentSessionId,
      nodes: [...this.nodes.values()].map((node) => ({
        sessionId: node.sessionId,
        parentSessionId: node.parentSessionId,
        forkHistoryIndex: node.forkHistoryIndex,
        historyLength: node.session.history.length,
        childSessionIds: [...node.childSessionIds],
        active: node.sessionId === this.currentSessionId
      }))
    };
  }

  async fork(options: { readonly parentSessionId?: string; readonly throughHistoryIndex: number }): Promise<RpcForkResult> {
    const parentSessionId = options.parentSessionId ?? this.currentSessionId;
    const parent = this.nodes.get(parentSessionId);
    if (!parent) {
      throw new Error("RPC session graph: unknown parent session.");
    }
    const historyIndex = options.throughHistoryIndex;
    if (
      !Number.isInteger(historyIndex) ||
      historyIndex < 0 ||
      historyIndex >= parent.session.history.length ||
      parent.session.history[historyIndex]?.role !== "user"
    ) {
      throw new Error("RPC session graph: throughHistoryIndex must identify an existing user message.");
    }
    if (this.sessionsWithRunningTurn.has(parentSessionId)) {
      throw new Error("RPC session graph: parent session has a running turn.");
    }
    if (this.sessionsWithRunningTurn.has(this.currentSessionId)) {
      throw new Error("RPC session graph: active session has a running turn.");
    }
    if (this.nodes.size >= MAX_RPC_SESSION_NODES) {
      throw new Error("RPC session graph: session limit reached.");
    }
    if (!this.createForkSession) {
      throw new Error("RPC session graph: forking is unsupported without a fork-session factory.");
    }

    let created: RpcForkSession;
    try {
      created = await this.createForkSession();
    } catch {
      throw new Error("RPC session graph: fork session factory failed.");
    }

    if (created.sessionId.trim().length === 0) {
      await this.rollback(created);
      throw new Error("RPC session graph: fork session factory failed.");
    }
    if (this.nodes.has(created.sessionId)) {
      await this.rollback(created);
      throw new Error("RPC session graph: fork session id is already registered.");
    }
    if ([...this.nodes.values()].some((node) => node.session === created.session)) {
      await this.rollback(created);
      throw new Error("RPC session graph: fork factory must return a distinct session.");
    }

    let copiedHistoryLength: number;
    try {
      const historyCopy = parent.session.history
        .slice(0, historyIndex + 1)
        .map((message) => ({ role: message.role, content: message.content }));
      created.session.history.splice(0, created.session.history.length, ...historyCopy);
      copiedHistoryLength = historyCopy.length;
    } catch {
      await this.rollback(created);
      throw new Error("RPC session graph: fork session registration failed.");
    }

    const child: InternalNode = {
      sessionId: created.sessionId,
      parentSessionId,
      forkHistoryIndex: historyIndex,
      session: created.session,
      childSessionIds: []
    };
    this.nodes.set(created.sessionId, child);
    parent.childSessionIds.push(created.sessionId);
    this.currentSessionId = created.sessionId;
    this.notifyActive(child);
    return {
      sessionId: created.sessionId,
      parentSessionId,
      copiedHistoryLength
    };
  }

  switchSession(sessionId: string): { readonly sessionId: string } {
    const target = this.nodes.get(sessionId);
    if (!target) {
      throw new Error("RPC session graph: unknown session.");
    }
    if (this.sessionsWithRunningTurn.has(this.currentSessionId)) {
      throw new Error("RPC session graph: active session has a running turn.");
    }
    if (this.sessionsWithRunningTurn.has(sessionId)) {
      throw new Error("RPC session graph: target session has a running turn.");
    }
    if (sessionId !== this.currentSessionId) {
      this.currentSessionId = sessionId;
      this.notifyActive(target);
    }
    return { sessionId };
  }

  async withActiveTurn<T>(run: (session: AgentSession) => Promise<T>): Promise<T> {
    const node = this.requireNode(this.currentSessionId);
    if (this.sessionsWithRunningTurn.has(node.sessionId)) {
      throw new Error("RPC session graph: active session has a running turn.");
    }
    this.sessionsWithRunningTurn.add(node.sessionId);
    try {
      return await run(node.session);
    } finally {
      this.sessionsWithRunningTurn.delete(node.sessionId);
    }
  }

  subscribeActiveSession(listener: (sessionId: string, session: AgentSession) => void): () => void {
    this.activeListeners.add(listener);
    return () => {
      this.activeListeners.delete(listener);
    };
  }

  private requireNode(sessionId: string): InternalNode {
    const node = this.nodes.get(sessionId);
    if (!node) {
      throw new Error("RPC session graph: unknown session.");
    }
    return node;
  }

  private notifyActive(node: InternalNode): void {
    for (const listener of this.activeListeners) {
      try {
        listener(node.sessionId, node.session);
      } catch {
        // A surface listener must not roll back an already-valid graph change.
      }
    }
  }

  private async rollback(created: RpcForkSession): Promise<void> {
    try {
      await created.close?.();
    } catch {
      // Preserve the bounded registration error instead of leaking close details.
    }
  }
}

export function createRpcSessionGraph(options: {
  readonly rootSessionId: string;
  readonly rootSession: AgentSession;
  readonly createForkSession?: RpcForkSessionFactory;
}): RpcSessionGraph {
  return new InMemoryRpcSessionGraph(options.rootSessionId, options.rootSession, options.createForkSession);
}
