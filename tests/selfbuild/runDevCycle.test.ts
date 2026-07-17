import { describe, expect, it, vi } from "vitest";

import {
  failClosedMandatePolicy,
  runDevCycle,
  yoloMandatePolicy,
  type SelfBuildExecutorFn,
  type StageRunner
} from "../../src/selfbuild/runDevCycle.js";
import type { SelfBuildExecutorReport } from "../../src/executor/selfBuildExecutor.js";
import type { CommandExecutor } from "../../src/review/gates.js";
import type { Clock, DevStage, StageOutcome } from "../../src/selfbuild/devCycle.js";
import type { DevCycleCheckpoint } from "../../src/selfbuild/devCycleCheckpoint.js";
import type { DevCycleCheckpointController } from "../../src/selfbuild/runDevCycle.js";
import type { GateFailureNote } from "../../src/selfbuild/parseGateFailure.js";
import type { LearnedFact } from "../../src/selfbuild/learn.js";
import { makeSmokeDeps } from "../../src/selfbuild/smokeDeps.js";
import { createApprovalLedger } from "../../src/selfbuild/approvalLedger.js";
import type { AskModel } from "../../src/review/nativeCriticPanel.js";

type RepairFn = (note: GateFailureNote) => Promise<{ repaired: boolean; evidence: string }>;

/** A minimal executor report stub — enough for runDevCycle's build-stage mapping. */
function fakeReport(over: Partial<SelfBuildExecutorReport> = {}): SelfBuildExecutorReport {
  return {
    verdict: "YELLOW",
    session: {} as SelfBuildExecutorReport["session"],
    planner: { status: "completed" } as SelfBuildExecutorReport["planner"],
    plannerUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    plannerFallback: null,
    observability: {} as SelfBuildExecutorReport["observability"],
    reviewGates: null,
    gitPr: null,
    implementation: {} as SelfBuildExecutorReport["implementation"],
    blocker: null,
    donePacket: {} as SelfBuildExecutorReport["donePacket"],
    ...over
  } as SelfBuildExecutorReport;
}

/** GREEN stubs for the gating stages, so the happy path never runs real npm/model calls. */
const greenGating: Partial<Record<DevStage, StageRunner>> = {
  test: async () => ({ verdict: "GREEN", evidence: "test-stub" }),
  smoke: async () => ({ verdict: "GREEN", evidence: "smoke-stub" }),
  review: async () => ({ verdict: "GREEN", evidence: "review-stub" }),
  ship: async () => ({ verdict: "GREEN", evidence: "ship-stub" }),
  learn: async () => ({ verdict: "GREEN", evidence: "learn-stub" })
};

const passExec: CommandExecutor = async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 });
const failGate = (name: string): CommandExecutor => async (_c, ctx) => ({ exitCode: ctx.gate.name === name ? 1 : 0, stdout: "", stderr: "", durationMs: 0 });

type WorkingStage = Exclude<DevStage, "done" | "blocked">;
type CheckpointOutcome = StageOutcome & { readonly stage: WorkingStage };

function completedBefore(stage: WorkingStage): CheckpointOutcome[] {
  const green = (completedStage: WorkingStage): CheckpointOutcome => ({
    stage: completedStage,
    verdict: "GREEN",
    evidence: `${completedStage} complete`
  });
  const prefix = [green("select"), green("build"), green("test"), green("smoke"), green("review"), green("ship")];
  switch (stage) {
    case "select":
      return [];
    case "build":
      return prefix.slice(0, 1);
    case "test":
      return prefix.slice(0, 2);
    case "smoke":
      return prefix.slice(0, 3);
    case "review":
      return prefix.slice(0, 4);
    case "ship":
      return prefix.slice(0, 5);
    case "learn":
      return prefix;
    case "debug":
      return [green("select"), green("build"), { stage: "test", verdict: "RED", evidence: "test failed" }];
  }
}

function resumeCheckpoint(over: Partial<DevCycleCheckpoint> = {}): DevCycleCheckpoint {
  return {
    schemaVersion: 1,
    cycleId: "resume-cycle-1",
    cwd: process.cwd(),
    selectedTaskId: "persisted-task",
    stage: "test",
    stageState: "pending",
    completedStages: [
      { stage: "select", verdict: "GREEN", evidence: "selected" },
      { stage: "build", verdict: "GREEN", evidence: "built" }
    ],
    lastFailure: null,
    executorSessionId: null,
    budget: {
      attempts: 1,
      maxIterations: 6,
      tokens: 200,
      tokenBudget: 500_000,
      spentUsd: 0,
      ceilingUsd: 0,
      elapsedMs: 100,
      wallClockMs: 1_800_000
    },
    status: "running",
    verdict: null,
    learned: null,
    resumeReruns: [],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...over
  };
}

