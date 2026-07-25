import { describe, expect, it } from "vitest";

import { createMultiAgentWorkflow } from '../../src/swarm/multiAgentWorkflowStub.js';

describe("multiAgentWorkflowStub — graph of named agents with edges", () => {
  // ── construction ───────────────────────────────────────────────────────

  it("empty workflow has no agents and no edges", () => {
    const wf = createMultiAgentWorkflow();
    expect(wf.agentNames.size).toBe(0);
    expect(wf.edges.length).toBe(0);
  });

  it("can be constructed with initial agents", () => {
    const wf = createMultiAgentWorkflow(["planner", "coder"]);
    expect(wf.agentNames.size).toBe(2);
    expect(wf.agentNames.has("planner")).toBe(true);
    expect(wf.agentNames.has("coder")).toBe(true);
  });

  it("can be constructed with initial edges", () => {
    const wf = createMultiAgentWorkflow(
      ["planner", "coder"],
      [["planner", "coder"]]
    );
    expect(wf.edges.length).toBe(1);
    expect(wf.edges[0]).toEqual(["planner", "coder"]);
  });

  // ── addAgent ────────────────────────────────────────────────────────────

  it("addAgent registers a new agent name", () => {
    const wf = createMultiAgentWorkflow().addAgent("reviewer");
    expect(wf.agentNames.has("reviewer")).toBe(true);
    expect(wf.agentNames.size).toBe(1);
  });

  it("addAgent is idempotent — adding the same name twice does not duplicate", () => {
    const wf = createMultiAgentWorkflow().addAgent("orchestrator").addAgent("orchestrator");
    expect(wf.agentNames.size).toBe(1);
  });

  it("addAgent returns a new workflow (immutable-style)", () => {
    const a = createMultiAgentWorkflow();
    const b = a.addAgent("scout");
    expect(a.agentNames.size).toBe(0);
    expect(b.agentNames.size).toBe(1);
  });

  // ── addEdge ─────────────────────────────────────────────────────────────

  it("addEdge registers a directed edge between two agents", () => {
    const wf = createMultiAgentWorkflow(["planner", "coder"]).addEdge("planner", "coder");
    expect(wf.edges.length).toBe(1);
    expect(wf.edges[0]).toEqual(["planner", "coder"]);
  });

  it("addEdge is idempotent for duplicate edges", () => {
    const wf = createMultiAgentWorkflow(["a", "b"])
      .addEdge("a", "b")
      .addEdge("a", "b");
    expect(wf.edges.length).toBe(1);
  });

  it("addEdge auto-registers agents that are not yet in the graph", () => {
    const wf = createMultiAgentWorkflow().addEdge("discovery", "implementation");
    expect(wf.agentNames.has("discovery")).toBe(true);
    expect(wf.agentNames.has("implementation")).toBe(true);
    expect(wf.edges.length).toBe(1);
  });

  it("addEdge returns a new workflow (immutable-style)", () => {
    const a = createMultiAgentWorkflow(["x", "y"]);
    const b = a.addEdge("x", "y");
    expect(a.edges.length).toBe(0);
    expect(b.edges.length).toBe(1);
  });

  // ── nextAgents(from) — pure routing helper ─────────────────────────────

  it("nextAgents returns agents that immediately follow the given agent", () => {
    const wf = createMultiAgentWorkflow(
      ["planner", "coder", "reviewer"],
      [["planner", "coder"]]
    );
    const next = wf.nextAgents("planner");
    expect(next).toEqual(["coder"]);
  });

  it("nextAgents returns multiple successors when an agent fans out", () => {
    const wf = createMultiAgentWorkflow(
      ["dispatcher", "worker-a", "worker-b"],
      [
        ["dispatcher", "worker-a"],
        ["dispatcher", "worker-b"]
      ]
    );
    const next = wf.nextAgents("dispatcher").sort();
    expect(next).toEqual(["worker-a", "worker-b"]);
  });

  it("nextAgents returns empty array for a terminal agent with no outgoing edges", () => {
    const wf = createMultiAgentWorkflow(
      ["start", "end"],
      [["start", "end"]]
    );
    expect(wf.nextAgents("end")).toEqual([]);
  });

  it("nextAgents returns empty array for an unknown agent name", () => {
    const wf = createMultiAgentWorkflow(["alpha"]);
    expect(wf.nextAgents("nobody")).toEqual([]);
  });

  it("nextAgents returns empty array for an empty workflow", () => {
    const wf = createMultiAgentWorkflow();
    expect(wf.nextAgents("anything")).toEqual([]);
  });

  it("nextAgents handles a chain: planner → coder → reviewer", () => {
    const wf = createMultiAgentWorkflow(
      ["planner", "coder", "reviewer"],
      [
        ["planner", "coder"],
        ["coder", "reviewer"]
      ]
    );
    expect(wf.nextAgents("planner")).toEqual(["coder"]);
    expect(wf.nextAgents("coder")).toEqual(["reviewer"]);
    expect(wf.nextAgents("reviewer")).toEqual([]);
  });

  // ── complex graph shapes ───────────────────────────────────────────────

  it("handles a diamond: fan-out then fan-in", () => {
    const wf = createMultiAgentWorkflow(
      ["start", "left", "right", "merge"],
      [
        ["start", "left"],
        ["start", "right"],
        ["left", "merge"],
        ["right", "merge"]
      ]
    );
    expect(wf.nextAgents("start").sort()).toEqual(["left", "right"]);
    expect(wf.nextAgents("left")).toEqual(["merge"]);
    expect(wf.nextAgents("right")).toEqual(["merge"]);
    expect(wf.nextAgents("merge")).toEqual([]);
  });

  it("handles agent with self-loop edge", () => {
    const wf = createMultiAgentWorkflow(["retry"], [["retry", "retry"]]);
    expect(wf.nextAgents("retry")).toEqual(["retry"]);
  });

  it("preserves edge insertion order for deterministic nextAgents output", () => {
    const wf = createMultiAgentWorkflow(["root"]);
    // Add edges in a known order; nextAgents should return them in that order.
    const names = ["alpha", "beta", "gamma", "delta"] as const;
    let w = wf;
    for (const name of names) {
      w = w.addEdge("root", name);
    }
    expect(w.nextAgents("root")).toEqual([...names]);
  });
});
