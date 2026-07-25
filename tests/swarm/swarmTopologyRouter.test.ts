import { describe, expect, it } from "vitest";

import {
  SWARM_TOPOLOGY_TYPES,
  isSwarmTopologyType,
  UnknownSwarmTopologyError,
  SwarmTopologyGraphCycleError,
  SwarmTopologyGraphValidationError,
  runTopology,
  type SwarmTopologyAgent
} from '../../src/swarm/swarmTopologyRouter.js';

/** Build a recording agent; default run returns `input + "->" + id`. */
function makeAgent(
  id: string,
  fn?: (input: string) => Promise<string> | string
): SwarmTopologyAgent & { inputs: string[] } {
  const inputs: string[] = [];
  const agent: SwarmTopologyAgent & { inputs: string[] } = {
    id,
    inputs,
    run(input: string) {
      inputs.push(input);
      return fn ? fn(input) : `${input}->${id}`;
    }
  };
  return agent;
}

describe("swarm topology router — type registry", () => {
  it("lists the four canonical topology types", () => {
    expect([...SWARM_TOPOLOGY_TYPES]).toEqual(["sequential", "concurrent", "moa", "graph"]);
  });

  it("isSwarmTopologyType is true for each listed type and false for unknowns", () => {
    for (const type of SWARM_TOPOLOGY_TYPES) {
      expect(isSwarmTopologyType(type)).toBe(true);
    }
    expect(isSwarmTopologyType("nope")).toBe(false);
    expect(isSwarmTopologyType("")).toBe(false);
    expect(isSwarmTopologyType("SEQUENTIAL")).toBe(false);
    expect(isSwarmTopologyType("Graph")).toBe(false);
  });
});

describe("swarm topology router — unknown type fails closed", () => {
  const agents = [makeAgent("a")];

  it("runTopology(\"nope\") throws UnknownSwarmTopologyError with code + type", async () => {
    let caught: unknown;
    try {
      await runTopology("nope", agents, "t");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnknownSwarmTopologyError);
    expect((caught as UnknownSwarmTopologyError).code).toBe("unknown_swarm_topology");
    expect((caught as UnknownSwarmTopologyError).type).toBe("nope");
  });

  it("empty string fails closed", async () => {
    await expect(runTopology("", agents, "t")).rejects.toBeInstanceOf(UnknownSwarmTopologyError);
    await expect(runTopology("", agents, "t")).rejects.toMatchObject({
      code: "unknown_swarm_topology",
      type: ""
    });
  });

  it("wrong case (\"SEQUENTIAL\") fails closed — types are case-sensitive", async () => {
    await expect(runTopology("SEQUENTIAL", agents, "t")).rejects.toBeInstanceOf(
      UnknownSwarmTopologyError
    );
    await expect(runTopology("SEQUENTIAL", agents, "t")).rejects.toMatchObject({
      code: "unknown_swarm_topology",
      type: "SEQUENTIAL"
    });
  });
});

describe("swarm topology router — empty agents", () => {
  it("sequential with no agents returns empty outputs and empty text", async () => {
    const result = await runTopology("sequential", [], "t");
    expect(result.type).toBe("sequential");
    expect(result.outputs).toEqual([]);
    expect(result.text).toBe("");
  });

  it("other topologies also accept empty agents without throwing", async () => {
    for (const type of ["concurrent", "moa", "graph"] as const) {
      const result = await runTopology(type, [], "t");
      expect(result.type).toBe(type);
      expect(result.outputs).toEqual([]);
      expect(result.text).toBe("");
    }
  });
});

describe("swarm topology router — sequential", () => {
  it("chains agents: first gets task, next gets previous output; text is last output", async () => {
    const a = makeAgent("a");
    const b = makeAgent("b");

    const result = await runTopology("sequential", [a, b], "task");

    expect(result.type).toBe("sequential");
    expect(a.inputs).toEqual(["task"]);
    expect(b.inputs).toEqual(["task->a"]);
    expect(result.outputs).toEqual([
      { agentId: "a", text: "task->a" },
      { agentId: "b", text: "task->a->b" }
    ]);
    expect(result.text).toBe("task->a->b");
  });

  it("single agent just runs the task", async () => {
    const a = makeAgent("solo");
    const result = await runTopology("sequential", [a], "hello");
    expect(a.inputs).toEqual(["hello"]);
    expect(result.text).toBe("hello->solo");
    expect(result.outputs).toHaveLength(1);
  });
});

describe("swarm topology router — concurrent", () => {
  it("every agent receives the same task; text joins with blank lines; order preserved", async () => {
    const a = makeAgent("a");
    const b = makeAgent("b");

    const result = await runTopology("concurrent", [a, b], "shared");

    expect(result.type).toBe("concurrent");
    expect(a.inputs).toEqual(["shared"]);
    expect(b.inputs).toEqual(["shared"]);
    expect(result.outputs).toEqual([
      { agentId: "a", text: "shared->a" },
      { agentId: "b", text: "shared->b" }
    ]);
    expect(result.text).toBe("shared->a\n\nshared->b");
  });
});