function checkpointController(initial?: DevCycleCheckpoint): {
  readonly controller: DevCycleCheckpointController;
  readonly saved: DevCycleCheckpoint[];
} {
  const saved: DevCycleCheckpoint[] = [];
  return {
    controller: {
      cycleId: initial?.cycleId ?? "new-cycle-1",
      ...(initial ? { resume: initial } : {}),
      now: () => new Date("2026-07-15T01:00:00.000Z"),
      save: (checkpoint) => {
        saved.push(structuredClone(checkpoint));
      }
    },
    saved
  };
}

describe("failClosedMandatePolicy (P7) — spend/mutation escalate, read-only allowed", () => {
  const policy = failClosedMandatePolicy();

  it("a mutating filesystem write escalates (blocked on the non-interactive path)", () => {
    expect(policy("fs.write", { path: "src/x.ts", content: "x" }, process.cwd())?.outcome).not.toBe("allow");
  });

  it("a read-only tool is allowed", () => {
    expect(policy("repo.context.resolve", { cwd: process.cwd() }, process.cwd())?.outcome).toBe("allow");
  });
});

describe("yoloMandatePolicy (P7) — spend is the one gate YOLO cannot lift", () => {
  const policy = yoloMandatePolicy();

  it("a spend command (terraform apply) STILL escalates in YOLO", () => {
    expect(policy("bash", { command: "terraform apply" }, process.cwd())?.outcome).toBe("escalate");
  });

  it("a destructive command STILL escalates in YOLO", () => {
    expect(policy("bash", { command: "rm -rf /" }, process.cwd())?.outcome).toBe("escalate");
  });

  it("an ordinary command IS lifted by YOLO (allowed)", () => {
    expect(policy("bash", { command: "echo hello" }, process.cwd())?.outcome).toBe("allow");
  });

  it("runDevCycle threads whatever policy it is given into the executor (spend gate stays live)", async () => {
    const executor = vi.fn<SelfBuildExecutorFn>(async () => fakeReport());
    await runDevCycle({ executor, mandatePolicy: yoloMandatePolicy(), stages: greenGating });
    const passed = executor.mock.calls[0]![0];
    expect(passed.mandatePolicy!("bash", { command: "terraform apply" }, process.cwd())?.outcome).toBe("escalate");
  });
});

