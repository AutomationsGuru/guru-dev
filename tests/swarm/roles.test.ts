import { describe, expect, it } from "vitest";

import { evaluateToolMandate } from "../../src/mandates/evaluate.js";
import { HARD_EDGE_VERBS, MandateGrantSchema, MandateStateSchema, type MandateState } from "../../src/mandates/schema.js";
import {
  SWARM_FACE_COPY,
  SwarmRoleNameSchema,
  SwarmRoleSchema,
  UnknownSwarmRoleError,
  clampBudget,
  deriveChildMandate,
  getSwarmRole,
  listSwarmRoles,
  resolveChildYolo,
  resolveRoleMode,
  roleAllowsTool
} from "../../src/swarm/roles.js";

const parentState = (overrides: Partial<MandateState> = {}): MandateState =>
  MandateStateSchema.parse({
    grants: [],
    denies: [],
    ...overrides
  });

const grant = (verbs: readonly string[], scope: "space" | "machine" = "machine", path?: string) =>
  MandateGrantSchema.parse({
    scope,
    ...(path !== undefined ? { path } : {}),
    verbs,
    grantedAt: "2026-07-18T00:00:00.000Z"
  });

describe("swarm roles — registry shape and validation", () => {
  it("exposes exactly the six invocable named worker types", () => {
    expect(SwarmRoleNameSchema.options).toEqual(["explore", "plan", "implementer", "review", "verifier", "general"]);
    expect(listSwarmRoles().map((role) => role.name)).toEqual(["explore", "plan", "review", "verifier", "implementer", "general"]);
  });

  it("every registered role parses its own schema (registry is structurally valid)", () => {
    for (const role of listSwarmRoles()) {
      expect(() => SwarmRoleSchema.parse(role)).not.toThrow();
    }
  });

  it("spawn validates the role: unknown names throw a structured error, never default open", () => {
    let caught: unknown;
    try {
      getSwarmRole("saboteur");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnknownSwarmRoleError);
    expect((caught as UnknownSwarmRoleError).code).toBe("unknown_swarm_role");
    expect((caught as UnknownSwarmRoleError).message).toContain("saboteur");
    expect(() => getSwarmRole("")).toThrow(UnknownSwarmRoleError);
    expect(getSwarmRole("explore").name).toBe("explore");
  });

  it("depth/budget fields are REQUIRED on every role — no silent inherit, no unbounded worker", () => {
    for (const role of listSwarmRoles()) {
      expect(Number.isInteger(role.budgets.maxToolCalls)).toBe(true);
      expect(Number.isInteger(role.budgets.maxTokens)).toBe(true);
      expect(Number.isInteger(role.budgets.timeoutMs)).toBe(true);
      expect(Number.isInteger(role.budgets.maxSpawnDepth)).toBe(true);
      expect(role.budgets.maxToolCalls).toBeGreaterThan(0);
      expect(role.budgets.maxSpawnDepth).toBeGreaterThanOrEqual(0);
    }
    // The schema refuses a role definition missing any budget field.
    const base = SwarmRoleSchema.parse(getSwarmRole("explore"));
    const { maxToolCalls: _dropped, ...brokenBudgets } = base.budgets;
    expect(() => SwarmRoleSchema.parse({ ...base, budgets: brokenBudgets })).toThrow();
    expect(() => SwarmRoleSchema.parse({ ...base, budgets: { ...base.budgets, maxToolCalls: 0 } })).toThrow();
  });

  it("the swarm trio stays invocable from every role (bounded fan-out within own ceilings)", () => {
    for (const role of listSwarmRoles()) {
      expect(roleAllowsTool(role, "spawn_agent")).toBe(true);
      expect(roleAllowsTool(role, "get_task_output")).toBe(true);
      expect(roleAllowsTool(role, "kill_task")).toBe(true);
    }
  });
});

