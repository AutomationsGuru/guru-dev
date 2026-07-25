import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { evaluateToolMandate } from '../../src/mandates/evaluate.js';
import type { MandateState } from '../../src/mandates/schema.js';
import {
  evaluatePlanActGate,
  getMode,
  receiptForDecision,
  setMode
} from '../../src/mandates/planActMode.js';

const EMPTY: MandateState = { grants: [], denies: [] };
const CWD = process.platform === "win32" ? "D:\\work\\repo" : "/work/repo";

describe("planActMode — sticky session mode", () => {
  beforeEach(() => {
    setMode("act");
  });
  afterEach(() => {
    setMode("act");
  });

  it("defaults to act mode (preserves prior mandate behavior)", () => {
    expect(getMode()).toBe("act");
  });

  it("set/get round-trips plan and act", () => {
    setMode("plan");
    expect(getMode()).toBe("plan");
    setMode("act");
    expect(getMode()).toBe("act");
  });

  it("plan mode DENIES a write tool call even under YOLO", () => {
    setMode("plan");
    const decision = evaluatePlanActGate("write", { path: "src/x.ts" }, { cwd: CWD, state: EMPTY, yolo: true });
    expect(decision.outcome).toBe("deny");
    expect(decision.reason).toContain("plan mode");
    expect(decision.verbs).toContain("write");
  });

  it("plan mode DENIES an ordinary exec tool call", () => {
    setMode("plan");
    const decision = evaluatePlanActGate("bash", { command: "npm test" }, { cwd: CWD, state: EMPTY, yolo: true });
    expect(decision.outcome).toBe("deny");
    expect(decision.reason).toContain("plan mode");
  });

  it("plan mode still ALLOWS read-only tools", () => {
    setMode("plan");
    expect(evaluatePlanActGate("read", { path: "src/x.ts" }, { cwd: CWD, state: EMPTY, yolo: false }).outcome).toBe("allow");
    expect(evaluatePlanActGate("ls", {}, { cwd: CWD, state: EMPTY, yolo: false }).outcome).toBe("allow");
    expect(evaluatePlanActGate("grep", {}, { cwd: CWD, state: EMPTY, yolo: false }).outcome).toBe("allow");
  });

  it("plan mode still ESCALATES hard edges — never silently denied (rm -rf)", () => {
    setMode("plan");
    // Hard edges must SURFACE in every mode including plan — a plan-mode deny
    // would hide the destructive call from the operator entirely.
    const decision = evaluatePlanActGate("bash", { command: "rm -rf /tmp/x" }, { cwd: CWD, state: EMPTY, yolo: false });
    expect(decision.outcome).toBe("escalate");
    expect(decision.reason).toContain("hard edge (destructive)");
  });

  it("plan mode still ESCALATES hard edges under YOLO (spend)", () => {
    setMode("plan");
    const decision = evaluatePlanActGate("bash", { command: "terraform apply -auto-approve" }, { cwd: CWD, state: EMPTY, yolo: true });
    expect(decision.outcome).toBe("escalate");
    expect(decision.reason).toContain("hard edge (spend)");
  });

  it("act mode ALLOWS a write under YOLO (prior mandate density unchanged)", () => {
    const decision = evaluatePlanActGate("write", { path: "src/x.ts" }, { cwd: CWD, state: EMPTY, yolo: true });
    expect(decision.outcome).toBe("allow");
  });

  it("act mode under non-YOLO with no grant still ESCALATES (mandate density preserved)", () => {
    const gated = evaluatePlanActGate("write", { path: "src/x.ts" }, { cwd: CWD, state: EMPTY, yolo: false });
    const direct = evaluateToolMandate("write", { path: "src/x.ts" }, { cwd: CWD, state: EMPTY, yolo: false });
    expect(gated.outcome).toBe("escalate");
    expect(gated).toEqual(direct);
  });

  it("act mode matches evaluateToolMandate exactly for a denied verb", () => {
    const denyExec: MandateState = { grants: [], denies: [{ verb: "exec" }] };
    const gated = evaluatePlanActGate("bash", { command: "npm test" }, { cwd: CWD, state: denyExec, yolo: true });
    expect(gated.outcome).toBe("deny");
    expect(gated.reason).toContain("denied by rule");
  });

  it("receipt helper stamps the current mode onto a decision", () => {
    setMode("plan");
    const decision = evaluatePlanActGate("write", { path: "src/x.ts" }, { cwd: CWD, state: EMPTY, yolo: true });
    const receipt = receiptForDecision(decision);
    expect(receipt.mode).toBe("plan");
    expect(receipt.outcome).toBe(decision.outcome);
    expect(receipt.reason).toBe(decision.reason);
    expect(receipt.verbs).toEqual(decision.verbs);
  });

  it("receipt helper accepts an explicit mode override", () => {
    const decision = evaluatePlanActGate("read", {}, { cwd: CWD, state: EMPTY, yolo: false });
    const receipt = receiptForDecision(decision, "plan");
    expect(receipt.mode).toBe("plan");
    expect(receipt.outcome).toBe("allow");
  });
});
