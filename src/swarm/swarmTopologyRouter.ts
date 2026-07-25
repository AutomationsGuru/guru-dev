/**
 * Swarm topology router (IDEA-F516-ROUTER-01 / R-SW-ROUTER).
 *
 * Pure dispatch table over four swarm topologies: sequential, concurrent,
 * mixture-of-agents (moa), and directed graph. Callers supply agents with a
 * minimal `{ id, run }` surface; this module only sequences their runs and
 * aggregates outputs — no I/O, no scheduler, no framework, no new deps.
 *
 * Unknown topology types fail closed with a structured error. Graph cycles and
 * unknown edge endpoints also fail closed with structured errors.
 */

// ---------------------------------------------------------------------------
// Topology types
// ---------------------------------------------------------------------------

/** Canonical list of supported swarm topology kinds. */
export const SWARM_TOPOLOGY_TYPES = ["sequential", "concurrent", "moa", "graph"] as const;

/** Union of supported swarm topology kinds. */
export type SwarmTopologyType = (typeof SWARM_TOPOLOGY_TYPES)[number];

/** Type guard: true when `value` is a known {@link SwarmTopologyType}. */
export function isSwarmTopologyType(value: string): value is SwarmTopologyType {
  return (SWARM_TOPOLOGY_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Structured errors
// ---------------------------------------------------------------------------

/** Thrown when `runTopology` is called with an unsupported topology type. */
export class UnknownSwarmTopologyError extends Error {
  readonly code = "unknown_swarm_topology";
  constructor(readonly type: string) {
    super(`Unknown swarm topology type: "${type}"`);
    this.name = "UnknownSwarmTopologyError";
  }
}

/** Thrown when a graph topology contains a cycle (Kahn residual). */
export class SwarmTopologyGraphCycleError extends Error {
  readonly code = "swarm_topology_graph_cycle";
  constructor(message = "Swarm topology graph contains a cycle") {
    super(message);
    this.name = "SwarmTopologyGraphCycleError";
  }
}

/**
 * Thrown when a graph edge references an agent id that is not present in the
 * supplied agents array.
 */
export class SwarmTopologyGraphValidationError extends Error {
  readonly code = "swarm_topology_graph_validation";
  constructor(
    message: string,
    /** The unknown agent id that triggered the error. */
    readonly agent: string
  ) {
    super(message);
    this.name = "SwarmTopologyGraphValidationError";
  }
}

// ---------------------------------------------------------------------------
// Agent / result types
// ---------------------------------------------------------------------------

/** Minimal agent surface consumed by the topology router. */
export interface SwarmTopologyAgent {
  readonly id: string;
  run(input: string): Promise<string> | string;
}

/** One agent's collected output. */
export interface SwarmTopologyAgentOutput {
  readonly agentId: string;
  readonly text: string;
}

/** Aggregate result of a topology run. */
export interface SwarmTopologyResult {
  readonly type: SwarmTopologyType;
  readonly outputs: readonly SwarmTopologyAgentOutput[];
  readonly text: string;
}

/** Optional knobs for topology dispatch (currently graph edges only). */
export interface SwarmTopologyOptions {
  /**
   * Directed edges for the `graph` topology. Absent or empty → linear
   * sequential fallback over the agents array order.
   */
  readonly edges?: readonly { readonly from: string; readonly to: string }[];
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Run `agents` under the named topology against `task`.
 *
 * - Unknown `type` → throws {@link UnknownSwarmTopologyError} (fail closed).
 * - Empty `agents` → `{ type, outputs: [], text: "" }` (no throw).
 * - Otherwise dispatches to the matching pure runner below.
 */
export async function runTopology(
  type: string,
  agents: readonly SwarmTopologyAgent[],
  task: string,
  options?: SwarmTopologyOptions
): Promise<SwarmTopologyResult> {
  if (!isSwarmTopologyType(type)) {
    throw new UnknownSwarmTopologyError(type);
  }

  if (agents.length === 0) {
    return { type, outputs: [], text: "" };
  }

  switch (type) {
    case "sequential":
      return runSequential(agents, task);
    case "concurrent":
      return runConcurrent(agents, task);
    case "moa":
      return runMoa(agents, task);
    case "graph":
      return runGraph(agents, task, options?.edges);
  }
}

// ---------------------------------------------------------------------------
// Topology runners
// ---------------------------------------------------------------------------

/** sequential: chain agents; each subsequent agent receives the previous text. */
async function runSequential(
  agents: readonly SwarmTopologyAgent[],
  task: string
): Promise<SwarmTopologyResult> {
  const outputs: SwarmTopologyAgentOutput[] = [];
  let input = task;

  for (const agent of agents) {
    const text = await Promise.resolve(agent.run(input));
    outputs.push({ agentId: agent.id, text });
    input = text;
  }

  const last = outputs[outputs.length - 1];
  return {
    type: "sequential",
    outputs,
    text: last ? last.text : ""
  };
}

/** concurrent: all agents receive the same task in parallel. */
async function runConcurrent(
  agents: readonly SwarmTopologyAgent[],
  task: string
): Promise<SwarmTopologyResult> {
  const texts = await Promise.all(agents.map((agent) => Promise.resolve(agent.run(task))));
  const outputs: SwarmTopologyAgentOutput[] = agents.map((agent, i) => ({
    agentId: agent.id,
    text: texts[i]!
  }));

  return {
    type: "concurrent",
    outputs,
    text: outputs.map((o) => o.text).join("\n\n")
  };
}

/**
 * moa (mixture-of-agents):
 * - 1 agent → single expert (run with task).
 * - 2+ → all but last run concurrent as experts; last aggregates
 *   `"Task: …\n\nExpert outputs:\n[id]: text\n…"`.
 */
async function runMoa(
  agents: readonly SwarmTopologyAgent[],
  task: string
): Promise<SwarmTopologyResult> {
  if (agents.length === 1) {
    const agent = agents[0]!;
    const text = await Promise.resolve(agent.run(task));
    return {
      type: "moa",
      outputs: [{ agentId: agent.id, text }],
      text
    };
  }

  const experts = agents.slice(0, -1);
  const aggregator = agents[agents.length - 1]!;

  const expertTexts = await Promise.all(experts.map((a) => Promise.resolve(a.run(task))));
  const expertOutputs: SwarmTopologyAgentOutput[] = experts.map((agent, i) => ({
    agentId: agent.id,
    text: expertTexts[i]!
  }));

  const aggregatorInput =
    `Task: ${task}\n\nExpert outputs:\n` +
    expertOutputs.map((o) => `[${o.agentId}]: ${o.text}`).join("\n");

  const aggregatorText = await Promise.resolve(aggregator.run(aggregatorInput));
  const outputs: SwarmTopologyAgentOutput[] = [
    ...expertOutputs,
    { agentId: aggregator.id, text: aggregatorText }
  ];

  return {
    type: "moa",
    outputs,
    text: aggregatorText
  };
}

/**
 * graph: Kahn-wave execution over directed edges.
 * - No/empty edges → sequential fallback.
 * - Within a wave, agents run concurrent.
 * - Node input is `task` if no predecessors among agents, else predecessor
 *   outputs joined with `"\n\n"`.
 * - Equal-indegree ties preserve agents-array order.
 * - Final outputs ordered by original agents array.
 * - Cycle → {@link SwarmTopologyGraphCycleError}.
 * - Unknown edge endpoint → {@link SwarmTopologyGraphValidationError}.
 */
async function runGraph(
  agents: readonly SwarmTopologyAgent[],
  task: string,
  edges: readonly { readonly from: string; readonly to: string }[] | undefined
): Promise<SwarmTopologyResult> {
  if (!edges || edges.length === 0) {
    // Linear fallback: same behavior as sequential, typed as graph.
    const sequential = await runSequential(agents, task);
    return { type: "graph", outputs: sequential.outputs, text: sequential.text };
  }

  const agentById = new Map<string, SwarmTopologyAgent>();
  const agentIndex = new Map<string, number>();
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i]!;
    agentById.set(agent.id, agent);
    agentIndex.set(agent.id, i);
  }

  // Validate endpoints and build adjacency + indegree.
  const successors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  const indegree = new Map<string, number>();

  for (const agent of agents) {
    successors.set(agent.id, []);
    predecessors.set(agent.id, []);
    indegree.set(agent.id, 0);
  }

  for (const edge of edges) {
    if (!agentById.has(edge.from)) {
      throw new SwarmTopologyGraphValidationError(
        `Unknown agent "${edge.from}" in graph edge`,
        edge.from
      );
    }
    if (!agentById.has(edge.to)) {
      throw new SwarmTopologyGraphValidationError(
        `Unknown agent "${edge.to}" in graph edge`,
        edge.to
      );
    }
    // Self-loops and multi-edges still count toward indegree / cycle detection.
    successors.get(edge.from)!.push(edge.to);
    predecessors.get(edge.to)!.push(edge.from);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  // Kahn: seed ready queue with indegree-0 agents, stable by original order.
  const remaining = new Map(indegree);
  const ready = agents
    .filter((a) => (remaining.get(a.id) ?? 0) === 0)
    .map((a) => a.id);

  const textById = new Map<string, string>();
  let processed = 0;

  while (ready.length > 0) {
    // Current wave = all currently ready nodes (run concurrent).
    // ready is already in agents-array order (seeded sorted; appends maintain
    // relative order only among newly unlocked — re-sort each wave for ties).
    ready.sort((a, b) => (agentIndex.get(a) ?? 0) - (agentIndex.get(b) ?? 0));
    const wave = ready.splice(0, ready.length);

    const waveInputs = wave.map((id) => {
      const preds = predecessors.get(id) ?? [];
      // Unique predecessors, stable by original agents-array order.
      const uniquePreds = [...new Set(preds)].sort(
        (a, b) => (agentIndex.get(a) ?? 0) - (agentIndex.get(b) ?? 0)
      );
      const predTexts = uniquePreds
        .filter((p) => textById.has(p))
        .map((p) => textById.get(p)!);
      // No predecessors among agents → seed with the original task.
      if (predTexts.length === 0) {
        return task;
      }
      return predTexts.join("\n\n");
    });

    const waveTexts = await Promise.all(
      wave.map((id, i) => Promise.resolve(agentById.get(id)!.run(waveInputs[i]!)))
    );

    for (let i = 0; i < wave.length; i++) {
      const id = wave[i]!;
      textById.set(id, waveTexts[i]!);
      processed += 1;

      for (const succ of successors.get(id) ?? []) {
        const next = (remaining.get(succ) ?? 0) - 1;
        remaining.set(succ, next);
        if (next === 0) {
          ready.push(succ);
        }
      }
    }
  }

  if (processed !== agents.length) {
    throw new SwarmTopologyGraphCycleError();
  }

  // Outputs in original agents-array order.
  const outputs: SwarmTopologyAgentOutput[] = agents.map((agent) => ({
    agentId: agent.id,
    text: textById.get(agent.id) ?? ""
  }));

  // Final text: last agent in original array order (stable, matches sequential
  // fallback when the graph is linear). If that feels arbitrary for DAGs, it
  // still gives a deterministic non-empty aggregation surface.
  const last = outputs[outputs.length - 1];
  return {
    type: "graph",
    outputs,
    text: last ? last.text : ""
  };
}
