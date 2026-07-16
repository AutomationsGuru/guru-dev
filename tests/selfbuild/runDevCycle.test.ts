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
import type { Clock, DevStage } from "../../src/selfbuild/devCycle.js";
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
