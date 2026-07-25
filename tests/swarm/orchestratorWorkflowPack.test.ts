import { describe, expect, it } from "vitest";

import {
  OrchestratorPackValidationError,
  ORCHESTRATOR_PACK_MAX_ROLES,
  OrchestratorWorkflowPackSchema,
  isValidPack,
  parsePack,
  planPackSteps,
  type OrchestratorPlannedStep,
  type OrchestratorRoleStep,
  type OrchestratorWorkflowPack
} from '../../src/swarm/orchestratorWorkflowPack.js';

const VALID_PACK = {
  id: "research-then-build",
  name: "Research then Build",
  roles: [
    { role: "scout", mode: "read-only", prompt: "map the repo" },
    { role: "implementer", mode: "all", prompt: "land the change" }
  ],
  stopGateId: "operator-review"
} as const;

describe("orchestrator workflow pack — parsePack / validate", () => {
  it("accepts a well-formed pack and preserves role order", () => {
    const pack = parsePack(VALID_PACK);
    expect(pack.id).toBe("research-then-build");
    expect(pack.roles.map((r: OrchestratorRoleStep) => r.role)).toEqual(["scout", "implementer"]);
    expect(pack.stopGateId).toBe("operator-review");
  });

  it("defaults a role's mode to the safe read-only scout when omitted", () => {
    const pack = parsePack({
      id: "p",
      name: "P",
      roles: [{ role: "scout", prompt: "look" }],
      stopGateId: "g"
    });
    expect(pack.roles[0]?.mode).toBe("read-only");
  });

  it("rejects an unknown role mode (no made-up modes)", () => {
    expect(() =>
      parsePack({
        id: "p",
        name: "P",
        roles: [{ role: "scout", mode: "yolo-write" }],
        stopGateId: "g"
      })
    ).toThrow();
  });

  it("EMPTY ROLES FAILS — a pack with no role steps is rejected (plan-required)", () => {
    let caught: unknown;
    try {
      parsePack({ id: "p", name: "P", roles: [], stopGateId: "g" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OrchestratorPackValidationError);
    expect((caught as OrchestratorPackValidationError).code).toBe("orchestrator_pack_invalid");
    // The structural reason must be legible.
    expect((caught as Error).message).toMatch(/invalid/i);
  });

  it("requires a non-blank stop gate id — a pack never silently runs past the operator", () => {
    for (const bad of [undefined, "", "   "]) {
      expect(() =>
        parsePack({ id: "p", name: "P", roles: [{ role: "scout" }], stopGateId: bad })
      ).toThrow(OrchestratorPackValidationError);
    }
  });

  it("requires id + name and rejects unknown top-level keys (strict)", () => {
    expect(() =>
      parsePack({ name: "P", roles: [{ role: "scout" }], stopGateId: "g" })
    ).toThrow(); // missing id
    expect(() =>
      parsePack({ id: "p", roles: [{ role: "scout" }], stopGateId: "g" })
    ).toThrow(); // missing name
    // Strict — an unknown top-level key is rejected, not silently dropped.
    expect(() => parsePack({ ...VALID_PACK, extra: true })).toThrow(OrchestratorPackValidationError);
  });

  it("hard-caps the role count so a malformed pack cannot unleash fan-out", () => {
    const tooMany = {
      id: "p",
      name: "P",
      stopGateId: "g",
      roles: Array.from({ length: ORCHESTRATOR_PACK_MAX_ROLES + 1 }, (_, i) => ({
        role: `r${i}`,
        prompt: "x"
      }))
    };
    expect(() => parsePack(tooMany)).toThrow(OrchestratorPackValidationError);
    // At the cap is fine.
    const atCap = { ...tooMany, roles: tooMany.roles.slice(0, ORCHESTRATOR_PACK_MAX_ROLES) };
    expect(parsePack(atCap).roles.length).toBe(ORCHESTRATOR_PACK_MAX_ROLES);
  });

  it("the structured error carries the zod issues for the reviewer/operator", () => {
    try {
      parsePack({ id: "p", name: "P", roles: [], stopGateId: "g" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestratorPackValidationError);
      expect((error as OrchestratorPackValidationError).issues.length).toBeGreaterThan(0);
    }
  });

  it("isValidPack narrows the type without throwing", () => {
    expect(isValidPack(VALID_PACK)).toBe(true);
    expect(isValidPack({ id: "p", roles: [], stopGateId: "g" })).toBe(false);
    expect(isValidPack(null)).toBe(false);
    expect(isValidPack(undefined)).toBe(false);
  });
});

describe("orchestrator workflow pack — composition with the swarm residual", () => {
  it("planPackSteps expands a validated pack into ordered swarm-ready triples", () => {
    const pack: OrchestratorWorkflowPack = OrchestratorWorkflowPackSchema.parse(VALID_PACK);
    const steps = planPackSteps(pack);
    expect(steps.map((s: OrchestratorPlannedStep) => s.role)).toEqual(["scout", "implementer"]);
    expect(steps.map((s: OrchestratorPlannedStep) => s.mode)).toEqual(["read-only", "all"]);
    expect(steps.map((s: OrchestratorPlannedStep) => s.order)).toEqual([0, 1]);
    expect(steps[0]?.prompt).toBe("map the repo");
  });

  it("a role with no prompt yields undefined — the caller supplies it at run", () => {
    const pack = parsePack({
      id: "p",
      name: "P",
      roles: [{ role: "scout" }],
      stopGateId: "g"
    });
    const [only] = planPackSteps(pack);
    expect(only?.prompt).toBeUndefined();
    expect(only?.role).toBe("scout");
  });

  it("planPackSteps never spawns — it only produces plain values (no second scheduler)", () => {
    // The plan layer is pure: it cannot reach the swarm manager or the model.
    // The swarm's own caps (concurrency, depth, budget, task cap) bind when the
    // caller later calls manager.spawn for each planned step.
    const pack = parsePack(VALID_PACK);
    const steps = planPackSteps(pack);
    expect(steps.every((s) => typeof s.role === "string")).toBe(true);
    // No side effects: running it twice yields equal, independent outputs.
    expect(planPackSteps(pack)).toEqual(steps);
  });
});
