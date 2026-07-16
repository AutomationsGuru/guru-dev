import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

import {
  createHarnessRuntime,
  createInMemoryOperationalStore,
  runSelfBuildExecutor,
  type HarnessRuntimeDependencies,
  type PlannerModel,
  type PlannerModelFetch,
  type PlannerModelRequest
} from "../../src/index.js";
import type { CommandExecutor, CommandGate, CommandGateResult } from "../../src/review/gates.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Native critic panel double — GREEN without calling a model (default reviewGate). */
async function greenNativeReviewer(gate: CommandGate): Promise<CommandGateResult> {
  return {
    ...gate,
    status: "passed",
    summary: "native critic panel GREEN (test double)",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    verdict: "GREEN"
  };
}

class FixedPlannerModel implements PlannerModel {
  readonly requests: PlannerModelRequest[] = [];

  constructor(private readonly plan: unknown) {}

  createPlan(request: PlannerModelRequest): unknown {
    this.requests.push(request);

    return this.plan;
  }
}

class FlakyPlannerModel implements PlannerModel {
  readonly requests: PlannerModelRequest[] = [];
  private failuresRemaining: number;

  constructor(
    failures: number,
    private readonly plan: unknown,
    private readonly failureUsage?: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number }
  ) {
    this.failuresRemaining = failures;
  }

  createPlan(request: PlannerModelRequest): unknown {
    this.requests.push(request);

    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw Object.assign(new Error("transient planner failure"), this.failureUsage ? { usage: this.failureUsage } : {});
    }

    return this.plan;
  }
}

function createRuntimeCloseTracker(): {
  readonly factory: (dependencies: HarnessRuntimeDependencies) => ReturnType<typeof createHarnessRuntime>;
  readonly closedRoles: readonly ("executor" | "planner")[];
} {
  const closedRoles: ("executor" | "planner")[] = [];
  return {
    factory(dependencies) {
      const role = dependencies.plannerModel ? "planner" : "executor";
      const runtime = createHarnessRuntime(dependencies);
      const closeRuntime = runtime.close.bind(runtime);
      runtime.close = async () => {
        closedRoles.push(role);
        await closeRuntime();
      };
      return runtime;
    },
    closedRoles
  };
}