describe("swarm topology router — moa (mixture-of-agents)", () => {
  it("experts get the raw task; aggregator sees task + expert texts/ids; text is aggregator output", async () => {
    const expert1 = makeAgent("expert1", (input) => `e1(${input})`);
    const expert2 = makeAgent("expert2", (input) => `e2(${input})`);
    const aggregator = makeAgent("aggregator", (input) => `agg:${input}`);

    const result = await runTopology("moa", [expert1, expert2, aggregator], "question");

    expect(result.type).toBe("moa");
    expect(expert1.inputs).toEqual(["question"]);
    expect(expert2.inputs).toEqual(["question"]);
    expect(aggregator.inputs).toHaveLength(1);

    const aggInput = aggregator.inputs[0]!;
    expect(aggInput).toContain("question");
    expect(aggInput).toContain("e1(question)");
    expect(aggInput).toContain("e2(question)");
    expect(aggInput).toContain("expert1");
    expect(aggInput).toContain("expert2");

    expect(result.outputs).toHaveLength(3);
    expect(result.outputs[0]).toEqual({ agentId: "expert1", text: "e1(question)" });
    expect(result.outputs[1]).toEqual({ agentId: "expert2", text: "e2(question)" });
    expect(result.outputs[2]?.agentId).toBe("aggregator");
    expect(result.text).toBe(result.outputs[2]?.text);
    expect(result.text.startsWith("agg:")).toBe(true);
  });

  it("single-agent moa still works (expert only — no separate aggregator)", async () => {
    const only = makeAgent("solo", (input) => `solo:${input}`);
    const result = await runTopology("moa", [only], "task");
    expect(result.type).toBe("moa");
    expect(only.inputs).toEqual(["task"]);
    expect(result.outputs).toEqual([{ agentId: "solo", text: "solo:task" }]);
    expect(result.text).toBe("solo:task");
  });
});

describe("swarm topology router — graph", () => {
  it("no edges behaves like sequential (typed as graph)", async () => {
    const a = makeAgent("a");
    const b = makeAgent("b");

    const result = await runTopology("graph", [a, b], "seed");

    expect(result.type).toBe("graph");
    expect(a.inputs).toEqual(["seed"]);
    expect(b.inputs).toEqual(["seed->a"]);
    expect(result.outputs).toEqual([
      { agentId: "a", text: "seed->a" },
      { agentId: "b", text: "seed->a->b" }
    ]);
    expect(result.text).toBe("seed->a->b");
  });

  it("empty edges array also falls back to sequential", async () => {
    const a = makeAgent("a");
    const result = await runTopology("graph", [a], "t", { edges: [] });
    expect(result.type).toBe("graph");
    expect(a.inputs).toEqual(["t"]);
    expect(result.text).toBe("t->a");
  });

  it("diamond a→b, a→c, b→d, c→d: a first, b&c after a, d after both with b+c outputs", async () => {
    const a = makeAgent("a", () => "A");
    const b = makeAgent("b", (input) => `B(${input})`);
    const c = makeAgent("c", (input) => `C(${input})`);
    const d = makeAgent("d", (input) => `D(${input})`);

    const result = await runTopology("graph", [a, b, c, d], "task", {
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "d" },
        { from: "c", to: "d" }
      ]
    });

    expect(result.type).toBe("graph");

    // a is a root → receives the original task
    expect(a.inputs).toEqual(["task"]);

    // b and c depend only on a → each receives a's output
    expect(b.inputs).toEqual(["A"]);
    expect(c.inputs).toEqual(["A"]);

    // d depends on b and c → input includes both outputs (joined)
    expect(d.inputs).toHaveLength(1);
    const dInput = d.inputs[0]!;
    expect(dInput).toContain("B(A)");
    expect(dInput).toContain("C(A)");

    expect(result.outputs.map((o) => o.agentId)).toEqual(["a", "b", "c", "d"]);
    expect(result.outputs.find((o) => o.agentId === "a")?.text).toBe("A");
    expect(result.outputs.find((o) => o.agentId === "b")?.text).toBe("B(A)");
    expect(result.outputs.find((o) => o.agentId === "c")?.text).toBe("C(A)");
    expect(result.outputs.find((o) => o.agentId === "d")?.text).toBe(`D(${dInput})`);
    // Final text is the last agent in the agents-array order (d)
    expect(result.text).toBe(result.outputs[3]?.text);
  });

  it("cycle a→b→a throws SwarmTopologyGraphCycleError (or cycle-mentioning Error)", async () => {
    const a = makeAgent("a");
    const b = makeAgent("b");

    let caught: unknown;
    try {
      await runTopology("graph", [a, b], "t", {
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "a" }
        ]
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    if (typeof SwarmTopologyGraphCycleError === "function") {
      expect(caught).toBeInstanceOf(SwarmTopologyGraphCycleError);
      expect((caught as SwarmTopologyGraphCycleError).code).toBe("swarm_topology_graph_cycle");
    } else {
      expect(caught).toBeInstanceOf(Error);
      expect(String((caught as Error).message).toLowerCase()).toMatch(/cycle/);
    }
  });

  it("edge to unknown agent fails validation", async () => {
    const a = makeAgent("a");

    let caught: unknown;
    try {
      await runTopology("graph", [a], "t", {
        edges: [{ from: "a", to: "missing" }]
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    if (typeof SwarmTopologyGraphValidationError === "function") {
      expect(caught).toBeInstanceOf(SwarmTopologyGraphValidationError);
      expect((caught as SwarmTopologyGraphValidationError).code).toBe(
        "swarm_topology_graph_validation"
      );
      expect((caught as SwarmTopologyGraphValidationError).agent).toBe("missing");
    } else {
      expect(caught).toBeInstanceOf(Error);
    }
  });

  it("edge from unknown agent also fails validation", async () => {
    const a = makeAgent("a");

    await expect(
      runTopology("graph", [a], "t", {
        edges: [{ from: "ghost", to: "a" }]
      })
    ).rejects.toMatchObject({
      code: "swarm_topology_graph_validation",
      agent: "ghost"
    });
  });
});