describe("runDevCycle (P7 spine) — gate + budget injection", () => {
  it("passes a fail-closed mandate policy to the executor by default", async () => {
    const executor = vi.fn<SelfBuildExecutorFn>(async () => fakeReport());
    await runDevCycle({ executor, stages: greenGating });
    const passed = executor.mock.calls[0]![0];
    expect(passed.mandatePolicy).toBeDefined();
    expect(passed.mandatePolicy!("fs.write", { path: "a", content: "b" }, process.cwd())?.outcome).not.toBe("allow");
    expect(passed.includeReviewGate).toBe(false); // runDevCycle owns REVIEW
  });

  it("bounds the executor's planner retries by the attempt cap", async () => {
    const executor = vi.fn<SelfBuildExecutorFn>(async () => fakeReport());
    await runDevCycle({ executor, budget: { maxIterations: 3 }, stages: greenGating });
    expect(executor.mock.calls[0]![0].maxPlannerRetries).toBeLessThanOrEqual(3);
  });

  it("refuses to run the executor when the budget is already exhausted", async () => {
    let calls = 0;
    const clock: Clock = { now: () => (calls++ === 0 ? 0 : 10_000) };
    const executor = vi.fn<SelfBuildExecutorFn>(async () => fakeReport());
    const report = await runDevCycle({ executor, clock, budget: { wallClockMs: 100 }, stages: greenGating });
    expect(executor).not.toHaveBeenCalled();
    expect(report.terminal).toBe("blocked");
    expect(report.stages[0]!.evidence).toMatch(/wall-clock/u);
  });

  it("draws default BUILD planner usage from the token budget", async () => {
    const report = await runDevCycle({
      executor: async () => fakeReport({ plannerUsage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 } }),
      stages: greenGating
    });

    expect(report.budget.tokens).toBe(12);
  });

  it("adds default DEBUG re-plan usage to prior BUILD usage", async () => {
    const executor = vi
      .fn<SelfBuildExecutorFn>()
      .mockResolvedValueOnce(fakeReport({ plannerUsage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }))
      .mockResolvedValueOnce(fakeReport({ plannerUsage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } }));
    let smokeRuns = 0;

    const report = await runDevCycle({
      executor,
      smoke: { runSmoke: async () => ({ verdict: smokeRuns++ === 0 ? "RED" : "GREEN" }) },
      stages: {
        test: async () => ({ verdict: "GREEN", evidence: "test-stub" }),
        review: async () => ({ verdict: "GREEN", evidence: "review-stub" }),
        ship: async () => ({ verdict: "GREEN", evidence: "ship-stub" }),
        learn: async () => ({ verdict: "GREEN", evidence: "learn-stub" })
      }
    });

    expect(executor).toHaveBeenCalledTimes(2);
    expect(report.budget.tokens).toBe(11);
  });

  it("records an executor retry/fallback total exactly once", async () => {
    const cumulativeUsage = { inputTokens: 10, outputTokens: 6, totalTokens: 16 };
    const report = await runDevCycle({
      executor: async () =>
        fakeReport({
          plannerUsage: cumulativeUsage,
          plannerFallback: { cumulativeUsage } as SelfBuildExecutorReport["plannerFallback"]
        }),
      stages: greenGating
    });

    expect(report.budget.tokens).toBe(16);
  });

  it("blocks before the next stage after BUILD reaches the token ceiling", async () => {
    const testStage = vi.fn<StageRunner>(async () => ({ verdict: "GREEN", evidence: "should not run" }));
    const report = await runDevCycle({
      executor: async () => fakeReport({ plannerUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }),
      budget: { tokenBudget: 10 },
      stages: { ...greenGating, test: testStage }
    });

    expect(testStage).not.toHaveBeenCalled();
    expect(report.terminal).toBe("blocked");
    expect(report.budget.tokens).toBe(10);
    expect(report.stages.at(-1)).toMatchObject({ stage: "test", verdict: "RED", evidence: expect.stringContaining("token budget exhausted") });
  });
});

describe("runDevCycle (P7 spine) — 0→7 stage routing", () => {
  it("drives the full happy path SELECT→…→LEARN → done", async () => {
    const report = await runDevCycle({ executor: async () => fakeReport(), stages: greenGating });
    expect(report.terminal).toBe("done");
    expect(report.stages.map((s) => s.stage)).toEqual(["select", "build", "test", "smoke", "review", "ship", "learn"]);
  });

  it("emits a per-stage 0→7 event for each completed stage (observable run)", async () => {
    const events: string[] = [];
    await runDevCycle({
      executor: async () => fakeReport(),
      stages: greenGating,
      onStage: (event) => {
        events.push(event.stage);
      }
    });
    expect(events).toEqual(["select", "build", "test", "smoke", "review", "ship", "learn"]);
  });

  it("a failed BUILD (planner not completed) → blocked before TEST", async () => {
    const report = await runDevCycle({
      executor: async () => fakeReport({ planner: { status: "blocked" } as SelfBuildExecutorReport["planner"] }),
      stages: greenGating
    });
    expect(report.terminal).toBe("blocked");
    expect(report.stages.map((s) => s.stage)).toEqual(["select", "build"]);
  });
});