describe("runSelfBuildExecutor", () => {
  it("should run a self-build task through session, planner, review gates, dry-run git, operational record, and done packet", async () => {
    const executedCommands: string[][] = [];
    const model = new FixedPlannerModel({
      objective: "Execute self-build executor.",
      summary: "Resolve repo context as a representative runtime action.",
      steps: [
        {
          id: "repo-context",
          title: "Resolve repository context",
          toolId: "repo.context.resolve",
          input: { cwd: repoRoot }
        }
      ]
    });

    const report = await runSelfBuildExecutor({
      cwd: repoRoot,
      taskId: "self-build-executor",
      allowDirtyWorkspace: true,
      allowRiskyPaths: true,
      plannerModel: model,
      operationalStore: createInMemoryOperationalStore(),
      commandExecutor: createCommandExecutor(executedCommands),
      nativeReviewer: greenNativeReviewer,
      git: {
        enabled: true,
        dryRun: true,
        branchName: "feat/self-build-executor",
        commitMessage: "feat: add self-build executor",
        prTitle: "feat: add self-build executor",
        prBody: "Adds self-build executor.",
        paths: ["src/executor/selfBuildExecutor.ts"]
      }
    });

    expect(report).toMatchObject({
      verdict: "YELLOW",
      blocker: null,
      session: { status: "ready", task: { id: "self-build-executor" } },
      planner: { status: "completed" },
      reviewGates: { verdict: "GREEN" },
      gitPr: { verdict: "GREEN", dryRun: true },
      implementation: { status: "in_progress" },
      donePacket: { verdict: "YELLOW" }
    });
    expect(model.requests[0]?.session.task?.id).toBe("self-build-executor");
    expect(report.donePacket.changedFiles).toEqual([
      { path: "src/executor/selfBuildExecutor.ts", summary: "Included in self-build executor delivery." }
    ]);
    expect(executedCommands.length).toBeGreaterThan(0);
    expect(report.gitPr?.steps.map((step) => step.status)).toEqual(["planned", "planned", "planned", "planned", "planned"]);
  });

  it("should return GREEN when validation and non-dry-run git automation pass", async () => {
    const model = new FixedPlannerModel({
      objective: "Execute task.",
      summary: "No tools needed.",
      steps: []
    });

    const report = await runSelfBuildExecutor({
      cwd: repoRoot,
      taskId: "self-build-executor",
      allowDirtyWorkspace: true,
      allowRiskyPaths: true,
      plannerModel: model,
      commandExecutor: createCommandExecutor([]),
      nativeReviewer: greenNativeReviewer,
      git: {
        enabled: true,
        dryRun: false,
        branchName: "feat/self-build-executor",
        commitMessage: "feat: add self-build executor",
        prTitle: "feat: add self-build executor",
        prBody: "Adds self-build executor.",
        paths: ["src/executor/selfBuildExecutor.ts"]
      }
    });

    expect(report.verdict).toBe("GREEN");
    expect(report.implementation.status).toBe("in_review");
    expect(report.donePacket.nextSteps).toEqual(["Monitor the upstream PR and merge gates."]);
  });

  it("should use the configured planner model adapter when no model is injected", async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: PlannerModelFetch = async (url, init) => {
      fetchCalls.push({ url, init });

      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ objective: "Configured model.", summary: "No tools needed.", steps: [] })
                }
              }
            ]
          })
      };
    };

    const report = await runSelfBuildExecutor({
      cwd: repoRoot,
      taskId: "self-build-executor",
      allowDirtyWorkspace: true,
      env: { OPENAI_API_KEY: "test-key" },
      fetch: fetchImpl,
      commandExecutor: createCommandExecutor([])
    });

    expect(report.planner.status).toBe("completed");
    expect(report.plannerUsage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(fetchCalls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(fetchCalls[0]?.init.headers).toMatchObject({ Authorization: "Bearer test-key" });
  });

  it("should expose one successful planner call's cumulative usage", async () => {
    const model = new FixedPlannerModel({
      plan: { objective: "Execute task.", summary: "No tools needed.", steps: [] },
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 }
    });

    const report = await runSelfBuildExecutor({
      cwd: repoRoot,
      taskId: "self-build-executor",
      allowDirtyWorkspace: true,
      allowRiskyPaths: true,
      plannerModel: model,
      commandExecutor: createCommandExecutor([])
    });

    expect(report.plannerUsage).toEqual({ inputTokens: 8, outputTokens: 3, totalTokens: 11 });
    expect(report.plannerFallback?.cumulativeUsage).toEqual({ inputTokens: 8, outputTokens: 3, totalTokens: 11 });
    expect(report.plannerFallback?.attempts[0]?.usage).toEqual({ inputTokens: 8, outputTokens: 3, totalTokens: 11 });
  });

  it("should record a blocker when the planner blocks", async () => {
    const model = new FixedPlannerModel({
      plan: { objective: "Invalid plan missing summary." },
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }
    });

    const report = await runSelfBuildExecutor({
      cwd: repoRoot,
      taskId: "self-build-executor",
      allowDirtyWorkspace: true,
      plannerModel: model,
      commandExecutor: createCommandExecutor([])
    });

    expect(report).toMatchObject({
      verdict: "RED",
      planner: { status: "blocked" },
      implementation: { status: "blocked" },
      donePacket: { verdict: "RED" }
    });
    expect(report.blocker?.backlogItem.status).toBe("blocked");
    expect(report.summary).toContain("planner");
    expect(report.plannerUsage).toEqual({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
  });

  it("should stop and record a blocker when a required review gate fails", async () => {
    const model = new FixedPlannerModel({
      plan: { objective: "Execute task.", summary: "No tools needed.", steps: [] },
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }
    });

    const report = await runSelfBuildExecutor({
      cwd: repoRoot,
      taskId: "self-build-executor",
      allowDirtyWorkspace: true,
      plannerModel: model,
      commandExecutor: createCommandExecutor([], "test")
    });

    expect(report.verdict).toBe("RED");
    expect(report.reviewGates?.verdict).toBe("RED");
    expect(report.gitPr).toBeNull();
    expect(report.blocker?.stateSnapshot.kind).toBe("risk");
    expect(report.donePacket.risks.some((risk) => risk.includes("test failed"))).toBe(true);
    expect(report.plannerUsage.totalTokens).toBe(3);
  });

  it("should stop and record a blocker when git PR automation fails", async () => {
    const model = new FixedPlannerModel({
      plan: { objective: "Execute task.", summary: "No tools needed.", steps: [] },
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 }
    });

    const report = await runSelfBuildExecutor({
      cwd: repoRoot,
      taskId: "self-build-executor",
      allowDirtyWorkspace: true,
      allowRiskyPaths: true,
      plannerModel: model,
      commandExecutor: createCommandExecutor([], "git-commit"),
      git: {
        enabled: true,
        dryRun: false,
        branchName: "feat/self-build-executor",
        commitMessage: "feat: add self-build executor",
        prTitle: "feat: add self-build executor",
        prBody: "Adds self-build executor.",
        paths: ["src/executor/selfBuildExecutor.ts"]
      }
    });

    expect(report.verdict).toBe("RED");
    expect(report.gitPr?.verdict).toBe("RED");
    expect(report.implementation.status).toBe("blocked");
    expect(report.blocker?.backlogItem.title).toBe("Self-build executor blocked at git-pr");
    expect(report.plannerUsage.totalTokens).toBe(6);
  });
});

