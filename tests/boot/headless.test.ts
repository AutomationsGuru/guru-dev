import { describe, expect, it, vi } from "vitest";

import {
  runHeadlessBootRitual,
  type HeadlessBootRitualInput
} from "../../src/boot/headless.js";
import { BootReportSchema, runBootRitual } from "../../src/boot/ritual.js";

function completeInput(overrides: Partial<HeadlessBootRitualInput> = {}): HeadlessBootRitualInput {
  return {
    cwd: "/home/operator/private-project",
    sessionNumber: 9,
    phaseData: {
      kernel: {
        runtimeName: "guruharness",
        runtimeVersion: "1.5.0",
        resolverReady: true
      },
      garage: {
        manifestCount: 2,
        verifiedLayerCount: 4,
        staleLayerCount: 0
      },
      memory: {
        provider: "markdown",
        status: "ready",
        injectedFactCount: 3
      }
    },
    workDeclaration: {
      availableCapabilityCount: 5,
      missingCapabilityCount: 0
    },
    baselineHealth: () => ({ verdict: "GREEN", durationMs: 12 }),
    ...overrides
  };
}

describe("runHeadlessBootRitual", () => {
  it("invokes the canonical ritual once and returns its exact five-phase order", () => {
    const ritualRunner = vi.fn(runBootRitual);

    const report = runHeadlessBootRitual(completeInput({ ritualRunner }));

    expect(ritualRunner).toHaveBeenCalledTimes(1);
    expect(report.sessionNumber).toBe(9);
    expect(report.phases.map((phase) => phase.phase)).toEqual(["kernel", "garage", "memory", "work", "health"]);
    expect(report.phases.map((phase) => phase.ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(BootReportSchema.parse(report)).toEqual(report);
  });

  it("reports missing headless evidence truthfully without dropping phases", () => {
    const report = runHeadlessBootRitual({ sessionNumber: 0 });

    expect(report.phases.map((phase) => phase.status)).toEqual(["warn", "skip", "skip", "skip", "skip"]);
    expect(report.phases.map((phase) => phase.lines)).toEqual([
      ["kernel evidence unavailable; workspace unavailable"],
      ["garage evidence unavailable"],
      ["memory evidence unavailable"],
      ["work declaration unavailable"],
      ["baseline health probe unavailable"]
    ]);
  });

  it("keeps dry-run deterministic and never executes the health probe", () => {
    const baselineHealth = vi.fn(() => ({ verdict: "GREEN" as const, durationMs: 1 }));
    const input = completeInput({ dryRun: true, baselineHealth });

    const first = runHeadlessBootRitual(input);
    const second = runHeadlessBootRitual(input);

    expect(baselineHealth).not.toHaveBeenCalled();
    expect(second).toEqual(first);
    expect(first.phases[4]).toMatchObject({
      phase: "health",
      status: "skip",
      lines: ["dry-run — baseline health not executed"]
    });
  });

  it("degrades a throwing health probe to bounded warning evidence", () => {
    const sensitiveDiagnostic = "SECRET_ENV_SENTINEL at /home/operator/private";

    const report = runHeadlessBootRitual(
      completeInput({
        baselineHealth: () => {
          throw new Error(sensitiveDiagnostic);
        }
      })
    );

    expect(report.phases).toHaveLength(5);
    expect(report.phases[4]).toMatchObject({
      phase: "health",
      status: "warn",
      lines: ["phase hook failed; continuing"]
    });
    expect(JSON.stringify(report)).not.toContain(sensitiveDiagnostic);
  });

  it("rejects a malformed ritual result at the headless boot boundary", () => {
    expect(() =>
      runHeadlessBootRitual(
        completeInput({
          ritualRunner: () => ({ sessionNumber: 9, phases: [] })
        })
      )
    ).toThrow();
  });

  it("rejects an otherwise valid report with unbounded phase evidence", () => {
    expect(() =>
      runHeadlessBootRitual(
        completeInput({
          ritualRunner: (hooks, sessionNumber) => {
            const report = runBootRitual(hooks, sessionNumber);
            return {
              ...report,
              phases: report.phases.map((phase, index) =>
                index === 0 ? { ...phase, lines: ["x".repeat(241)] } : phase
              )
            };
          }
        })
      )
    ).toThrow();
  });

  it.each([
    ["Linux user home path", "/home/SECRET_HOME_SENTINEL/private"],
    ["Linux root home path", "/root/SECRET_HOME_SENTINEL/private"],
    ["macOS user home path", "/Users/SECRET_HOME_SENTINEL/private"],
    ["Windows user home path", "C:\\Users\\SECRET_HOME_SENTINEL\\private"],
    ["raw environment assignment", "RAW_ENV_SENTINEL=credential-value"],
    ["lowercase secret assignment", "password=SYNTHETIC_SECRET_SENTINEL"],
    ["command output", "command stdout: SYNTHETIC_COMMAND_OUTPUT"],
    ["free-form diagnostic", "unexpected diagnostic payload"]
  ])("rejects unsafe injected report evidence: %s", (_label, unsafeLine) => {
    expect(() =>
      runHeadlessBootRitual(
        completeInput({
          ritualRunner: (hooks, sessionNumber) => {
            const report = runBootRitual(hooks, sessionNumber);
            return {
              ...report,
              phases: report.phases.map((phase, index) =>
                index === 0 ? { ...phase, lines: [unsafeLine] } : phase
              )
            };
          }
        })
      )
    ).toThrow();
  });

  it("emits only bounded allowlisted evidence and never the supplied cwd", () => {
    const sensitiveCwd = "/home/SECRET_HOME_SENTINEL/private-project";
    const report = runHeadlessBootRitual(completeInput({ cwd: sensitiveCwd }));
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain(sensitiveCwd);
    for (const phase of report.phases) {
      expect(phase.lines.length).toBeLessThanOrEqual(8);
      for (const line of phase.lines) {
        expect(line.length).toBeLessThanOrEqual(240);
      }
    }
  });

  it("rejects non-allowlisted phase data instead of leaking raw environment fields", () => {
    const input = {
      ...completeInput(),
      phaseData: {
        ...completeInput().phaseData,
        kernel: {
          runtimeName: "guruharness",
          runtimeVersion: "1.5.0",
          resolverReady: true,
          rawEnvironment: "RAW_ENV_SENTINEL"
        }
      }
    } as unknown as HeadlessBootRitualInput;

    expect(() => runHeadlessBootRitual(input)).toThrow();
  });

  it("rejects free-form kernel identifiers instead of treating them as safe evidence", () => {
    const input = {
      ...completeInput(),
      phaseData: {
        ...completeInput().phaseData,
        kernel: {
          runtimeName: "RAW_ENV_SENTINEL",
          runtimeVersion: "1.5.0",
          resolverReady: true
        }
      }
    } as unknown as HeadlessBootRitualInput;

    expect(() => runHeadlessBootRitual(input)).toThrow();
  });
});