describe("runDevCycle (P7 spine) — the real organs run", () => {
  it("TEST runs the project's DISCOVERED gates; a persistently-failing gate → RED → DEBUG → bounded blocked", async () => {
    const report = await runDevCycle({
      executor: async () => fakeReport(),
      executorOptions: { commandExecutor: failGate("test") }, // discovers this repo's npm gates, fails `test`
      budget: { maxIterations: 2 }
    });
    const test = report.stages.find((s) => s.stage === "test");
    expect(test?.verdict).toBe("RED");
    expect(report.stages.some((s) => s.stage === "debug")).toBe(true);
    expect(report.terminal).toBe("blocked");
  });

  it("TEST GREEN then SMOKE runs the injected capability-smoke + self-call; SMOKE RED → DEBUG → blocked", async () => {
    const report = await runDevCycle({
      executor: async () => fakeReport(),
      executorOptions: { commandExecutor: passExec },
      smoke: { runSmoke: async () => ({ verdict: "RED" }) }
    });
    expect(report.stages.find((s) => s.stage === "smoke")?.verdict).toBe("RED");
    expect(report.terminal).toBe("blocked");
  });

  it("REVIEW runs the injected live native reviewer; a RED verdict blocks SHIP", async () => {
    const report = await runDevCycle({
      executor: async () => fakeReport(),
      stages: { test: async () => ({ verdict: "GREEN", evidence: "t" }), smoke: async () => ({ verdict: "GREEN", evidence: "s" }) },
      nativeReviewer: async (gate, cwd) => ({
        ...gate,
        exitCode: 1,
        stdout: "",
        stderr: "",
        durationMs: 0,
        status: "failed",
        verdict: "RED",
        summary: `native panel RED at ${cwd}`
      })
    });
    expect(report.stages.find((s) => s.stage === "review")?.verdict).toBe("RED");
    expect(report.stages.some((s) => s.stage === "ship")).toBe(false); // review-RED never ships
    expect(report.terminal).toBe("blocked");
  });

  it("REVIEW builds a live reviewer from an askModel (no explicit nativeReviewer needed)", async () => {
    const askModel = async (_prompt: string, meta: { phase: "find" | "verify" }) =>
      meta.phase === "find" ? "[]" : JSON.stringify({ confirmed: false, reason: "n/a" });
    const report = await runDevCycle({
      executor: async () => fakeReport(),
      stages: {
        test: async () => ({ verdict: "GREEN", evidence: "t" }),
        smoke: async () => ({ verdict: "GREEN", evidence: "s" }),
        ship: async () => ({ verdict: "GREEN", evidence: "sh" })
      },
      askModel,
      reviewContext: async () => ({ diff: "a change under review" })
    });
    const review = report.stages.find((s) => s.stage === "review");
    expect(review?.verdict).toBe("GREEN"); // the panel actually ran — not the YELLOW "not wired" path
    expect(review?.evidence).not.toMatch(/not wired/u);
    expect(report.terminal).toBe("done");
  });

  it("REVIEW with no reviewer wired is a legible YELLOW (never a silent pass)", async () => {
    const report = await runDevCycle({
      executor: async () => fakeReport(),
      stages: {
        test: async () => ({ verdict: "GREEN", evidence: "t" }),
        smoke: async () => ({ verdict: "GREEN", evidence: "s" }),
        ship: async () => ({ verdict: "GREEN", evidence: "sh" })
      }
    });
    const review = report.stages.find((s) => s.stage === "review");
    expect(review?.verdict).toBe("YELLOW");
    expect(review?.evidence).toMatch(/not wired/u);
    expect(report.terminal).toBe("done"); // YELLOW still advances to ship→learn→done
  });

  it("SHIP presence-detects: git absent → durable on-disk change-record, then LEARN → done", async () => {
    const wrote: string[] = [];
    const report = await runDevCycle({
      executor: async () => fakeReport(),
      stages: {
        test: async () => ({ verdict: "GREEN", evidence: "t" }),
        smoke: async () => ({ verdict: "GREEN", evidence: "s" }),
        review: async () => ({ verdict: "GREEN", evidence: "r" })
      },
      executorOptions: { taskId: "ship-me" },
      shipDeps: {
        commandExists: () => false, // git absent
        writeChangeRecord: (_record, path) => {
          wrote.push(path);
        }
      }
    });
    const ship = report.stages.find((s) => s.stage === "ship");
    expect(ship?.verdict).toBe("YELLOW");
    expect(ship?.evidence).toMatch(/change-record/u);
    expect(wrote).toHaveLength(1);
    expect(wrote[0]).toMatch(/ship-me\.json$/u);
    expect(report.terminal).toBe("done");
  });
});

