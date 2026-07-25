import { afterEach, describe, expect, it } from "vitest";

import {
  AlwaysOnAgentModeSchema,
  assertAlwaysOnHardLimitsIntact,
  createAlwaysOnAgentMode,
  isAlwaysOnActive,
  type AlwaysOnAgentMode
} from '../../src/session/alwaysOnAgentMode.js';
import { evaluateToolMandate } from '../../src/mandates/evaluate.js';
import { resolveApproval, type ApprovalChoice } from '../../src/mandates/approval.js';
import { HARD_EDGE_VERBS, type MandateState, type MandateVerb } from '../../src/mandates/schema.js';

/**
 * IDEA-F192-ALWAYS-ON-01 — always-on agent mode (scheduled wakes, letta residual).
 * The flag composes F189 heartbeat + F162 queue + YOLO hard limits WITHOUT
 * weakening them: enabling it NEVER lifts a deny rule, a hard edge, or the spend
 * cap. Every assertion below pins that invariant against the REAL mandate
 * machinery (no duplicated safety logic lives in this module).
 */
describe("alwaysOnAgentMode", () => {
  afterEach(() => {
    delete process.env.GURU_ALWAYS_ON;
  });

  describe("toggle (step 1: enable / disable / isActive)", () => {
    it("is off by default (a bare boot never wakes on its own)", () => {
      const mode = createAlwaysOnAgentMode();
      expect(mode.enabled).toBe(false);
      expect(isAlwaysOnActive(mode)).toBe(false);
    });

    it("toggles on and off; isActive reflects the flag", () => {
      const mode = createAlwaysOnAgentMode({ enabled: true });
      expect(mode.enabled).toBe(true);
      expect(isAlwaysOnActive(mode)).toBe(true);

      mode.enabled = false;
      expect(isAlwaysOnActive(mode)).toBe(false);
    });

    it("treats a zero/negative wake interval as inactive (a disabled schedule)", () => {
      const enabled = createAlwaysOnAgentMode({ enabled: true, wakeIntervalMinutes: 0 });
      expect(isAlwaysOnActive(enabled)).toBe(false);

      const negative = createAlwaysOnAgentMode({ enabled: true, wakeIntervalMinutes: -5 });
      expect(isAlwaysOnActive(negative)).toBe(false);
    });

    it("rejects unknown config keys (strict schema — no silent config drift)", () => {
      expect(() => AlwaysOnAgentModeSchema.parse({ enabled: true, liftHardLimits: true })).toThrow();
    });

    it("env opt-in GURU_ALWAYS_ON=1 enables the mode; unset stays off", () => {
      process.env.GURU_ALWAYS_ON = "1";
      expect(createAlwaysOnAgentMode().enabled).toBe(true);

      process.env.GURU_ALWAYS_ON = "true";
      expect(createAlwaysOnAgentMode().enabled).toBe(true);

      process.env.GURU_ALWAYS_ON = "0";
      expect(createAlwaysOnAgentMode().enabled).toBe(false);
    });

    it("explicit input beats the environment (operator config wins)", () => {
      process.env.GURU_ALWAYS_ON = "1";
      expect(createAlwaysOnAgentMode({ enabled: false }).enabled).toBe(false);
    });
  });

  describe("hard limits unchanged (step 2: assert)", () => {
    const mode = (): AlwaysOnAgentMode => createAlwaysOnAgentMode({ enabled: true });
    const EMPTY: MandateState = { grants: [], denies: [] };

    it("passes (no-op) when the mandate pipeline resolves hard edges in code", () => {
      expect(() => assertAlwaysOnHardLimitsIntact(mode())).not.toThrow();
    });

    it("is a no-op when the mode is disabled", () => {
      expect(() => assertAlwaysOnHardLimitsIntact(createAlwaysOnAgentMode())).not.toThrow();
    });

    it("still escalates a destructive op under always-on + YOLO (no silent delete)", () => {
      assertAlwaysOnHardLimitsIntact(mode());
      const decision = evaluateToolMandate("bash", { command: "rm -rf /tmp/x" }, { cwd: "/repo", state: EMPTY, yolo: true });
      expect(decision.outcome).toBe("escalate");
      expect(decision.verbs).toContain("destructive");
    });

    it("still escalates a spend op under always-on + YOLO (no auto-bypass of the spend cap)", () => {
      assertAlwaysOnHardLimitsIntact(mode());
      const decision = evaluateToolMandate("bash", { command: "terraform apply" }, { cwd: "/repo", state: EMPTY, yolo: true });
      expect(decision.outcome).toBe("escalate");
      expect(decision.verbs).toContain("spend");
    });

    it("still escalates a secret-edge write under always-on + YOLO", () => {
      assertAlwaysOnHardLimitsIntact(mode());
      const decision = evaluateToolMandate("bash", { command: "echo token=x > .env" }, { cwd: "/repo", state: EMPTY, yolo: true });
      expect(decision.outcome).toBe("escalate");
      expect(decision.verbs.some((v) => HARD_EDGE_VERBS.has(v))).toBe(true);
    });

    it("deny rules still win over YOLO while always-on is enabled", () => {
      assertAlwaysOnHardLimitsIntact(mode());
      const decision = evaluateToolMandate(
        "bash",
        { command: "npm test" },
        { cwd: "/repo", state: { grants: [], denies: [{ verb: "exec" }] }, yolo: true }
      );
      expect(decision.outcome).toBe("deny");
    });

    it("a hard-edge escalation still defaults to DENY at the approval choke (always-on grants nothing)", async () => {
      assertAlwaysOnHardLimitsIntact(mode());
      const decision = evaluateToolMandate("bash", { command: "rm -rf /tmp/x" }, { cwd: "/repo", state: EMPTY, yolo: true });
      const promptChoices: ApprovalChoice[] = [];
      const allowed = await resolveApproval("bash", decision, {
        sessionApprovals: new Set<MandateVerb>(),
        // The operator declines at the prompt; always-on must not override that.
        prompt: async () => {
          promptChoices.push("deny");
          return "deny";
        }
      });
      expect(allowed).toBe(false);
      expect(promptChoices).toEqual(["deny"]);
    });

    it("an 'always' session grant can never cover a hard edge while always-on runs", async () => {
      assertAlwaysOnHardLimitsIntact(mode());
      const decision = evaluateToolMandate("bash", { command: "terraform apply" }, { cwd: "/repo", state: EMPTY, yolo: true });
      const sessionApprovals = new Set<MandateVerb>();
      await resolveApproval("bash", decision, { sessionApprovals, prompt: async () => "always" });
      // "always" must NOT persist for a hard edge — the next identical call re-prompts.
      expect(sessionApprovals.has("spend")).toBe(false);
    });

    it("throws if the hard-edge constitution set has been weakened (the guard actually guards)", () => {
      const weakened = new Set<MandateVerb>([...HARD_EDGE_VERBS].filter((v) => v !== "spend"));
      expect(() => assertAlwaysOnHardLimitsIntact(mode(), weakened)).toThrow(/always-on/i);
    });
  });
});
