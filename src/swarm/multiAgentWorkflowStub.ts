/**
 * Multi-agent workflow stub — a directed graph of named agents with edges.
 *
 * Pure routing helper for swarm orchestration: defines which agents can hand
 * off to which next agents in a multi-step workflow. Immutable-style builder:
 * each addAgent / addEdge returns a new workflow, leaving the original intact.
 *
 * Maps to the MAF "multi-agent workflows (framework-level)" concept (K13)
 * as a Guru-native ENHANCE — no MAF rehost.
 */

export interface MultiAgentWorkflow {
  /** All agent names registered in the graph. */
  readonly agentNames: ReadonlySet<string>;
  /** All directed edges as [from, to] pairs, in insertion order. */
  readonly edges: ReadonlyArray<readonly [string, string]>;

  /**
   * Pure routing helper: returns the names of agents that immediately follow
   * the named agent, in edge-insertion order. Returns an empty array for
   * unknown agent names and for terminal agents with no outgoing edges.
   */
  nextAgents(from: string): string[];

  /** Add an agent node. Idempotent — adding the same name twice has no effect. */
  addAgent(name: string): MultiAgentWorkflow;

  /** Add a directed edge from one agent to another. Auto-registers unknown
   *  agent names. Idempotent for duplicate edges. */
  addEdge(from: string, to: string): MultiAgentWorkflow;
}

// ── internal helpers ─────────────────────────────────────────────────────

interface WorkflowState {
  readonly agents: Set<string>;
  readonly edgeList: Array<readonly [string, string]>;
  readonly edgeKeys: Set<string>;
  readonly adjacency: Map<string, string[]>;
}

function copyState(state: WorkflowState): WorkflowState {
  return {
    agents: new Set(state.agents),
    edgeList: [...state.edgeList],
    edgeKeys: new Set(state.edgeKeys),
    adjacency: new Map(
      [...state.adjacency].map(([k, v]) => [k, [...v]])
    )
  };
}

function edgeKey(from: string, to: string): string {
  return `${from}→${to}`;
}

function buildWorkflow(state: WorkflowState): MultiAgentWorkflow {
  // Pre-compute the adjacency lookup for nextAgents so it's O(1) per call.
  // Build a frozen lookup from the adjacency map.
  const frozenAdjacency = new Map<string, readonly string[]>(
    [...state.adjacency].map(([k, v]) => [k, Object.freeze([...v])])
  );

  return {
    agentNames: new Set(state.agents),
    edges: Object.freeze([...state.edgeList]),

    nextAgents(from: string): string[] {
      const successors = frozenAdjacency.get(from);
      return successors ? [...successors] : [];
    },

    addAgent(name: string): MultiAgentWorkflow {
      const next = copyState(state);
      next.agents.add(name);
      return buildWorkflow(next);
    },

    addEdge(from: string, to: string): MultiAgentWorkflow {
      const next = copyState(state);
      const key = edgeKey(from, to);
      if (next.edgeKeys.has(key)) {
        return buildWorkflow(next); // idempotent — no change
      }
      next.edgeKeys.add(key);
      next.edgeList.push([from, to]);
      next.agents.add(from);
      next.agents.add(to);
      const existing = next.adjacency.get(from);
      if (existing) {
        existing.push(to);
      } else {
        next.adjacency.set(from, [to]);
      }
      return buildWorkflow(next);
    }
  };
}

// ── factory ───────────────────────────────────────────────────────────────

export function createMultiAgentWorkflow(
  agents: Iterable<string> = [],
  edges: Iterable<readonly [string, string]> = []
): MultiAgentWorkflow {
  const state: WorkflowState = {
    agents: new Set(agents),
    edgeList: [],
    edgeKeys: new Set(),
    adjacency: new Map()
  };

  for (const [from, to] of edges) {
    const key = edgeKey(from, to);
    if (state.edgeKeys.has(key)) continue;
    state.edgeKeys.add(key);
    state.edgeList.push([from, to]);
    state.agents.add(from);
    state.agents.add(to);
    const existing = state.adjacency.get(from);
    if (existing) {
      existing.push(to);
    } else {
      state.adjacency.set(from, [to]);
    }
  }

  return buildWorkflow(state);
}
