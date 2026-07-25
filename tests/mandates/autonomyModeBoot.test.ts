import { describe, expect, it } from "vitest";

import { AUTONOMY_MODES, isAutonomyMode, resolveMode } from '../../src/mandates/autonomyModeBoot.js';
import type { AutonomyMode, ModeApprovalDefaults } from '../../src/mandates/autonomyModeBoot.js';

// ── resolveMode ──────────────────────────────────────────────────────────────

describe("resolveMode", () => {
  it("maps each canonical mode name to its defaults", () => {
    const expected: Record<AutonomyMode, ModeApprovalDefaults> = {
      normal: { escalateDefault: "prompt", hardLimitDeny: true, allowAutoEscalate: false },
      plan: { escalateDefault: "deny", hardLimitDeny: true, allowAutoEscalate: false },
      yolo: { escalateDefault: "approve", hardLimitDeny: true, allowAutoEscalate: true },
      "auto-accept": { escalateDefault: "approve", hardLimitDeny: true, allowAutoEscalate: true }
    };

    for (const mode of AUTONOMY_MODES) {
      const result = resolveMode(mode);
      expect(result.mode).toBe(mode);
      expect(result.defaults).toEqual(expected[mode]);
    }
  });

  it("trims and lowercases the input", () => {
    expect(resolveMode("  YOLO  ").mode).toBe("yolo");
    expect(resolveMode("Plan").mode).toBe("plan");
    expect(resolveMode("Auto-Accept").mode).toBe("auto-accept");
    expect(resolveMode("NORMAL").mode).toBe("normal");
  });

  it("unknown mode throws — fail closed (R-NC-MODEBOOT)", () => {
    expect(() => resolveMode("super-yolo")).toThrow("Unknown autonomy mode");
    expect(() => resolveMode("")).toThrow("Unknown autonomy mode");
    expect(() => resolveMode("safe")).toThrow("Unknown autonomy mode");
    expect(() => resolveMode("yoloo")).toThrow("Unknown autonomy mode");
  });

  it("unknown mode error message lists valid modes", () => {
    try {
      resolveMode("banana");
      expect.fail("expected throw");
    } catch (e: unknown) {
      const msg = (e as Error).message;
      for (const m of AUTONOMY_MODES) {
        expect(msg).toContain(m);
      }
    }
  });
});

// ── hardLimitDeny invariant ──────────────────────────────────────────────────

describe("hardLimitDeny — constitutional invariant (R-NC-MODEBOOT)", () => {
  it("every mode — including yolo — has hardLimitDeny:true", () => {
    for (const mode of AUTONOMY_MODES) {
      const result = resolveMode(mode);
      expect(
        result.defaults.hardLimitDeny,
        `${mode} must have hardLimitDeny:true — hard limits are never lifted`
      ).toBe(true);
    }
  });

  it("yolo lifts ordinary escalations but hardLimitDeny is structurally true", () => {
    const yolo = resolveMode("yolo");
    // Ordinary non-hard-edge escalations auto-approve under yolo.
    expect(yolo.defaults.escalateDefault).toBe("approve");
    expect(yolo.defaults.allowAutoEscalate).toBe(true);
    // But the hard-limit flag is immutable — true for every mode, including yolo.
    expect(yolo.defaults.hardLimitDeny).toBe(true);
  });

  it("the hardLimitDeny type is `true` — not boolean — so no mode can set false", () => {
    // This is a compile-time invariant: ModeApprovalDefaults.hardLimitDeny is
    // typed `true` (a literal), not `boolean`.  If any DEFAULTS entry tried to
    // set it to false, TypeScript would reject the assignment.  This test
    // confirms the runtime values match the compile-time guarantee.
    const defaults: ModeApprovalDefaults = resolveMode("yolo").defaults;
    const _check: true = defaults.hardLimitDeny;
    expect(_check).toBe(true);
  });
});

// ── isAutonomyMode guard ─────────────────────────────────────────────────────

describe("isAutonomyMode", () => {
  it("returns true for each canonical mode", () => {
    for (const mode of AUTONOMY_MODES) {
      expect(isAutonomyMode(mode)).toBe(true);
    }
  });

  it("returns true for case/whitespace variants", () => {
    expect(isAutonomyMode("YOLO")).toBe(true);
    expect(isAutonomyMode("  plan  ")).toBe(true);
    expect(isAutonomyMode("Auto-Accept")).toBe(true);
  });

  it("returns false for unknown names", () => {
    expect(isAutonomyMode("super-yolo")).toBe(false);
    expect(isAutonomyMode("")).toBe(false);
    expect(isAutonomyMode("safe")).toBe(false);
  });
});

// ── mode-specific posture ────────────────────────────────────────────────────

describe("mode posture", () => {
  it("normal mode: prompts for everything, no auto-escalate", () => {
    const n = resolveMode("normal");
    expect(n.defaults.escalateDefault).toBe("prompt");
    expect(n.defaults.allowAutoEscalate).toBe(false);
  });

  it("plan mode: denies writes, no auto-escalate (plan-only posture)", () => {
    const p = resolveMode("plan");
    expect(p.defaults.escalateDefault).toBe("deny");
    expect(p.defaults.allowAutoEscalate).toBe(false);
  });

  it("auto-accept mode: approves non-hard-edge, allows auto-escalate", () => {
    const aa = resolveMode("auto-accept");
    expect(aa.defaults.escalateDefault).toBe("approve");
    expect(aa.defaults.allowAutoEscalate).toBe(true);
  });
});
