import { describe, expect, it } from "vitest";

import {
  validateFlow,
  FlowNodeKindSchema,
  FlowNodeSchema,
  type FlowNode,
  type FlowValidationError
} from '../../src/workflow/eventFlowStartListenRouter.js';

// ── Schema guards ───────────────────────────────────────────────────────────

describe("FlowNodeKindSchema", () => {
  it.each(["start", "listen", "router"] as const)("accepts %s", (kind) => {
    expect(FlowNodeKindSchema.parse(kind)).toBe(kind);
  });

  it("rejects unknown node kinds", () => {
    expect(() => FlowNodeKindSchema.parse("unknown")).toThrow();
  });
});

describe("FlowNodeSchema", () => {
  it("parses a valid start node", () => {
    const node: FlowNode = FlowNodeSchema.parse({ id: "entry", kind: "start" });
    expect(node).toEqual({ id: "entry", kind: "start" });
  });

  it("parses a valid listen node with listenFrom", () => {
    const node: FlowNode = FlowNodeSchema.parse({
      id: "onTaskDone",
      kind: "listen",
      listenFrom: "entry"
    });
    expect(node).toEqual({ id: "onTaskDone", kind: "listen", listenFrom: "entry" });
  });

  it("parses a valid router node with branches", () => {
    const node: FlowNode = FlowNodeSchema.parse({
      id: "decide",
      kind: "router",
      routerBranches: ["pathA", "pathB"]
    });
    expect(node).toEqual({ id: "decide", kind: "router", routerBranches: ["pathA", "pathB"] });
  });

  it("rejects a node with extra unknown fields", () => {
    expect(() => FlowNodeSchema.parse({ id: "x", kind: "start", extra: true })).toThrow();
  });
});

// ── validateFlow ────────────────────────────────────────────────────────────

function ok(nodes: readonly FlowNode[]): readonly FlowValidationError[] {
  const result = validateFlow(nodes);
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
  return result.errors;
}

function fail(nodes: readonly FlowNode[], expectedErrorCount: number): readonly FlowValidationError[] {
  const result = validateFlow(nodes);
  expect(result.valid).toBe(false);
  expect(result.errors).toHaveLength(expectedErrorCount);
  return result.errors;
}

describe("validateFlow", () => {
  it("accepts a minimal single-start flow", () => {
    ok([{ id: "begin", kind: "start" }]);
  });

  it("accepts a start → listen chain", () => {
    ok([
      { id: "begin", kind: "start" },
      { id: "onBegin", kind: "listen", listenFrom: "begin" }
    ]);
  });

  it("accepts a start → router(branches) → listen chain", () => {
    ok([
      { id: "begin", kind: "start" },
      { id: "decide", kind: "router", routerBranches: ["onPathA", "onPathB"] },
      { id: "onPathA", kind: "listen", listenFrom: "decide" },
      { id: "onPathB", kind: "listen", listenFrom: "decide" }
    ]);
  });

  it("accepts a flow with multiple starts", () => {
    ok([
      { id: "http", kind: "start" },
      { id: "cli", kind: "start" },
      { id: "onHttp", kind: "listen", listenFrom: "http" }
    ]);
  });

  // ── ERROR: no start ────────────────────────────────────────────────────

  it("rejects a flow with no start node", () => {
    const errors = fail(
      [{ id: "onX", kind: "listen", listenFrom: "nonexistent" }],
      2 // missing start + orphan
    );
    expect(errors.some((e) => e.message.includes("at least one start"))).toBe(true);
  });

  // ── ERROR: orphan listen ───────────────────────────────────────────────

  it("rejects a listen node with no listenFrom", () => {
    const errors = fail(
      [
        { id: "begin", kind: "start" },
        { id: "orphan", kind: "listen" }
      ],
      1
    );
    expect(errors[0]).toMatchObject({
      nodeId: "orphan",
      kind: "listen",
      message: expect.stringContaining("listenFrom") as string
    });
  });

  it("rejects a listen node with listenFrom pointing to non-existent node", () => {
    const errors = fail(
      [
        { id: "begin", kind: "start" },
        { id: "dangling", kind: "listen", listenFrom: "ghost" }
      ],
      1
    );
    expect(errors[0]).toMatchObject({
      nodeId: "dangling",
      kind: "listen",
      message: expect.stringContaining('"ghost" does not exist') as string
    });
  });

  it("rejects a listen node with empty listenFrom string", () => {
    const errors = fail(
      [
        { id: "begin", kind: "start" },
        { id: "blank", kind: "listen", listenFrom: "" }
      ],
      1
    );
    expect(errors[0]).toMatchObject({
      nodeId: "blank",
      kind: "listen",
      message: expect.stringContaining("listenFrom") as string
    });
  });

  // ── ERROR: router needs branches ───────────────────────────────────────

  it("rejects a router node with no routerBranches", () => {
    const errors = fail(
      [
        { id: "begin", kind: "start" },
        { id: "noop", kind: "router" }
      ],
      1
    );
    expect(errors[0]).toMatchObject({
      nodeId: "noop",
      kind: "router",
      message: expect.stringContaining("at least one router branch") as string
    });
  });

  it("rejects a router node with empty routerBranches array", () => {
    const errors = fail(
      [
        { id: "begin", kind: "start" },
        { id: "empty", kind: "router", routerBranches: [] }
      ],
      1
    );
    expect(errors[0]).toMatchObject({
      nodeId: "empty",
      kind: "router",
      message: expect.stringContaining("at least one router branch") as string
    });
  });

  it("rejects a router node with branches pointing to non-existent nodes", () => {
    const errors = fail(
      [
        { id: "begin", kind: "start" },
        { id: "decide", kind: "router", routerBranches: ["ghostA", "ghostB"] }
      ],
      2 // one error per invalid branch
    );
    expect(errors[0]).toMatchObject({
      nodeId: "decide",
      kind: "router",
      message: expect.stringContaining('"ghostA" does not exist') as string
    });
    expect(errors[1]).toMatchObject({
      nodeId: "decide",
      kind: "router",
      message: expect.stringContaining('"ghostB" does not exist') as string
    });
  });

  // ── Mixed errors ───────────────────────────────────────────────────────

  it("reports all errors when multiple validation issues exist", () => {
    // no start + orphan listen + router without branches
    const errors = fail(
      [
        { id: "orphan", kind: "listen" },
        { id: "emptyRouter", kind: "router" }
      ],
      3
    );
    expect(errors.filter((e) => e.kind === "start")).toHaveLength(1);
    expect(errors.filter((e) => e.kind === "listen")).toHaveLength(1);
    expect(errors.filter((e) => e.kind === "router")).toHaveLength(1);
  });

  // ── Empty graph ────────────────────────────────────────────────────────

  it("rejects an empty graph (no start)", () => {
    const errors = fail([], 1);
    expect(errors[0]?.message).toContain("at least one start");
  });
});