describe("runDevCycle (P3) — DEBUG-on-red bounded repair", () => {
  it("a one-shot-fixable failure is repaired within budget → done", async () => {
    let round = 0;
    // The discovered `test` gate fails the first round, passes after the repair.
    const commandExecutor: CommandExecutor = async (_c, ctx) => ({
      exitCode: ctx.gate.name === "test" && round++ === 0 ? 1 : 0,
      stdout: "",
      stderr: "FAIL tests/x.test.ts",
      durationMs: 0
    });
    const repair = vi.fn<RepairFn>(async () => ({ repaired: true, evidence: "applied the fix" }));

    const report = await runDevCycle({
      executor: async () => fakeReport(),
      executorOptions: { commandExecutor },
      stages: { review: async () => ({ verdict: "GREEN", evidence: "r" }), ship: async () => ({ verdict: "GREEN", evidence: "sh" }) },
      repair
    });

    // DEBUG got a parsed note for the `test` gate and repaired it; TEST ran twice.
    expect(repair).toHaveBeenCalledTimes(1);
    expect(repair.mock.calls[0]![0].gate).toBe("test");
    expect(report.stages.filter((s) => s.stage === "test")).toHaveLength(2);
    expect(report.terminal).toBe("done");
  });

  it("an unfixable failure is BOUNDED by the attempt cap → blocked (never an infinite loop)", async () => {
    const commandExecutor: CommandExecutor = async (_c, ctx) => ({
      exitCode: ctx.gate.name === "test" ? 1 : 0, // always fails
      stdout: "",
      stderr: "error TS9999: unfixable",
      durationMs: 0
    });
    const report = await runDevCycle({
      executor: async () => fakeReport(),
      executorOptions: { commandExecutor },
      budget: { maxIterations: 3 },
      repair: async () => ({ repaired: true, evidence: "keeps trying" }) // pretends to fix, but TEST stays RED
    });

    expect(report.terminal).toBe("blocked");
    // build(1) + at most 2 more debug attempts before the cap halts it — bounded, not infinite.
    expect(report.stages.filter((s) => s.stage === "debug").length).toBeLessThanOrEqual(3);
    expect(report.budget.attempts).toBeLessThanOrEqual(3);
  });
});

describe("runDevCycle (P7) — full unattended cycle, REAL stages, only leaf I/O stubbed", () => {
  it("runs SELECT→BUILD→TEST→SMOKE→REVIEW→SHIP→LEARN end-to-end → done with a complete report", async () => {
    const wrote: string[] = [];
    const askModel: AskModel = async (_prompt, meta) => (meta.phase === "find" ? "[]" : JSON.stringify({ confirmed: false, reason: "n/a" }));
    const report = await runDevCycle({
      // BUILD — planner completes (stub executor is the only lane needing a model/tools).
      executor: async () => fakeReport(),
      // TEST — real discovery of THIS repo's gates, run through a passing stub executor.
      executorOptions: { taskId: "end-to-end", commandExecutor: passExec },
      // SMOKE — the real makeSmokeDeps assembly, capability-smoke stubbed GREEN.
      smoke: makeSmokeDeps({
        runCapabilitySmoke: async () => ({ verdict: "GREEN" }),
        // E2E uses a stub nucleus; skip the real session self-call (slow on shares).
        skipSelfCall: true
      }),
      // REVIEW — the real live-reviewer factory + panel, model stubbed (finds nothing).
      askModel,
      reviewContext: async () => ({ diff: "a real change under review" }),
      // SHIP — the real presence-detect stage, git absent → durable change-record.
      shipDeps: { commandExists: () => false, writeChangeRecord: (_r, path) => { wrote.push(path); } },
      ledger: createApprovalLedger()
    });

    expect(report.terminal).toBe("done");
    expect(report.stages.map((s) => s.stage)).toEqual(["select", "build", "test", "smoke", "review", "ship", "learn"]);
    expect(report.stages.find((s) => s.stage === "review")?.verdict).toBe("GREEN"); // the panel actually ran
    expect(report.learned?.outcome).toBe("shipped");
    expect(wrote).toHaveLength(1); // delivered via the durable change-record
  });
});