describe("swarm roles — explore is structurally read-only", () => {
  it("explore's allowlist is exactly the mandate read-only floor + the swarm trio (derived, never copied)", () => {
    const explore = getSwarmRole("explore");
    // Every mutating/verb-bearing tool is absent — not gated, ABSENT.
    for (const mutating of ["bash", "shell.command.run", "write", "edit", "fs.edit.apply", "web_fetch", "web_search", "provider_cli_run"]) {
      expect(roleAllowsTool(explore, mutating)).toBe(false);
    }
    // Canonical read-only tools are present.
    for (const reader of ["read", "grep", "find", "ls", "memory_search"]) {
      expect(roleAllowsTool(explore, reader)).toBe(true);
    }
    // plan / review / verifier share the read-only universe.
    for (const name of ["plan", "review", "verifier"] as const) {
      expect(getSwarmRole(name).toolAllowlist).toEqual(explore.toolAllowlist);
      expect(getSwarmRole(name).mode).toBe("read-only");
    }
  });

  it("a read-only role can never be widened by the parent's mode", () => {
    const explore = getSwarmRole("explore");
    expect(resolveRoleMode(explore, "read-only")).toBe("read-only");
    expect(resolveRoleMode(explore, "all")).toBe("read-only");
    // inherit-mode roles follow the parent.
    const implementer = getSwarmRole("implementer");
    expect(resolveRoleMode(implementer, "read-only")).toBe("read-only");
    expect(resolveRoleMode(implementer, "all")).toBe("all");
  });

  it("budget clamping keeps the worker at or below the role ceiling", () => {
    const explore = getSwarmRole("explore");
    expect(clampBudget(explore, 1_000_000, "maxToolCalls")).toBe(explore.budgets.maxToolCalls);
    expect(clampBudget(explore, 2, "maxToolCalls")).toBe(2);
    const general = getSwarmRole("general");
    expect(clampBudget(general, Number.MAX_SAFE_INTEGER, "maxTokens")).toBe(general.budgets.maxTokens);
  });
});

