import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { resolveMode, HARD_LIMITS, type AutonomyMode, type ResolvedMode } from '../../src/mandates/autonomyModeBootSelector.js';
import { HARD_EDGE_VERBS } from '../../src/mandates/schema.js';

// ---------------------------------------------------------------------------
// TDD: IDEA-F499-MODEBOOT-01 — autonomy mode boot selector
// ---------------------------------------------------------------------------

describe("resolveMode", () => {
  // -- Known modes -----------------------------------------------------------

  it("resolves 'normal' — no yolo, no plan-only, no auto-accept", () => {
    const resolved = resolveMode("normal");
    expect(resolved).toEqual<ResolvedMode>({
      mode: "normal",
      hardLimitsLifted: false,
      yolo: false,
      planOnly: false,
      autoAccept: false
    });
  });

  it("resolves 'plan' — plan-only, no yolo, no auto-accept", () => {
    const resolved = resolveMode("plan");
    expect(resolved).toEqual<ResolvedMode>({
      mode: "plan",
      hardLimitsLifted: false,
      yolo: false,
      planOnly: true,
      autoAccept: false
    });
  });

  it("resolves 'yolo' — yolo lifts ordinary gates, planOnly false, autoAccept false", () => {
    const resolved = resolveMode("yolo");
    expect(resolved).toEqual<ResolvedMode>({
      mode: "yolo",
      hardLimitsLifted: false,
      yolo: true,
      planOnly: false,
      autoAccept: false
    });
  });

  it("resolves 'auto-accept' — yolo + autoAccept, planOnly false", () => {
    const resolved = resolveMode("auto-accept");
    expect(resolved).toEqual<ResolvedMode>({
      mode: "auto-accept",
      hardLimitsLifted: false,
      yolo: true,
      planOnly: false,
      autoAccept: true
    });
  });

  // -- Unknown mode → fails (plan requirement) --------------------------------

  it("throws on an unknown mode name", () => {
    expect(() => resolveMode("garbage")).toThrow(ZodError);
    expect(() => resolveMode("")).toThrow(ZodError);
    expect(() => resolveMode("YOLO")).toThrow(ZodError); // case-sensitive
    expect(() => resolveMode("auto_accept")).toThrow(ZodError); // hyphen, not underscore
  });

  it("throws on non-string-ish input (Zod rejects before the switch)", () => {
    // resolveMode accepts `string` at the TS level, but Zod's enum parse
    // still rejects these at runtime via the schema.
    expect(() => resolveMode(undefined as unknown as string)).toThrow();
    expect(() => resolveMode(null as unknown as string)).toThrow();
    expect(() => resolveMode(42 as unknown as string)).toThrow();
  });

  // -- yolo hardLimit (plan requirement) -------------------------------------

  it("yolo hardLimit: hardLimitsLifted is ALWAYS false — structurally, at the type level", () => {
    // Every mode, including yolo, must carry hardLimitsLifted: false.
    // The TypeScript type `false` (not `boolean`) enforces this structurally —
    // this test verifies the runtime value for completeness.
    for (const name of ["normal", "plan", "yolo", "auto-accept"] as const) {
      const resolved = resolveMode(name);
      expect(resolved.hardLimitsLifted, `mode=${name}`).toBe(false);
    }
  });

  it("yolo hardLimit: HARD_LIMITS is exactly the constitutional hard-edge verbs", () => {
    // The boot selector's HARD_LIMITS must be identical to the schema's
    // HARD_EDGE_VERBS — they are the same set. If a new hard edge is added
    // to the schema, this test ensures the boot selector tracks it.
    expect(HARD_LIMITS).toBe(HARD_EDGE_VERBS);
    // Also verify the concrete set (regression guard — the set must never shrink).
    expect([...HARD_LIMITS].sort()).toEqual(["auth-edge", "destructive", "secret-edge", "spend"]);
  });

  it("yolo hardLimit: no mode path can produce hardLimitsLifted: true", () => {
    // Structural guarantee: the ResolvedMode type uses `false`, not `boolean`.
    // TypeScript would reject `hardLimitsLifted: true` at compile time.
    // This test confirms that every mode in the runtime table also sets it false.
    const allModes: AutonomyMode[] = ["normal", "plan", "yolo", "auto-accept"];
    for (const mode of allModes) {
      const resolved = resolveMode(mode);
      // Type-narrow: if this were ever `true`, the test fails.
      const lifted: false = resolved.hardLimitsLifted;
      expect(lifted).toBe(false);
    }
  });

  // -- Mode identity ---------------------------------------------------------

  it("returns the exact mode name that was resolved", () => {
    expect(resolveMode("normal").mode).toBe("normal");
    expect(resolveMode("plan").mode).toBe("plan");
    expect(resolveMode("yolo").mode).toBe("yolo");
    expect(resolveMode("auto-accept").mode).toBe("auto-accept");
  });

  // -- Mode semantics (cross-mode invariants) ---------------------------------

  it("only 'plan' sets planOnly", () => {
    for (const name of ["normal", "plan", "yolo", "auto-accept"] as const) {
      const resolved = resolveMode(name);
      expect(resolved.planOnly, `mode=${name}`).toBe(name === "plan");
    }
  });

  it("yolo and auto-accept lift ordinary permission gates; normal and plan do not", () => {
    expect(resolveMode("normal").yolo).toBe(false);
    expect(resolveMode("plan").yolo).toBe(false);
    expect(resolveMode("yolo").yolo).toBe(true);
    expect(resolveMode("auto-accept").yolo).toBe(true);
  });

  it("only auto-accept sets autoAccept", () => {
    for (const name of ["normal", "plan", "yolo", "auto-accept"] as const) {
      const resolved = resolveMode(name);
      expect(resolved.autoAccept, `mode=${name}`).toBe(name === "auto-accept");
    }
  });

  // -- Downstream compatibility ----------------------------------------------

  it("resolved yolo and autoAccept booleans match existing MandateContext convention", () => {
    // The mandate evaluator's MandateContext.yolo is a boolean. ResolvedMode.yolo
    // and ResolvedMode.autoAccept are designed to feed into that context. This
    // test ensures the types are compatible.
    const yoloMode = resolveMode("yolo");
    const ctx: { yolo: boolean } = { yolo: yoloMode.yolo };
    expect(ctx.yolo).toBe(true);

    const normalMode = resolveMode("normal");
    const ctx2: { yolo: boolean } = { yolo: normalMode.yolo };
    expect(ctx2.yolo).toBe(false);
  });
});
