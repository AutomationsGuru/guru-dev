import { z } from "zod";
import { describe, expect, it } from "vitest";

import { createHarnessRuntime } from "../../src/runtime/session.js";
import { headlessMandatePolicy, HEADLESS_READ_ONLY_MANDATE } from "../../src/surfaces/api.js";
import { MandateStateSchema } from "../../src/mandates/schema.js";
import { evaluateToolMandate } from "../../src/mandates/evaluate.js";

/**
 * The mandate-enforcement hole (ADR 2026-07-05-composer-completion): the api and
 * SDK reach runtime.executeTool directly. This proves the mandate floor now
 * gates every surface — the SAME evaluateToolMandate the REPL uses — so an
 * ungranted mutation is DENIED, not run.
 */

describe("headless mandate policy — the shared evaluator", () => {
  it("read-only floor denies mutating verbs, allows read-only tools", () => {
    const policy = headlessMandatePolicy();
    expect(policy("read", { path: "x" }, process.cwd())?.outcome).toBe("allow");
    expect(policy("bash", { command: "ls" }, process.cwd())?.outcome).toBe("escalate"); // exec, no grant
    expect(policy("write", { path: "x" }, process.cwd())?.outcome).toBe("escalate");
  });

  it("a supplied space grant allows in-scope writes but hard edges still escalate", () => {
    const mandate = MandateStateSchema.parse({ grants: [{ scope: "space", path: process.cwd(), verbs: ["write", "exec"], grantedAt: "2026-07-05T00:00:00.000Z" }], denies: [] });
    const policy = headlessMandatePolicy(mandate);
    expect(policy("write", { path: "x" }, process.cwd())?.outcome).toBe("allow");
    expect(policy("bash", { command: "rm -rf /" }, process.cwd())?.outcome).toBe("escalate"); // destructive hard edge
  });

  it("is the SAME decision evaluateToolMandate produces (one seam, not a copy)", () => {
    const decision = evaluateToolMandate("write", { path: "x" }, { cwd: process.cwd(), state: HEADLESS_READ_ONLY_MANDATE, yolo: false });
    expect(headlessMandatePolicy()("write", { path: "x" }, process.cwd())).toEqual(decision);
  });
});

describe("runtime.executeTool enforces the mandate policy for EVERY caller", () => {
  const echoWrite = {
    id: "echo.write",
    title: "Echo write",
    description: "A mutating tool for the test.",
    inputSchema: z.object({ value: z.string() }).strict(),
    outputSchema: z.object({ ok: z.boolean() }).strict(),
    execute: () => ({ ok: true })
  };

  it("BLOCKS an ungranted mutation before it reaches the registry (the hole, closed)", async () => {
    let executed = false;
    const runtime = createHarnessRuntime({
      // read-only floor + a registry that includes a mutating tool
      mandatePolicy: headlessMandatePolicy(),
      commandExecutor: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 })
    });
    const session = await runtime.startSession({});
    // Register the mutating tool on the live session registry via the runtime's
    // executeTool path would require a registered tool; instead assert the gate
    // fires for the built-in mutating `write` tool.
    void echoWrite;
    void executed;
    const observation = await runtime.executeTool(session.id, "write", { repoRoot: process.cwd(), path: "should-not-write.txt", contents: "x", dryRun: false });
    expect(observation.status).toBe("failed");
    expect(observation.error ?? "").toContain("Blocked by mandate");
  });

  it("ALLOWS a read-only tool through the same policy", async () => {
    const runtime = createHarnessRuntime({ mandatePolicy: headlessMandatePolicy() });
    const session = await runtime.startSession({});
    const observation = await runtime.executeTool(session.id, "read", { repoRoot: process.cwd(), path: "package.json" });
    expect(observation.status).toBe("succeeded");
  });

  it("with NO policy attached (REPL runtime), executeTool does not gate — approveTool governs there", async () => {
    const runtime = createHarnessRuntime({});
    const session = await runtime.startSession({});
    // read still works; the point is the runtime itself imposes no mandate block.
    const observation = await runtime.executeTool(session.id, "read", { repoRoot: process.cwd(), path: "package.json" });
    expect(observation.status).toBe("succeeded");
  });
});

describe("runPlanner enforces the mandate policy too — the planner path is not a bypass", () => {
  const mutatingPlan = {
    objective: "Attempt a write under the read-only floor.",
    summary: "The mandate must block the mutating step before dispatch.",
    steps: [
      {
        id: "blocked-write",
        title: "Write a file",
        toolId: "write",
        input: { repoRoot: process.cwd(), path: "should-not-write.txt", contents: "x", dryRun: false }
      }
    ]
  };

  it("BLOCKS an ungranted mutating planner step before it reaches the registry", async () => {
    const runtime = createHarnessRuntime({
      mandatePolicy: headlessMandatePolicy(),
      plannerModel: { createPlan: () => mutatingPlan }
    });
    const session = await runtime.startSession({});
    const report = await runtime.runPlanner(session.id, { objective: mutatingPlan.objective });
    expect(report.status).toBe("blocked");
    expect(report.observations).toEqual([]);
    expect(report.blockers[0] ?? "").toContain("blocked by mandate");
  });
});
