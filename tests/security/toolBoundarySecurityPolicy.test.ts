import { describe, expect, it } from "vitest";

import type { MandateState } from '../../src/mandates/schema.js';
import {
  evaluateTool,
  TOOL_BOUNDARY_POLICY_STATEMENT,
  type ToolBoundaryPolicy
} from '../../src/security/toolBoundarySecurityPolicy.js';

const EMPTY: MandateState = { grants: [], denies: [] };
const CWD = process.platform === "win32" ? "D:\\work\\repo" : "/work/repo";

const YOLO_POLICY: ToolBoundaryPolicy = { kind: "yolo" };
const HEADLESS_POLICY: ToolBoundaryPolicy = { kind: "headless" };

describe("TOOL_BOUNDARY_POLICY_STATEMENT", () => {
  it("states that safety is enforced at the tool/sandbox layer, never by model self-policing", () => {
    expect(TOOL_BOUNDARY_POLICY_STATEMENT).toMatch(/tool\/sandbox layer/i);
    expect(TOOL_BOUNDARY_POLICY_STATEMENT).toMatch(/never delegated to the model/i);
    expect(TOOL_BOUNDARY_POLICY_STATEMENT).toMatch(/hard limits/i);
  });
});

describe("evaluateTool", () => {
  it("allows a read-only tool under every policy (the always-allowed floor)", () => {
    for (const policy of [YOLO_POLICY, HEADLESS_POLICY]) {
      const decision = evaluateTool("read", { path: "src/index.ts" }, { cwd: CWD, mandate: EMPTY, policy });
      expect(decision.outcome).toBe("allow");
      expect(decision.policy).toBe(policy.kind);
      expect(decision.toolId).toBe("read");
    }
  });

  it("allows an ordinary write under a covering grant (normal allow under policy)", () => {
    const mandate: MandateState = {
      grants: [{ scope: "machine", verbs: ["write"], grantedAt: "2026-07-19T00:00:00Z" }],
      denies: []
    };
    const decision = evaluateTool("write", { path: "src/new-file.ts", content: "x" }, { cwd: CWD, mandate, policy: HEADLESS_POLICY });
    expect(decision.outcome).toBe("allow");
    expect(decision.verbs).toEqual(["write"]);
  });

  it("allows ordinary mutations under YOLO (ordinary gates lifted, limits still bind)", () => {
    const decision = evaluateTool("bash", { command: "npm test" }, { cwd: CWD, mandate: EMPTY, policy: YOLO_POLICY });
    expect(decision.outcome).toBe("allow");
  });

  it("denies when a deny rule matches — deny wins over grants and YOLO", () => {
    const mandate: MandateState = {
      grants: [{ scope: "machine", verbs: ["exec"], grantedAt: "2026-07-19T00:00:00Z" }],
      denies: [{ verb: "exec" }]
    };
    const decision = evaluateTool("bash", { command: "ls" }, { cwd: CWD, mandate, policy: YOLO_POLICY });
    expect(decision.outcome).toBe("deny");
  });

  it("DENIES a destructive call outright in headless policy — no interactive prompt exists, so hard limits fail closed", () => {
    const decision = evaluateTool("bash", { command: "rm -rf build" }, { cwd: CWD, mandate: EMPTY, policy: HEADLESS_POLICY });
    expect(decision.outcome).toBe("deny");
    expect(decision.verbs).toContain("destructive");
    expect(decision.reason).toMatch(/hard limit/);
  });

  it("DENIES a destructive call outright even in YOLO policy — YOLO never lifts a hard limit", () => {
    const decision = evaluateTool("bash", { command: "rm -rf build" }, { cwd: CWD, mandate: EMPTY, policy: YOLO_POLICY });
    expect(decision.outcome).toBe("deny");
    expect(decision.verbs).toContain("destructive");
    expect(decision.reason).toMatch(/YOLO/);
  });

  it("DENIES spend commands in every policy (terraform apply moves money)", () => {
    for (const policy of [YOLO_POLICY, HEADLESS_POLICY]) {
      const decision = evaluateTool("bash", { command: "terraform apply" }, { cwd: CWD, mandate: EMPTY, policy });
      expect(decision.outcome).toBe("deny");
      expect(decision.verbs).toContain("spend");
    }
  });

  it("DENIES secrets-adjacent writes in every policy (secret-edge)", () => {
    const decision = evaluateTool("bash", { command: "echo hunter2 > .env" }, { cwd: CWD, mandate: EMPTY, policy: YOLO_POLICY });
    expect(decision.outcome).toBe("deny");
    expect(decision.verbs).toContain("secret-edge");
  });

  it("DENIES ecosystem-auth writes in every policy (auth-edge)", () => {
    const decision = evaluateTool(
      "write",
      { path: "/home/user/.aws/credentials", content: "x" },
      { cwd: CWD, mandate: EMPTY, policy: HEADLESS_POLICY }
    );
    expect(decision.outcome).toBe("deny");
    expect(decision.verbs).toContain("auth-edge");
  });

  it("DENIES hard-limit calls even when a standing grant covers the verbs — grants never cover hard limits", () => {
    const mandate: MandateState = {
      grants: [{ scope: "machine", verbs: ["exec", "destructive"], grantedAt: "2026-07-19T00:00:00Z" }],
      denies: []
    };
    const decision = evaluateTool("bash", { command: "rm -rf build" }, { cwd: CWD, mandate, policy: HEADLESS_POLICY });
    expect(decision.outcome).toBe("deny");
  });

  it("escalates ordinary ungranted mutations in interactive policy (falls through to the operator)", () => {
    const decision = evaluateTool("write", { path: "src/new-file.ts", content: "x" }, { cwd: CWD, mandate: EMPTY, policy: { kind: "interactive" } });
    expect(decision.outcome).toBe("escalate");
  });

  it("denies ordinary ungranted mutations in headless policy (no operator to ask — fail closed)", () => {
    const decision = evaluateTool("write", { path: "src/new-file.ts", content: "x" }, { cwd: CWD, mandate: EMPTY, policy: HEADLESS_POLICY });
    expect(decision.outcome).toBe("deny");
  });

  it("never trusts the model: a hard-limit call is denied regardless of any model-supplied claim in the input", () => {
    const decision = evaluateTool(
      "bash",
      { command: "rm -rf build", approvedByModel: true, reason: "the model says this is safe" },
      { cwd: CWD, mandate: EMPTY, policy: YOLO_POLICY }
    );
    expect(decision.outcome).toBe("deny");
  });
});