describe("runDevCycle (P4) — SELECT scoring + LEARN write-back", () => {
  it("SELECT scores the ready set and threads the chosen task into BUILD", async () => {
    const executor = vi.fn<SelfBuildExecutorFn>(async () => fakeReport());
    await runDevCycle({
      executor,
      tasks: [
        { id: "low", ready: true, priority: 1 },
        { id: "high", ready: true, priority: 9 },
        { id: "not-ready", ready: false, priority: 99 }
      ],
      stages: greenGating
    });
    expect(executor.mock.calls[0]![0].taskId).toBe("high");
  });

  it("SELECT with no ready task → done, executor never called", async () => {
    const executor = vi.fn<SelfBuildExecutorFn>(async () => fakeReport());
    const report = await runDevCycle({ executor, tasks: [{ id: "x", ready: false }], stages: greenGating });
    expect(executor).not.toHaveBeenCalled();
    expect(report.stages.map((s) => s.stage)).toEqual(["select"]);
    expect(report.terminal).toBe("done");
    expect(report.verdict).toBe("YELLOW"); // nothing to do is not a false GREEN
  });

  it("LEARN records ONE validated fact on a clean success (report.learned + sink)", async () => {
    const facts: LearnedFact[] = [];
    const report = await runDevCycle({
      executor: async () => fakeReport(),
      executorOptions: { taskId: "ship-me" },
      // leave `learn` as the real default; stub the rest GREEN so the cycle completes cleanly
      stages: {
        test: async () => ({ verdict: "GREEN", evidence: "t" }),
        smoke: async () => ({ verdict: "GREEN", evidence: "s" }),
        review: async () => ({ verdict: "GREEN", evidence: "r" }),
        ship: async () => ({ verdict: "GREEN", evidence: "sh" })
      },
      recordFact: (fact) => {
        facts.push(fact);
      }
    });
    expect(report.terminal).toBe("done");
    expect(report.verdict).toBe("GREEN"); // a clean cycle actually reports GREEN (LEARN no longer hardcodes YELLOW)
    expect(report.learned?.taskId).toBe("ship-me");
    expect(report.learned?.outcome).toBe("shipped");
    expect(facts).toHaveLength(1);
  });

  it("a blocked cycle learns the blocker (feeds the next SELECT)", async () => {
    const report = await runDevCycle({
      executor: async () => fakeReport({ planner: { status: "blocked" } as SelfBuildExecutorReport["planner"] }),
      executorOptions: { taskId: "t2" },
      stages: greenGating
    });
    expect(report.terminal).toBe("blocked");
    expect(report.learned?.outcome).toBe("blocked");
    expect(report.learned?.blockerNote).toBeDefined();
  });
});