describe("runSelfBuildExecutor runtime hardening", () => {
  it("should block when the workspace is dirty and allowDirtyWorkspace is false", async () => {
    const model = new FixedPlannerModel({
      objective: "Execute task.",
      summary: "No tools needed.",
      steps: []
    });

    const tempRoot = mkdtempSync(join(tmpdir(), "guruharness-dirty-test-"));
    try {
      // Create a minimal dirty git repo
      execSync("git init -q", { cwd: tempRoot, stdio: "ignore" });
      writeFileSync(join(tempRoot, "dirty-marker.txt"), "this makes the workspace dirty");

      const report = await runSelfBuildExecutor({
        cwd: tempRoot,
        taskId: "self-build-executor",
        plannerModel: model,
        commandExecutor: createCommandExecutor([])
      });

      expect(report.verdict).toBe("RED");
      expect(report.planner.status).toBe("blocked");
      expect(report.planner.blockers[0]).toMatch(/dirty workspace/i);
      expect(report.summary).toContain("safety-check");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("should block when a target path is risky and allowRiskyPaths is false", async () => {
    const model = new FixedPlannerModel({
      objective: "Execute task.",
      summary: "No tools needed.",
      steps: []
    });

    const report = await runSelfBuildExecutor({
      cwd: repoRoot,
      taskId: "self-build-executor",
      allowDirtyWorkspace: true,
      targetPath: "./secrets/local.env",
      plannerModel: model,
      commandExecutor: createCommandExecutor([])
    });

    expect(report.verdict).toBe("RED");
    expect(report.planner.blockers.some((b) => /risky-path/i.test(b))).toBe(true);
    expect(report.planner.blockers.join("\n")).not.toContain("secrets/local.env");
    expect(report.blocker?.stateSnapshot.body).not.toContain("secrets/local.env");
    expect(report.donePacket.risks.join("\n")).not.toContain("secrets/local.env");
    expect(report.plannerUsage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it("should block risky git paths before git automation", async () => {
    // Isolate from the host worktree: running against the real repo root embeds
    // the live `git status` in the report, and an untracked `.env.example` there
    // would trip the `.env` redaction assertion for an unrelated reason. A clean
    // temp repo keeps this test focused on the targeted risky git path being
    // blocked and fully redacted from the serialized report.
    const tempRoot = mkdtempSync(join(tmpdir(), "guruharness-risky-git-path-"));
    try {
      execSync("git init -q", { cwd: tempRoot, stdio: "ignore" });

      const model = new FixedPlannerModel({
        objective: "Execute task.",
        summary: "No tools needed.",
        steps: []
      });

      const report = await runSelfBuildExecutor({
        cwd: tempRoot,
        taskId: "self-build-executor",
        allowDirtyWorkspace: true,
        plannerModel: model,
        commandExecutor: createCommandExecutor([]),
        git: {
          enabled: true,
          dryRun: true,
          paths: [".env"]
        }
      });

      expect(report.verdict).toBe("RED");
      expect(report.gitPr).toBeNull();
      expect(report.planner.blockers.some((blocker) => /Git path is blocked by risky-path policy/i.test(blocker))).toBe(true);
      expect(JSON.stringify(report)).not.toContain(".env");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["private-key", "-----BEGIN PRIVATE KEY-----"],
    ["github-fine-grained-token", ["github", "pat", "abcdefghijklmnopqrstuvwxyz123456"].join("_")],
    ["aws-access-key", ["ASIA", "ABCDEFGHIJKLMNOP"].join("")],
    ["slack-token", ["xoxb", "123456789012", "abcdefghijklmnop"].join("-")],
    ["stripe-secret-key", ["sk", "live", "abcdefghijklmnop1234"].join("_")],
    ["vercel-token", ["vercel", "abcdefghijklmnopqrstuvwx"].join("_")],
    ["neon-token", ["napi", "abcdefghijklmnopqrstuvwx"].join("_")],
    ["jwt", ["eyJaaaaaaaaaaaa", "eyJbbbbbbbbbbbb", "cccccccccccccccc"].join(".")]
  ])("should redact high-signal %s values from reports", async (_kind, secretValue) => {
    const model = new FixedPlannerModel({
      objective: "Execute task.",
      summary: "No tools needed.",
      steps: []
    });

    const report = await runSelfBuildExecutor({
      cwd: repoRoot,
      taskId: "self-build-executor",
      allowDirtyWorkspace: true,
      allowRiskyPaths: true,
      objective: `Investigate ${secretValue}`,
      plannerModel: model,
      commandExecutor: createCommandExecutor([])
    });

    const serialized = JSON.stringify(report);
    expect(report.verdict).toBe("RED");
    expect(report.planner.blockers.some((blocker) => blocker.includes("value redacted"))).toBe(true);
    expect(serialized).not.toContain(secretValue);
    expect(report.donePacket.risks.join("\n")).not.toContain(secretValue);
    expect(report.blocker?.stateSnapshot.body).not.toContain(secretValue);
    expect(report.blocker?.backlogItem.description).not.toContain(secretValue);
  });

  it.each(["feat/skip-broken-tests", "pkg-update-deps-now", "skeleton-refactor-pass"])(
    "should not flag benign branch or commit text: %s",
    async (branchName) => {
      const model = new FixedPlannerModel({
        objective: "Execute task.",
        summary: "No tools needed.",
        steps: []
      });

      const report = await runSelfBuildExecutor({
        cwd: repoRoot,
        taskId: "self-build-executor",
        allowDirtyWorkspace: true,
        allowRiskyPaths: true,
        plannerModel: model,
        commandExecutor: createCommandExecutor([]),
        git: {
          enabled: true,
          dryRun: true,
          branchName,
          commitMessage: `chore: ${branchName}`,
          prTitle: `Update ${branchName}`,
          prBody: `Working on ${branchName}`,
          paths: ["src/executor/selfBuildExecutor.ts"]
        }
      });

      expect(report.verdict).toBe("YELLOW");
      expect(report.planner.blockers).toEqual([]);
      expect(report.gitPr?.verdict).toBe("GREEN");
    }
  );

  it("should honor exact runtimeHardening secret allow-list entries without echoing the value", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "guruharness-secret-allow-list-"));
    const allowListedValue = ["sk", "test", "abcdefghijklmnop1234"].join("_");

    try {
      const configPath = join(tempRoot, "guruharness.config.json");
      writeFileSync(
        configPath,
        JSON.stringify({ runtimeHardening: { secretAllowList: [`Investigate ${allowListedValue}`] } })
      );

      const model = new FixedPlannerModel({
        objective: "Execute task.",
        summary: "No tools needed.",
        steps: []
      });

      const report = await runSelfBuildExecutor({
        cwd: repoRoot,
        configPath,
        taskId: "self-build-executor",
        allowDirtyWorkspace: true,
        allowRiskyPaths: true,
        objective: `Investigate ${allowListedValue}`,
        plannerModel: model,
        commandExecutor: createCommandExecutor([])
      });

      expect(report.verdict).toBe("YELLOW");
      expect(report.planner.blockers).toEqual([]);
      expect(report.donePacket.risks.join("\n")).not.toContain(allowListedValue);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([".ssh/id_rsa", ".aws/credentials", ".npmrc", ".netrc", ".config/gcloud/application_default_credentials.json", "id_ed25519", "service-account.json"])(
    "should block risky path segment %s",
    async (targetPath) => {
      const model = new FixedPlannerModel({
        objective: "Execute task.",
        summary: "No tools needed.",
        steps: []
      });

      const report = await runSelfBuildExecutor({
        cwd: repoRoot,
        taskId: "self-build-executor",
        allowDirtyWorkspace: true,
        plannerModel: model,
        commandExecutor: createCommandExecutor([]),
        git: {
          enabled: true,
          dryRun: true,
          paths: [targetPath]
        }
      });

      expect(report.verdict).toBe("RED");
      expect(report.gitPr).toBeNull();
      expect(report.planner.blockers.some((blocker) => /risky-path policy/i.test(blocker))).toBe(true);
      expect(JSON.stringify(report)).not.toContain(targetPath);
    }
  );

  it("should block when a planner model candidate fails and no fallbacks are available", async () => {
    const model = new FixedPlannerModel({ objective: "Invalid plan missing summary." });

    const report = await runSelfBuildExecutor({
      cwd: repoRoot,
      taskId: "self-build-executor",
      allowDirtyWorkspace: true,
      allowRiskyPaths: true,
      plannerModel: model,
      commandExecutor: createCommandExecutor([])
    });

    expect(report.verdict).toBe("RED");
    expect(report.planner.status).toBe("blocked");
    expect(report.summary).toContain("planner");
    expect(report.plannerUsage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it("should return an explicit continuity blocker when resumeSessionId is missing", async () => {
    const missingSessionId = "missing-session-for-continuity";
    const model = new FixedPlannerModel({
      objective: "Execute task.",
      summary: "No tools needed.",
      steps: []
    });

    const report = await runSelfBuildExecutor({
      cwd: repoRoot,
      taskId: "self-build-executor",
      allowDirtyWorkspace: true,
      allowRiskyPaths: true,
      resumeSessionId: missingSessionId,
      plannerModel: model,
      commandExecutor: createCommandExecutor([])
    });

    expect(report.verdict).toBe("RED");
    expect(report.summary).toContain("session-continuity");
    expect(report.planner.failureReason).toBe("missing-session");
    expect(report.planner.blockers.join("\n")).toContain(missingSessionId);
    expect(model.requests).toEqual([]);
  });

  it("should walk configured fallback candidates even when same-provider retries are one", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "guruharness-planner-fallback-"));
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: PlannerModelFetch = async (url, init) => {
      fetchCalls.push({ url, init });

      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            url.startsWith("https://primary.example/")
              ? {
                  choices: [],
                  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
                }
              : {
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({ objective: "Fallback model.", summary: "No tools needed.", steps: [] })
                      }
                    }
                  ],
                  usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 }
                }
          )
      };
    };

    try {
      const configPath = join(tempRoot, "guruharness.config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          plannerModel: {
            provider: "openai-compatible",
            baseUrl: "https://primary.example/v1",
            model: "primary",
            apiKeyEnvVar: "PRIMARY_API_KEY"
          },
          plannerModelFallbacks: [
            {
              provider: "openai-compatible",
              baseUrl: "https://fallback.example/v1",
              model: "fallback",
              apiKeyEnvVar: "FALLBACK_API_KEY"
            }
          ],
          runtimeHardening: { plannerMaxRetries: 1 }
        })
      );

      const report = await runSelfBuildExecutor({
        cwd: repoRoot,
        configPath,
        taskId: "self-build-executor",
        allowDirtyWorkspace: true,
        allowRiskyPaths: true,
        env: { PRIMARY_API_KEY: "test-primary-key", FALLBACK_API_KEY: "test-fallback-key" },
        fetch: fetchImpl,
        commandExecutor: createCommandExecutor([])
      });

      expect(report.planner.status).toBe("completed");
      expect(report.implementation.metadata).toMatchObject({ plannerProvider: "config-fallback-1", plannerAttempts: 2 });
      expect(report.plannerFallback).toMatchObject({
        strategy: "primary-then-retry-then-fallback",
        totalAttempts: 2,
        selectedProviderLabel: "config-fallback-1",
        usedFallbackProvider: true,
        exhausted: false,
        alarms: [expect.objectContaining({ code: "provider-fallback-used", severity: "warning" })]
      });
      expect(report.plannerFallback?.attempts).toEqual([
        expect.objectContaining({
          providerLabel: "config-primary",
          status: "blocked",
          failureReason: "model-threw",
          blockerCount: 1,
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
        }),
        expect.objectContaining({
          providerLabel: "config-fallback-1",
          status: "completed",
          blockerCount: 0,
          usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 }
        })
      ]);
      expect(report.plannerFallback?.cumulativeUsage).toEqual({ inputTokens: 10, outputTokens: 6, totalTokens: 16 });
      expect(report.plannerUsage).toEqual({ inputTokens: 10, outputTokens: 6, totalTokens: 16 });
      expect(report.implementation.metadata).toMatchObject({
        plannerFallback: expect.objectContaining({ recoveryNarrative: expect.stringContaining("fallback") })
      });
      expect(report.donePacket.risks.join("\n")).toContain("provider-fallback-used");
      expect(report.donePacket.nextSteps).toContain("Review planner fallback playbook alarms before the next long-running run.");
      expect(fetchCalls).toHaveLength(2);
      expect(fetchCalls[0]?.url).toBe("https://primary.example/v1/chat/completions");
      expect(fetchCalls[1]?.url).toBe("https://fallback.example/v1/chat/completions");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("should report same-provider retry alarms when a planner recovers after a transient failure", async () => {
    const model = new FlakyPlannerModel(
      1,
      {
        plan: { objective: "Execute task.", summary: "No tools needed.", steps: [] },
        usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 }
      },
      { inputTokens: 2, outputTokens: 1, totalTokens: 3 }
    );

    const report = await runSelfBuildExecutor({
      cwd: repoRoot,
      taskId: "self-build-executor",
      allowDirtyWorkspace: true,
      allowRiskyPaths: true,
      plannerModel: model,
      maxPlannerRetries: 2,
      commandExecutor: createCommandExecutor([])
    });

    expect(report.planner.status).toBe("completed");
    expect(report.plannerFallback).toMatchObject({
      totalAttempts: 2,
      selectedProviderLabel: "injected",
      usedFallbackProvider: false,
      exhausted: false,
      alarms: [expect.objectContaining({ code: "provider-retry-used", severity: "info" })]
    });
    expect(report.plannerFallback?.attempts).toEqual([
      expect.objectContaining({
        providerLabel: "injected",
        retryIndex: 0,
        status: "blocked",
        failureReason: "model-threw",
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }
      }),
      expect.objectContaining({
        providerLabel: "injected",
        retryIndex: 1,
        status: "completed",
        usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 }
      })
    ]);
    expect(report.plannerFallback?.cumulativeUsage).toEqual({ inputTokens: 8, outputTokens: 3, totalTokens: 11 });
    expect(report.plannerUsage).toEqual({ inputTokens: 8, outputTokens: 3, totalTokens: 11 });
    expect(report.donePacket.risks.join("\n")).toContain("provider-retry-used");
    expect(model.requests).toHaveLength(2);
  });

  it("closes the executor runtime and every planner retry runtime", async () => {
    const model = new FlakyPlannerModel(1, {
      objective: "Execute task.",
      summary: "No tools needed.",
      steps: []
    });
    const tracker = createRuntimeCloseTracker();

    const report = await runSelfBuildExecutor({
      cwd: repoRoot,
      taskId: "self-build-executor",
      allowDirtyWorkspace: true,
      allowRiskyPaths: true,
      plannerModel: model,
      maxPlannerRetries: 2,
      commandExecutor: createCommandExecutor([]),
      runtimeFactory: tracker.factory
    });

    expect(report.planner.status).toBe("completed");
    expect(tracker.closedRoles.filter((role) => role === "planner")).toHaveLength(2);
    expect(tracker.closedRoles.filter((role) => role === "executor")).toHaveLength(1);
  });

  it("closes the executor runtime when session startup throws", async () => {
    const tracker = createRuntimeCloseTracker();
    const factory = (dependencies: HarnessRuntimeDependencies) => {
      const runtime = tracker.factory(dependencies);
      runtime.startSession = async () => {
        throw new Error("executor startup failed");
      };
      return runtime;
    };

    await expect(
      runSelfBuildExecutor({
        cwd: repoRoot,
        taskId: "self-build-executor",
        allowDirtyWorkspace: true,
        runtimeFactory: factory
      })
    ).rejects.toThrow("executor startup failed");
    expect(tracker.closedRoles).toEqual(["executor"]);
  });

  it("should block live git automation when approvalPolicy.autoCommitPushPr is false", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "guruharness-no-autogit-"));

    try {
      const configPath = join(tempRoot, "guruharness.config.json");
      writeFileSync(configPath, JSON.stringify({ approvalPolicy: { autoCommitPushPr: false } }));
      const model = new FixedPlannerModel({
        objective: "Execute task.",
        summary: "No tools needed.",
        steps: []
      });

      const report = await runSelfBuildExecutor({
        cwd: repoRoot,
        configPath,
        taskId: "self-build-executor",
        allowDirtyWorkspace: true,
        allowRiskyPaths: true,
        plannerModel: model,
        commandExecutor: createCommandExecutor([]),
        git: {
          enabled: true,
          dryRun: false,
          paths: ["src/executor/selfBuildExecutor.ts"]
        }
      });

      expect(report.verdict).toBe("RED");
      expect(report.summary).toContain("git-pr-approval");
      expect(report.gitPr).toBeNull();
      expect(report.blocker?.stateSnapshot.body).toContain("approvalPolicy.autoCommitPushPr");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("blocks a live git push the mandate policy does not allow (hardening #4 — no unapproved push)", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "guruharness-mandate-git-"));

    try {
      const configPath = join(tempRoot, "guruharness.config.json");
      writeFileSync(configPath, JSON.stringify({ approvalPolicy: { autoCommitPushPr: true } }));
      const model = new FixedPlannerModel({
        objective: "Execute task.",
        summary: "No tools needed.",
        steps: []
      });
      const evaluated: string[] = [];

      const report = await runSelfBuildExecutor({
        cwd: repoRoot,
        configPath,
        taskId: "self-build-executor",
        allowDirtyWorkspace: true,
        allowRiskyPaths: true,
        plannerModel: model,
        commandExecutor: createCommandExecutor([]),
        mandatePolicy: (toolId, input) => {
          evaluated.push(`${toolId}:${JSON.stringify(input)}`);
          return { outcome: "escalate", reason: "spend hard-edge: live push requires an explicit grant", verbs: [] };
        },
        git: {
          enabled: true,
          dryRun: false,
          paths: ["src/executor/selfBuildExecutor.ts"]
        }
      });

      expect(report.verdict).toBe("RED");
      expect(report.summary).toContain("git-pr-mandate");
      expect(report.gitPr).toBeNull();
      expect(report.blocker?.stateSnapshot.body).toContain("mandate policy");
      // The push itself was evaluated as a deploy action — mirroring makeGatedGitDelivery.
      expect(evaluated.join("\n")).toContain("git push origin");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does NOT consult the mandate policy for dry-run git automation (dry runs stay ungated)", async () => {
    const model = new FixedPlannerModel({
      objective: "Execute task.",
      summary: "No tools needed.",
      steps: []
    });
    const evaluated: string[] = [];

    const report = await runSelfBuildExecutor({
      cwd: repoRoot,
      taskId: "self-build-executor",
      allowDirtyWorkspace: true,
      allowRiskyPaths: true,
      plannerModel: model,
      commandExecutor: createCommandExecutor([]),
      mandatePolicy: (toolId, input) => {
        evaluated.push(`${toolId}:${JSON.stringify(input)}`);
        return { outcome: "escalate", reason: "should never gate a dry run", verbs: [] };
      },
      git: {
        enabled: true,
        dryRun: true,
        paths: ["src/executor/selfBuildExecutor.ts"]
      }
    });

    expect(report.summary).not.toContain("git-pr-mandate");
    expect(report.gitPr?.dryRun).toBe(true);
    expect(evaluated.join("\n")).not.toContain("git push origin");
  });

  it("should report missing-model configuration when no model candidates resolve", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "guruharness-no-model-"));
    try {
      const configPath = join(tempRoot, "guruharness.config.json");
      writeFileSync(configPath, "{}");

      const report = await runSelfBuildExecutor({
        cwd: repoRoot,
        configPath,
        taskId: "self-build-executor",
        allowDirtyWorkspace: true,
        commandExecutor: createCommandExecutor([])
      });

      expect(report.verdict).toBe("RED");
      expect(report.planner.blockers[0]).toMatch(/No planner model was injected/);
      expect(report.summary).toContain("model-adapter");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("consults the injected mandate policy on the executor path (P7 spend-gate seam)", async () => {
    const seen: string[] = [];
    const model = new FixedPlannerModel({
      objective: "Execute task.",
      summary: "Resolve repo context.",
      steps: [{ id: "repo-context", title: "Resolve repository context", toolId: "repo.context.resolve", input: { cwd: repoRoot } }]
    });

    await runSelfBuildExecutor({
      cwd: repoRoot,
      taskId: "mandate-seam",
      allowDirtyWorkspace: true,
      allowRiskyPaths: true,
      plannerModel: model,
      operationalStore: createInMemoryOperationalStore(),
      commandExecutor: createCommandExecutor([]),
      // The gate is now live on the executor runtime: every tool call is routed through it.
      mandatePolicy: (toolId) => {
        seen.push(toolId);
        return { outcome: "allow", reason: "test spy", verbs: [] };
      }
    });

    // Proof the policy is threaded into the runtime that actually runs the plan's tools.
    expect(seen).toContain("repo.context.resolve");
  });
});

function createCommandExecutor(executedCommands: string[][], failGateName?: string): CommandExecutor {
  return async (command, context) => {
    executedCommands.push([...command]);
    const shouldFail = context.gate.name === failGateName;

    return {
      exitCode: shouldFail ? 1 : 0,
      stdout: command.join(" "),
      stderr: shouldFail ? `${context.gate.name} failed` : "",
      durationMs: 1
    };
  };
}
