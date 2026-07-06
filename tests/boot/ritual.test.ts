import { describe, expect, it } from "vitest";

import { runBootRitual, type BootRitualHooks, type PhaseOutput } from "../../src/boot/ritual.js";

const okHook = (label: string) => (): PhaseOutput => ({ status: "ok", lines: [label] });

function hooks(over: Partial<BootRitualHooks> = {}): BootRitualHooks {
  return {
    kernelAssert: okHook("kernel"),
    inspectGarage: okHook("garage"),
    injectMemory: okHook("memory"),
    declareWork: okHook("work"),
    baselineHealth: okHook("health"),
    ...over
  };
}

describe("runBootRitual — the enforced ordered ritual (§4)", () => {
  it("ACCEPTANCE: runs exactly five phases IN ORDER with ordinals 1..5", () => {
    const report = runBootRitual(hooks(), 7);
    expect(report.sessionNumber).toBe(7);
    expect(report.phases).toHaveLength(5);
    expect(report.phases.map((p) => p.phase)).toEqual(["kernel", "garage", "memory", "work", "health"]);
    expect(report.phases.map((p) => p.ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(report.phases.map((p) => p.title)).toEqual(["Kernel assertion", "Garage inspection", "Memory injection", "Work declaration", "Baseline health"]);
  });

  it("is NON-SKIPPABLE: a throwing hook degrades to a warn phase, the ritual still completes all five", () => {
    const report = runBootRitual(
      hooks({
        injectMemory: () => {
          throw new Error("boom");
        }
      }),
      1
    );
    expect(report.phases).toHaveLength(5);
    const memory = report.phases.find((p) => p.phase === "memory");
    expect(memory?.status).toBe("warn");
    expect(memory?.lines[0]).toContain("boom");
    // The phases AFTER the failed one still ran.
    expect(report.phases[4]?.phase).toBe("health");
    expect(report.phases[4]?.status).toBe("ok");
  });

  it("preserves each phase's content lines + status", () => {
    const report = runBootRitual(hooks({ baselineHealth: () => ({ status: "skip", lines: ["not configured"] }) }), 2);
    expect(report.phases[4]).toMatchObject({ phase: "health", status: "skip", lines: ["not configured"] });
  });
});