describe("swarm roles — child mandate is mandate ∩ parent, structurally", () => {
  it("every parent deny carries down unchanged (deny-wins survives inheritance)", () => {
    const parent = parentState({
      denies: [
        { verb: "exec", note: "no shell in this project" },
        { verb: "write", path: "/srv/protected" }
      ]
    });
    const child = deriveChildMandate(getSwarmRole("general"), parent);
    expect(child.denies).toEqual(parent.denies);
  });

  it("hard-edge verbs are stripped from child grants — a child can never hold a grant for a hard edge", () => {
    // MandateGrantSchema itself does not forbid hard-edge verbs in a persisted
    // grant; inheritance must refuse to propagate them.
    const parent = parentState({
      grants: [grant(["write", "spend", "destructive", "secret-edge", "auth-edge"])]
    });
    for (const role of listSwarmRoles()) {
      const child = deriveChildMandate(role, parent);
      for (const childGrant of child.grants) {
        for (const verb of childGrant.verbs) {
          expect(HARD_EDGE_VERBS.has(verb)).toBe(false);
        }
      }
    }
  });

  it("grants are intersected with the role's tool universe: a read-only role holds no mutating grant", () => {
    const parent = parentState({ grants: [grant(["write", "exec", "net"])] });
    const exploreChild = deriveChildMandate(getSwarmRole("explore"), parent);
    // Explore cannot exercise write/exec/net through any allowlisted tool → the grant is gone entirely.
    expect(exploreChild.grants).toEqual([]);

    const generalChild = deriveChildMandate(getSwarmRole("general"), parent);
    expect(generalChild.grants).toHaveLength(1);
    expect(generalChild.grants[0]?.verbs).toEqual(["write", "exec", "net"]);
  });

  it("grants emptied by the intersection are dropped; the result always parses as a valid MandateState", () => {
    const parent = parentState({
      grants: [grant(["spend"]), grant(["write", "exec"])],
      denies: [{ verb: "net" }]
    });
    const child = deriveChildMandate(getSwarmRole("verifier"), parent);
    expect(() => MandateStateSchema.parse(child)).not.toThrow();
    expect(child.grants).toEqual([]); // verifier exercises no mutating verb
    expect(child.denies).toEqual(parent.denies);
  });

  it("the child never exceeds the parent under evaluation: a write the parent would escalate stays escalated for the child", () => {
    // Parent holds NO write grant. Child mandate is derived and evaluated with
    // the same engine the live session uses — no covering grant → escalate.
    const parent = parentState({ grants: [grant(["read"])] });
    const child = deriveChildMandate(getSwarmRole("implementer"), parent);
    const decision = evaluateToolMandate("write", { path: "src/x.ts" }, { cwd: "/repo", state: child, yolo: false });
    expect(decision.outcome).toBe("escalate");
  });

  it("a child deny inherited from the parent still beats YOLO (deny-wins, even for an explicitly-flagged YOLO child)", () => {
    const parent = parentState({ denies: [{ verb: "exec" }] });
    const child = deriveChildMandate(getSwarmRole("general"), parent);
    const childYolo = resolveChildYolo(true, true); // operator explicitly flagged the child
    expect(childYolo).toBe(true);
    const decision = evaluateToolMandate("bash", { command: "ls" }, { cwd: "/repo", state: child, yolo: childYolo });
    expect(decision.outcome).toBe("deny");
  });

  it("hard edges still escalate for the child in every mode — inheritance can never weaken them", () => {
    const parent = parentState({ grants: [grant(["write", "exec", "net", "spend", "destructive"])] });
    const child = deriveChildMandate(getSwarmRole("general"), parent);
    for (const yolo of [false, true]) {
      const destructive = evaluateToolMandate("bash", { command: "rm -rf /tmp/x" }, { cwd: "/repo", state: child, yolo });
      expect(destructive.outcome).toBe("escalate");
      expect(destructive.verbs).toContain("destructive");
      const spend = evaluateToolMandate("bash", { command: "terraform apply" }, { cwd: "/repo", state: child, yolo });
      expect(spend.outcome).toBe("escalate");
      expect(spend.verbs).toContain("spend");
      const secret = evaluateToolMandate("write", { path: ".env" }, { cwd: "/repo", state: child, yolo });
      expect(secret.outcome).toBe("escalate");
      expect(secret.verbs).toContain("secret-edge");
    }
  });
});

describe("swarm roles — YOLO does not cascade", () => {
  it("a YOLO parent spawns a non-YOLO child by default", () => {
    expect(resolveChildYolo(true, false)).toBe(false);
    expect(resolveChildYolo(false, false)).toBe(false);
    expect(resolveChildYolo(false, true)).toBe(false);
  });

  it("child YOLO requires BOTH a YOLO parent AND an explicit per-spawn child flag", () => {
    expect(resolveChildYolo(true, true)).toBe(true);
  });

  it("a non-YOLO child of a YOLO parent still escalates ordinary un-granted work (no inherited blanket allow)", () => {
    const parent = parentState({ grants: [] });
    const child = deriveChildMandate(getSwarmRole("implementer"), parent);
    const childYolo = resolveChildYolo(true, false);
    expect(childYolo).toBe(false);
    const decision = evaluateToolMandate("edit", { path: "src/x.ts" }, { cwd: "/repo", state: child, yolo: childYolo });
    expect(decision.outcome).toBe("escalate");
  });
});

describe("swarm roles — product face copy (R-AS-FACE)", () => {
  it("operator-facing copy names Guru as the only face; workers never address the operator", () => {
    expect(SWARM_FACE_COPY.length).toBeGreaterThan(0);
    const copy = SWARM_FACE_COPY.join("\n");
    expect(copy).toContain("Guru");
    expect(copy).toMatch(/workers? never ask/i);
  });
});