describe("runDevCycle (G102) — checkpoint and safe resume", () => {
  it("skips completed stages and continues exactly once from the recorded boundary", async () => {
    const executor = vi.fn<SelfBuildExecutorFn>(async () => fakeReport());
    const { controller } = checkpointController(resumeCheckpoint());

    const report = await runDevCycle({ executor, checkpoint: controller, stages: greenGating });

    expect(executor).not.toHaveBeenCalled();
    expect(report.cycleId).toBe("resume-cycle-1");
    expect(report.stages.map((stage) => stage.stage)).toEqual(["select", "build", "test", "smoke", "review", "ship", "learn"]);
    expect(report.budget).toMatchObject({ attempts: 1, tokens: 200 });
  });

  it("preserves the selected task and structured failure note across a restart", async () => {
    const failure: GateFailureNote = {
      gate: "test",
      kind: "vitest",
      summary: "persisted failure",
      failures: ["FAIL persisted.test.ts"],
      raw: "FAIL persisted.test.ts"
    };
    const repair = vi.fn<RepairFn>(async () => ({ repaired: true, evidence: "repaired persisted failure" }));
    const { controller } = checkpointController(
      resumeCheckpoint({
        stage: "debug",
        lastFailure: { ...failure, failures: [...failure.failures] },
        completedStages: completedBefore("debug")
      })
    );

    const report = await runDevCycle({
      checkpoint: controller,
      repair,
      executor: async () => fakeReport(),
      stages: {
        test: async () => ({ verdict: "GREEN", evidence: "test" }),
        smoke: async () => ({ verdict: "GREEN", evidence: "smoke" }),
        review: async () => ({ verdict: "GREEN", evidence: "review" }),
        ship: async () => ({ verdict: "GREEN", evidence: "ship" })
      }
    });

    expect(repair).toHaveBeenCalledWith(failure);
    expect(report.learned?.taskId).toBe("persisted-task");
  });

  it("blocks before another stage when the hydrated budget is already exhausted", async () => {
    const stage = vi.fn<StageRunner>(async () => ({ verdict: "GREEN", evidence: "must not run" }));
    const { controller, saved } = checkpointController(
      resumeCheckpoint({ budget: { ...resumeCheckpoint().budget, attempts: 6 } })
    );

    const report = await runDevCycle({ checkpoint: controller, stages: { test: stage } });

    expect(stage).not.toHaveBeenCalled();
    expect(report.terminal).toBe("blocked");
    expect(report.budget.attempts).toBe(6);
    expect(report.stages.at(-1)?.evidence).toMatch(/attempt cap reached \(6\/6\)/u);
    expect(saved).toEqual([]);
  });

  it.each(["test", "smoke", "review"] as const)(
    "reruns only interrupted read-only %s and records the rerun explicitly",
    async (interruptedStage) => {
      const stage = vi.fn<StageRunner>(async () => ({ verdict: "GREEN", evidence: `reran ${interruptedStage}` }));
      const { controller, saved } = checkpointController(
        resumeCheckpoint({ stage: interruptedStage, stageState: "running", completedStages: completedBefore(interruptedStage) })
      );

      const report = await runDevCycle({
        checkpoint: controller,
        executor: async () => fakeReport(),
        stages: { ...greenGating, [interruptedStage]: stage }
      });

      expect(stage).toHaveBeenCalledTimes(1);
      expect(report.stages[completedBefore(interruptedStage).length]?.stage).toBe(interruptedStage);
      expect(saved.some((checkpoint) => checkpoint.resumeReruns.some((entry) => entry.stage === interruptedStage))).toBe(true);
    }
  );

  it("resumes an interrupted BUILD through the captured executor session id", async () => {
    const executor = vi.fn<SelfBuildExecutorFn>(async (options) => {
      await options.onSessionStarted?.("executor-session-1");
      return fakeReport();
    });
    const { controller } = checkpointController(
      resumeCheckpoint({
        stage: "build",
        stageState: "running",
        completedStages: completedBefore("build"),
        executorSessionId: "executor-session-1"
      })
    );

    await runDevCycle({ checkpoint: controller, executor, stages: greenGating });

    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]![0].resumeSessionId).toBe("executor-session-1");
  });

  it("resumes an interrupted DEBUG re-plan through the captured executor session id", async () => {
    const executor = vi.fn<SelfBuildExecutorFn>(async (options) => {
      await options.onSessionStarted?.("debug-session-1");
      return fakeReport();
    });
    const { controller } = checkpointController(
      resumeCheckpoint({
        stage: "debug",
        stageState: "running",
        completedStages: completedBefore("debug"),
        executorSessionId: "debug-session-1",
        lastFailure: { gate: "test", kind: "vitest", summary: "failed", failures: ["FAIL"], raw: "FAIL" }
      })
    );

    await runDevCycle({ checkpoint: controller, executor, stages: greenGating });

    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]![0].resumeSessionId).toBe("debug-session-1");
  });

  it.each(["build", "debug"] as const)(
    "fails closed for interrupted %s without a continuation session id",
    async (interruptedStage) => {
      const executor = vi.fn<SelfBuildExecutorFn>(async () => fakeReport());
      const repair = vi.fn<RepairFn>(async () => ({ repaired: true, evidence: "must not run" }));
      const { controller } = checkpointController(
        resumeCheckpoint({
          stage: interruptedStage,
          stageState: "running",
          completedStages: completedBefore(interruptedStage),
          lastFailure:
            interruptedStage === "debug"
              ? { gate: "test", kind: "vitest", summary: "failed", failures: ["FAIL"], raw: "FAIL" }
              : null
        })
      );

      const report = await runDevCycle({ checkpoint: controller, executor, repair, stages: greenGating });

      expect(report.terminal).toBe("blocked");
      expect(report.summary).toMatch(/resume|continuation/i);
      expect(executor).not.toHaveBeenCalled();
      expect(repair).not.toHaveBeenCalled();
    }
  );

  it.each(["ship", "learn"] as const)("never replays an interrupted %s stage", async (interruptedStage) => {
    const ship = vi.fn<StageRunner>(async () => ({ verdict: "GREEN", evidence: "must not ship" }));
    const recordFact = vi.fn<(fact: LearnedFact) => void>();
    const { controller } = checkpointController(
      resumeCheckpoint({
        stage: interruptedStage,
        stageState: "running",
        completedStages: completedBefore(interruptedStage)
      })
    );

    const report = await runDevCycle({ checkpoint: controller, ship, recordFact, stages: greenGating });

    expect(report.terminal).toBe("blocked");
    expect(report.summary).toMatch(/uncertain|replay|resume/i);
    expect(ship).not.toHaveBeenCalled();
    expect(recordFact).not.toHaveBeenCalled();
  });

  it("returns a terminal checkpoint without executing any product stage", async () => {
    const executor = vi.fn<SelfBuildExecutorFn>(async () => fakeReport());
    const stage = vi.fn<StageRunner>(async () => ({ verdict: "GREEN", evidence: "must not run" }));
    const terminal = resumeCheckpoint({
      stage: "done",
      stageState: "completed",
      status: "done",
      verdict: "GREEN",
      completedStages: [...completedBefore("learn"), { stage: "learn", verdict: "GREEN", evidence: "learned" }]
    });
    const { controller, saved } = checkpointController(terminal);

    const report = await runDevCycle({ checkpoint: controller, executor, stages: { select: stage } });

    expect(report).toMatchObject({ cycleId: terminal.cycleId, terminal: "done", verdict: "GREEN" });
    expect(report.stages).toEqual(terminal.completedStages);
    expect(executor).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it.each(["build", "debug"] as const)(
    "resumes the exact interrupted %s attempt at the attempt cap without incrementing attempts",
    async (interruptedStage) => {
      const executor = vi.fn<SelfBuildExecutorFn>(async (options) => {
        await options.onSessionStarted?.(`${interruptedStage}-session-1`);
        return fakeReport();
      });
      const { controller } = checkpointController(
        resumeCheckpoint({
          stage: interruptedStage,
          stageState: "running",
          completedStages: completedBefore(interruptedStage),
          executorSessionId: `${interruptedStage}-session-1`,
          budget: { ...resumeCheckpoint().budget, attempts: 1, maxIterations: 1 },
          lastFailure:
            interruptedStage === "debug"
              ? { gate: "test", kind: "vitest", summary: "failed", failures: ["FAIL"], raw: "FAIL" }
              : null
        })
      );

      const report = await runDevCycle({ checkpoint: controller, executor, stages: greenGating });

      expect(executor).toHaveBeenCalledTimes(1);
      expect(executor.mock.calls[0]![0].resumeSessionId).toBe(`${interruptedStage}-session-1`);
      expect(report.budget.attempts).toBe(1);
    }
  );

  it("still enforces the token ceiling before resuming a captured BUILD attempt", async () => {
    const executor = vi.fn<SelfBuildExecutorFn>(async () => fakeReport());
    const { controller } = checkpointController(
      resumeCheckpoint({
        stage: "build",
        stageState: "running",
        completedStages: completedBefore("build"),
        executorSessionId: "build-session-1",
        budget: { ...resumeCheckpoint().budget, attempts: 1, maxIterations: 1, tokens: 10, tokenBudget: 10 }
      })
    );

    const report = await runDevCycle({ checkpoint: controller, executor, stages: greenGating });

    expect(executor).not.toHaveBeenCalled();
    expect(report.stages.at(-1)?.evidence).toMatch(/token budget exhausted/u);
  });

  it("still enforces elapsed wall-clock before resuming a captured DEBUG attempt", async () => {
    const executor = vi.fn<SelfBuildExecutorFn>(async () => fakeReport());
    const clock: Clock = { now: () => 1_000 };
    const { controller } = checkpointController(
      resumeCheckpoint({
        stage: "debug",
        stageState: "running",
        completedStages: completedBefore("debug"),
        executorSessionId: "debug-session-1",
        budget: { ...resumeCheckpoint().budget, attempts: 1, maxIterations: 1, elapsedMs: 100, wallClockMs: 100 },
        lastFailure: { gate: "test", kind: "vitest", summary: "failed", failures: ["FAIL"], raw: "FAIL" }
      })
    );

    const report = await runDevCycle({ checkpoint: controller, clock, executor, stages: greenGating });

    expect(executor).not.toHaveBeenCalled();
    expect(report.stages.at(-1)?.evidence).toMatch(/wall-clock exceeded/u);
  });

  it("rejects a forged resume history before checkpoint save or stage invocation", async () => {
    const stage = vi.fn<StageRunner>(async () => ({ verdict: "GREEN", evidence: "must not run" }));
    const { controller, saved } = checkpointController(
      resumeCheckpoint({ stage: "ship", stageState: "pending", completedStages: [] })
    );

    await expect(runDevCycle({ checkpoint: controller, stages: { ship: stage } })).rejects.toThrow(
      /history|stage|boundary|checkpoint/i
    );
    expect(stage).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it("rejects a task-mismatched checkpoint without modifying it", async () => {
    const { controller, saved } = checkpointController(resumeCheckpoint());

    await expect(
      runDevCycle({ checkpoint: controller, executorOptions: { taskId: "different-task" }, stages: greenGating })
    ).rejects.toThrow(/task/i);
    expect(saved).toEqual([]);
  });
});
