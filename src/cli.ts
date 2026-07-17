#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  applySelfBuildProgress,
  createDirectionAlignmentReport,
  createSelfBuildState,
  discoverSkills,
  getRuntimeInfo,
  loadHarnessConfig,
  loadSkill,
  SkillIdSchema,
  planNextSelfBuildTask,
  runMaintenanceAudit,
  runSelfBuildExecutor,
  startHarnessSession,
  createHarnessRuntime
} from "./index.js";
import { proposeEvidenceTasks } from "./selfbuild/evidence.js";
import { failClosedMandatePolicy, runDevCycle } from "./selfbuild/runDevCycle.js";
import { runDevCycleLoop } from "./selfbuild/runDevCycleLoop.js";
import type { SelectableTask } from "./selfbuild/selectTask.js";
import { createMandateStore } from "./mandates/store.js";
import { buildDevCyclePlan, renderDevCyclePlan } from "./selfbuild/devCyclePlan.js";
import { makeAskModelFromRoute, routeFromPlannerConfig } from "./selfbuild/askModelAdapter.js";
import { makeSmokeDeps } from "./selfbuild/smokeDeps.js";
import { commandExists } from "./review/gates.js";
import { createFileMemoryStore } from "./memory/store.js";
import { normalizeKnownPathFields } from "./runtime/pathNormalization.js";
import { startHarnessApiServer } from "./surfaces/api.js";
import { runInteractiveTui, runTuiCommand } from "./surfaces/tui.js";
import { runCapabilitySmoke } from "./readiness/capabilitySmoke.js";
import { probeCatalog, renderProbeMarkdown } from "./probes/capabilityProbe.js";
import { createDirectProviderCatalog } from "./providers/catalog.js";

const args = process.argv.slice(2);
const [command] = args;

if (command === "self-build-plan") {
  const configPath = getFlagValue(args, "--config");
  const configResult = loadHarnessConfig(configPath ? { configPath } : {});
  const baseState = createSelfBuildState();
  const state = applySelfBuildProgress(baseState, configResult.config.selfBuild.completedTaskIds);
  const nextTask = planNextSelfBuildTask(state);
  // Phase G: --evidence adds proposals derived from what the harness KNOWS about
  // itself (parity manifest, capability matrix, garage) — evidence attached.
  const evidenceProposals = args.includes("--evidence")
    ? proposeEvidenceTasks({ repoRoot: process.cwd(), memory: createFileMemoryStore() })
    : [];
  const direction = createDirectionAlignmentReport({ here: state.here, there: state.there, ...(nextTask ? { task: nextTask } : {}) });

  console.log(
    JSON.stringify(
      {
        objective: state.objective,
        here: state.here,
        there: state.there,
        referenceRuntime: configResult.config.referenceRuntime,
        config: {
          status: configResult.status,
          verdict: configResult.verdict,
          path: configResult.path,
          diagnostics: configResult.diagnostics
        },
        nextTask,
        ...(args.includes("--evidence") ? { evidenceProposals } : {}),
        direction,
        taskCount: state.tasks.length,
        completedTaskIds: configResult.config.selfBuild.completedTaskIds,
        constraints: state.constraints,
        validationCommands: configResult.config.validationCommands.map((validationCommand) => validationCommand.name)
      },
      null,
      2
    )
  );
} else if (command === "direction-check") {
  const configPath = getFlagValue(args, "--config");
  const configResult = loadHarnessConfig(configPath ? { configPath } : {});
  const baseState = createSelfBuildState();
  const state = applySelfBuildProgress(baseState, configResult.config.selfBuild.completedTaskIds);
  const nextTask = planNextSelfBuildTask(state);
  const direction = createDirectionAlignmentReport({ here: state.here, there: state.there, ...(nextTask ? { task: nextTask } : {}) });

  console.log(JSON.stringify(direction, null, 2));
} else if (command === "session-start") {
  const configPath = getFlagValue(args, "--config");
  const cwd = getFlagValue(args, "--cwd");
  const targetPath = getFlagValue(args, "--target");
  const taskId = getFlagValue(args, "--task-id");
  const skillIds = getFlagValues(args, "--skill");
  const session = await startHarnessSession({
    ...(configPath ? { configPath } : {}),
    ...(cwd ? { cwd } : {}),
    ...(targetPath ? { targetPath } : {}),
    ...(taskId ? { taskId } : {}),
    skillIds
  });

  console.log(JSON.stringify(session, null, 2));
} else if (command === "tool-run") {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(renderToolRunHelp());
    process.exit(0);
  }

  const toolId = getFlagValue(args, "--tool-id");
  if (!toolId) {
    throw new Error("Usage: guruharness tool-run --tool-id <id> [--input-json <json>]");
  }

  const configPath = getFlagValue(args, "--config");
  const cwd = getFlagValue(args, "--cwd");
  const targetPath = getFlagValue(args, "--target");
  const taskId = getFlagValue(args, "--task-id");
  const skillIds = getFlagValues(args, "--skill");
  const inputJson = getFlagValue(args, "--input-json");
  const inputFile = getFlagValue(args, "--input-file");
  const runtime = createHarnessRuntime();
  try {
    const session = await runtime.startSession({
      ...(configPath ? { configPath } : {}),
      ...(cwd ? { cwd } : {}),
      ...(targetPath ? { targetPath } : {}),
      ...(taskId ? { taskId } : {}),
      skillIds
    });
    const observation = await runtime.executeTool(session.id, toolId, normalizeKnownPathFields(parseToolRunInput(inputJson, inputFile)));

    console.log(JSON.stringify({ session, observation }, null, 2));
  } finally {
    await runtime.close();
  }
} else if (command === "session-inspect") {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(renderSessionInspectHelp());
    process.exit(0);
  }

  const apiUrl = getFlagValue(args, "--api-url");
  const sessionId = getFlagValue(args, "--session-id");

  if (!apiUrl || !sessionId) {
    throw new Error("Usage: guruharness session-inspect --api-url <url> --session-id <id>");
  }

  const inspection = await fetchJson(`${apiUrl.replace(/\/$/, "")}/sessions/${encodeURIComponent(sessionId)}/inspect`);

  console.log(JSON.stringify(inspection, null, 2));
} else if (command === "session-list") {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(renderSessionListHelp());
    process.exit(0);
  }

  const apiUrl = getFlagValue(args, "--api-url");
  const limit = getOptionalPositiveInt(args, "--limit");

  if (!apiUrl) {
    throw new Error("Usage: guruharness session-list --api-url <url> [--limit <n>]");
  }

  const query = limit !== undefined ? `?limit=${limit}` : "";
  const sessionList = await fetchJson(`${apiUrl.replace(/\/$/, "")}/sessions${query}`);

  console.log(JSON.stringify(sessionList, null, 2));
} else if (command === "session-continue") {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(renderSessionContinueHelp());
    process.exit(0);
  }

  const apiUrl = getFlagValue(args, "--api-url");
  const sessionId = getFlagValue(args, "--session-id");

  if (!apiUrl || !sessionId) {
    throw new Error("Usage: guruharness session-continue --api-url <url> --session-id <id>");
  }

  const continuation = await fetchJson(`${apiUrl.replace(/\/$/, "")}/sessions/${encodeURIComponent(sessionId)}/continue`);

  console.log(JSON.stringify(continuation, null, 2));
} else if (command === "run") {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(renderRunHelp());
    process.exit(0);
  }

  const configPath = getFlagValue(args, "--config");
  const cwd = getFlagValue(args, "--cwd");
  const targetPath = getFlagValue(args, "--target");
  const taskId = getFlagValue(args, "--task-id");
  const objective = getFlagValue(args, "--objective");
  const projectSlug = getFlagValue(args, "--project");
  const maxPlannerSteps = getOptionalPositiveInt(args, "--max-planner-steps");
  const maxPlannerRetries = getOptionalPositiveInt(args, "--max-planner-retries");
  const allowDirtyWorkspace = hasFlag(args, "--allow-dirty-workspace");
  const allowRiskyPaths = hasFlag(args, "--allow-risky-paths");
  const resumeSessionId = getFlagValue(args, "--resume-session");
  const includeReviewGate = !hasFlag(args, "--skip-review-gate");
  const runGit = hasFlag(args, "--git");
  const gitBranch = getFlagValue(args, "--git-branch");
  const gitCommit = getFlagValue(args, "--git-commit");
  const gitTitle = getFlagValue(args, "--git-title");
  const gitBody = getFlagValue(args, "--git-body");

  // Hardening #5/#6 (spend-safety): a LIVE push (--git-live) must clear the operator's
  // persisted mandate policy — the config flag alone is not an approval. Fail-closed:
  // no grant / no YOLO ⇒ the push escalates and the executor blocks it. Dry runs unaffected.
  const gitIsLive = runGit && hasFlag(args, "--git-live") && !hasFlag(args, "--git-dry-run");
  const liveGitMandatePolicy = gitIsLive ? failClosedMandatePolicy(createMandateStore().load()) : undefined;

  const runCommandReport = await runSelfBuildExecutor({
    ...(liveGitMandatePolicy ? { mandatePolicy: liveGitMandatePolicy } : {}),
    ...(configPath ? { configPath } : {}),
    ...(cwd ? { cwd } : {}),
    ...(targetPath ? { targetPath } : {}),
    ...(taskId ? { taskId } : {}),
    ...(objective ? { objective } : {}),
    ...(projectSlug ? { projectSlug } : {}),
    ...(maxPlannerSteps !== undefined ? { maxPlannerSteps } : {}),
    ...(maxPlannerRetries !== undefined ? { maxPlannerRetries } : {}),
    ...(resumeSessionId ? { resumeSessionId } : {}),
    ...(allowDirtyWorkspace ? { allowDirtyWorkspace } : {}),
    ...(allowRiskyPaths ? { allowRiskyPaths } : {}),
    includeReviewGate,
    ...(runGit
      ? {
          git: {
            enabled: true,
            dryRun: hasFlag(args, "--git-dry-run")
              ? true
              : hasFlag(args, "--git-live")
                ? false
                : true,
            ...(gitBranch ? { branchName: gitBranch } : {}),
            ...(gitCommit ? { commitMessage: gitCommit } : {}),
            ...(gitTitle ? { prTitle: gitTitle } : {}),
            ...(gitBody ? { prBody: gitBody } : {}),
            paths: getFlagValues(args, "--git-path")
          }
        }
      : {}),
  });

  console.log(JSON.stringify(runCommandReport, null, 2));
} else if (command === "self-build-run") {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(
      [
        "guru self-build-run — drive the 0→7 dev cycle (SELECT→BUILD→TEST→SMOKE→DEBUG→REVIEW→SHIP→LEARN).",
        "",
        "  --dry-run                      Discover gates + print the stage plan; execute NOTHING.",
        "  --task-id <id>                 Task to build.",
        "  --loop                         UNATTENDED multi-cycle: drive the whole ready task set",
        "                                 (SELECT re-picks after every cycle; blocked tasks are",
        "                                 deprioritised). Tasks unlocked by cycles completed in",
        "                                 this run are picked up on the next invocation.",
        "  --max-cycles <n>               Hard cap on loop cycles (default: ready task count).",
        "  --cwd <path>                   Working directory (default: cwd).",
        "  --config <path>                Config file.",
        "  --allow-dirty-workspace        Permit a dirty git tree.",
        "  --allow-risky-paths            Permit risky path writes.",
        "",
        "Spend is the hard gate: the loop injects a fail-closed mandate policy and a bounded budget."
      ].join("\n")
    );
    process.exit(0);
  }

  const cwd = getFlagValue(args, "--cwd") ?? process.cwd();
  const taskId = getFlagValue(args, "--task-id");
  const configPath = getFlagValue(args, "--config");
  const devCycleConfig = loadHarnessConfig({ cwd, ...(configPath ? { configPath } : {}) }).config;
  const plannerModel = devCycleConfig.plannerModel;
  const keyPresent = plannerModel !== undefined && Boolean(process.env[plannerModel.apiKeyEnvVar]);

  if (hasFlag(args, "--dry-run")) {
    // Preview only — reflect live wiring without constructing a provider adapter,
    // calling a model, running a gate/smoke/git command, or mutating anything.
    const plan = buildDevCyclePlan({
      cwd,
      ...(taskId ? { taskId } : {}),
      hasSmoke: true,
      hasReviewer: keyPresent,
      hasGitDelivery: commandExists("git")
    });
    console.log(renderDevCyclePlan(plan));
    process.exit(0);
  }

  // Build a live reviewer askModel from the configured model ONLY when its key is present in
  // the environment (presence check — the value is never printed, persisted, or sent here).
  // Absent → REVIEW is YELLOW.
  const askModel = plannerModel && keyPresent ? makeAskModelFromRoute(routeFromPlannerConfig(plannerModel), { env: process.env }) : undefined;

  const executorOptions = {
    cwd,
    ...(taskId ? { taskId } : {}),
    ...(configPath ? { configPath } : {}),
    ...(hasFlag(args, "--allow-dirty-workspace") ? { allowDirtyWorkspace: true } : {}),
    ...(hasFlag(args, "--allow-risky-paths") ? { allowRiskyPaths: true } : {})
  };

  if (hasFlag(args, "--loop")) {
    // Hardening #13: the UNATTENDED multi-cycle driver, fed from the same task graph
    // self-build-plan reads. Readiness is snapshotted at loop start — a task whose
    // dependencies complete DURING this run becomes eligible on the next invocation.
    const state = applySelfBuildProgress(createSelfBuildState(), devCycleConfig.selfBuild.completedTaskIds);
    const doneIds = new Set(state.tasks.filter((task) => task.status === "done").map((task) => task.id));
    // Kernel priority is rank-ordered (now=0 best); SELECT scores higher-is-better — invert.
    const priorityScore: Record<string, number> = { now: 2, next: 1, later: 0 };
    const tasks: SelectableTask[] = state.tasks.map((task) => ({
      id: task.id,
      priority: priorityScore[task.priority] ?? 0,
      ready: task.status === "ready" && task.dependsOn.every((dependency) => doneIds.has(dependency)),
      completed: task.status === "done"
    }));
    const maxCycles = getOptionalPositiveInt(args, "--max-cycles");

    const loopReport = await runDevCycleLoop({
      tasks,
      ...(maxCycles !== undefined ? { maxCycles } : {}),
      baseInput: {
        ...(askModel ? { askModel } : {}),
        smoke: makeSmokeDeps({ cwd, timeoutMs: 30_000 }),
        executorOptions
      },
      // Progress to stderr so stdout stays a single parseable JSON report.
      onCycle: (report, cycleTaskId) => {
        console.error(`[self-build-loop] ${cycleTaskId}: terminal=${report.terminal} stages=${report.stages.map((s) => `${s.stage}:${s.verdict}`).join(",")}`);
      }
    });

    console.log(JSON.stringify(loopReport, null, 2));
    process.exitCode = loopReport.blocked.length === 0 ? 0 : 1;
  } else {
    const devCycleReport = await runDevCycle({
      ...(askModel ? { askModel } : {}),
      // Real SMOKE: nucleus boot + model-free session/tool self-call (bounded).
      smoke: makeSmokeDeps({ cwd, timeoutMs: 30_000 }),
      executorOptions
    });
    console.log(JSON.stringify(devCycleReport, null, 2));
    process.exitCode = devCycleReport.terminal === "done" ? 0 : 1;
  }
} else if (command === "api") {
  const host = getFlagValue(args, "--host") ?? "127.0.0.1";
  const port = getOptionalPositiveInt(args, "--port");
  const timeoutMs = getOptionalPositiveInt(args, "--timeout-ms");
  const api = await startHarnessApiServer({
    host,
    ...(port !== undefined ? { port } : {})
  });

  console.log(
    JSON.stringify(
      {
        status: "running",
        runtime: "guruharness",
        url: api.url,
        host: api.host,
        port: api.port,
        endpoints: [
          "/",
          "/health",
          "/self-build-plan",
          "/direction-check",
          "/session-start",
          "/sessions",
          "/sessions/:sessionId",
          "/sessions/:sessionId/events",
          "/sessions/:sessionId/inspect",
          "/sessions/:sessionId/continue",
          "/tool-run",
          "/run"
        ]
      },
      null,
      2
    )
  );

  if (timeoutMs !== undefined) {
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        void api.close().finally(() => resolve());
      }, timeoutMs);
    });
  }
} else if (command === "tui") {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(renderGuruharnessTuiHelp());
    process.exit(0);
  }
  const configPath = getFlagValue(args, "--config");
  const cwd = getFlagValue(args, "--cwd");
  const commandText = getFlagValue(args, "--command");

  if (hasFlag(args, "--interactive")) {
    await runInteractiveTui({
      ...(configPath ? { configPath } : {}),
      ...(cwd ? { cwd } : {})
    });
  } else if (commandText) {
    const result = await runTuiCommand(commandText, {
      ...(configPath ? { configPath } : {}),
      ...(cwd ? { cwd } : {})
    });

    console.log(result.output);
  } else {
    const help = await runTuiCommand("help");

    console.log(help.output);
  }
} else if (command === "maintenance-audit") {
  const configPath = getFlagValue(args, "--config");
  const cwd = getFlagValue(args, "--cwd");
  const report = runMaintenanceAudit({
    ...(configPath ? { configPath } : {}),
    ...(cwd ? { cwd } : {})
  });

  console.log(JSON.stringify(report, null, 2));
} else if (command === "skills-list") {
  const configPath = getFlagValue(args, "--config");
  const configResult = loadHarnessConfig(configPath ? { configPath } : {});
  const catalog = discoverSkills({
    directories: configResult.config.skillDirectories,
    cwd: configResult.status === "loaded" ? dirname(configResult.path) : process.cwd()
  });

  console.log(JSON.stringify(catalog, null, 2));
} else if (command === "skill-load") {
  const skillId = args[1];
  if (!skillId || skillId.startsWith("--")) {
    throw new Error("Usage: guruharness skill-load <skill-id> [--config <path>]");
  }
  const skillIdResult = SkillIdSchema.safeParse(skillId);
  if (!skillIdResult.success) {
    throw new Error(
      `Invalid skill id: ${skillIdResult.error.issues.map((issue) => issue.message).join("; ")}`
    );
  }

  const configPath = getFlagValue(args, "--config");
  const configResult = loadHarnessConfig(configPath ? { configPath } : {});
  const skill = loadSkill({
    directories: configResult.config.skillDirectories,
    cwd: configResult.status === "loaded" ? dirname(configResult.path) : process.cwd(),
    skillId: skillIdResult.data
  });

  console.log(JSON.stringify(skill, null, 2));
} else if (command === "capability-probe") {
  const providerFilter = getFlagValue(args, "--provider");
  const routeFilter = getFlagValue(args, "--route");
  const outDir = getFlagValue(args, "--out") ?? ".guru/coordination";
  const concurrency = Number(getFlagValue(args, "--concurrency") ?? "4") || 4;
  const routes = createDirectProviderCatalog().filter(
    (route) => (!providerFilter || route.providerId === providerFilter) && (!routeFilter || route.routeId === routeFilter)
  );
  console.log(`capability-probe: ${routes.length} route(s), concurrency ${concurrency}`);
  const reports = await probeCatalog(routes, {
    concurrency,
    onProgress: (report) => {
      console.log(
        `  ${report.routeId}  chat:${report.chat.verdict} tools:${report.tools.verdict} vision:${report.vision.verdict} thinking:${report.thinking.verdict}`
      );
    }
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/model-capabilities.json`, JSON.stringify(reports, null, 2));
  writeFileSync(`${outDir}/model-capabilities.md`, renderProbeMarkdown(reports));
  const summary = reports.reduce(
    (acc, report) => {
      for (const key of ["chat", "tools", "vision", "thinking"] as const) acc[report[key].verdict] = (acc[report[key].verdict] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );
  console.log(JSON.stringify({ routes: reports.length, verdicts: summary, out: `${outDir}/model-capabilities.{json,md}` }, null, 2));
} else if (command === "capability-smoke") {
  const configPath = getFlagValue(args, "--config");
  const cwd = getFlagValue(args, "--cwd");
  const targetPath = getFlagValue(args, "--target");
  const report = await runCapabilitySmoke({
    ...(configPath ? { configPath } : {}),
    ...(cwd ? { cwd } : {}),
    ...(targetPath ? { targetPath } : {})
  });

  console.log(JSON.stringify(report, null, 2));
} else {
  const runtimeInfo = getRuntimeInfo();

  if (command && (hasFlag(args, "--help") || hasFlag(args, "-h") || command === "help")) {
    console.log(renderGeneralHelp(runtimeInfo));
  } else if (command) {
    process.exitCode = 1;
    console.error(`Unknown command: ${command}\n`);
    console.error(renderGeneralHelp(runtimeInfo));
  } else {
    console.log(`${runtimeInfo.name} ${runtimeInfo.version} — ${runtimeInfo.capability}`);
  }
}

function getFlagValues(argsToSearch: readonly string[], flagName: string): string[] {
  return argsToSearch.flatMap((arg, index) => {
    if (arg !== flagName) {
      return [];
    }

    const value = argsToSearch[index + 1];

    return value && !value.startsWith("--") ? [value] : [];
  });
}

function getFlagValue(argsToSearch: readonly string[], flagName: string): string | undefined {
  const flagIndex = argsToSearch.indexOf(flagName);
  const value = flagIndex >= 0 ? argsToSearch[flagIndex + 1] : undefined;

  return value && !value.startsWith("--") ? value : undefined;
}

function getOptionalPositiveInt(argsToSearch: readonly string[], flagName: string): number | undefined {
  const value = getFlagValue(argsToSearch, flagName);

  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flagName}: ${value}`);
  }

  return parsed;
}

function hasFlag(argsToSearch: readonly string[], flagName: string): boolean {
  return argsToSearch.includes(flagName);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJsonFlag(value: string, flagName: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`Invalid JSON for ${flagName}: ${message}`);
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const text = await response.text();
  const payload = text.length > 0 ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    const message = isPlainObject(payload) && typeof payload.error === "string" ? payload.error : response.statusText;
    throw new Error(`Session inspection failed (${response.status}): ${message}`);
  }

  return payload;
}

function parseToolRunInput(inputJson: string | undefined, inputFile: string | undefined): unknown {
  if (inputJson && inputFile) {
    throw new Error("Use either --input-json or --input-file, not both.");
  }

  if (inputFile) {
    return parseJsonFlag(readFileSync(inputFile, "utf8"), `--input-file ${inputFile}`);
  }

  return inputJson ? parseJsonFlag(inputJson, "--input-json") : {};
}

function renderGeneralHelp(runtimeInfo: ReturnType<typeof getRuntimeInfo>): string {
  return [
    `${runtimeInfo.name} ${runtimeInfo.version} — ${runtimeInfo.capability}`,
    "",
    "Usage: guruharness <command> [options]",
    "",
    "Commands:",
    "  self-build-plan     Print the current parity plan and next task",
    "  self-build-run      Drive the 0→7 dev cycle (use --dry-run to preview)",
    "  direction-check     Verify HERE/THERE direction alignment",
    "  session-start       Start a harness runtime session",
    "  tool-run            Start a session and execute one registered tool",
    "  session-list        List recent API sessions with compact summaries",
    "  session-inspect     Inspect an API session status and timeline summary",
    "  session-continue    Suggest safe continuation commands for a session",
    "  run                 Execute the practical run lifecycle",
    "  api                 Start the local API surface",
    "  tui                 Legacy plan/session shell (daily-driver REPL: use `guru`)",
    "  maintenance-audit   Run repository/config/policy audit",
    "  skills-list         List configured skills",
    "  skill-load          Load a configured skill by id",
    "  capability-smoke Prove the core reference-equivalent harness nucleus in one run",
    "  capability-probe   Empirically probe chat/tools/vision/thinking per catalog route",
    "",
    "Run 'guruharness run --help' for runtime lifecycle flags.",
    "Run 'guru' for the interactive daily-driver harness (composer, steer, slash menu)."
  ].join("\n");
}

function renderToolRunHelp(): string {
  return [
    "Usage: guruharness tool-run --tool-id <id> [options]",
    "",
    "Starts a bounded harness session and executes one registered tool with JSON input.",
    "",
    "Options:",
    "  --tool-id <id>                Registered tool id to execute",
    "  --input-json <json>           Tool input as a JSON object (default: {})",
    "  --input-file <path>           Read tool input JSON from a file",
    "  --config <path>               Use alternate config file",
    "  --cwd <path>                  Set runtime working directory",
    "  --target <path>               Set target path for repo/capture context",
    "  --task-id <id>                Select a self-build task",
    "  --skill <id>                  Load a skill document; repeat for multiple skills"
  ].join("\n");
}

function renderSessionListHelp(): string {
  return [
    "Usage: guruharness session-list --api-url <url> [--limit <n>]",
    "",
    "Fetches recent persisted API sessions with compact latest-status summaries.",
    "",
    "Options:",
    "  --api-url <url>                Running GuruHarness API base URL",
    "  --limit <n>                    Maximum sessions to return"
  ].join("\n");
}

function renderSessionContinueHelp(): string {
  return [
    "Usage: guruharness session-continue --api-url <url> --session-id <id>",
    "",
    "Fetches safe suggested commands for inspecting or resuming a selected session.",
    "",
    "Options:",
    "  --api-url <url>                Running GuruHarness API base URL",
    "  --session-id <id>              Session id to continue"
  ].join("\n");
}

function renderSessionInspectHelp(): string {
  return [
    "Usage: guruharness session-inspect --api-url <url> --session-id <id>",
    "",
    "Fetches the API session inspection helper for a safe status and timeline summary.",
    "",
    "Options:",
    "  --api-url <url>                Running GuruHarness API base URL",
    "  --session-id <id>              Session id to inspect"
  ].join("\n");
}

function renderRunHelp(): string {
  return [
    "Usage: guruharness run [options]",
    "",
    "Runs a bounded self-build executor lifecycle: session, planner, review gates, optional git/PR, and done packet.",
    "",
    "Runtime options:",
    "  --config <path>                Use alternate config file",
    "  --cwd <path>                   Set runtime working directory",
    "  --target <path>                Set target path for repo/capture context",
    "  --task-id <id>                 Select a self-build task",
    "  --objective <text>             Override planner objective",
    "  --project <slug>               Set operational project slug",
    "  --max-planner-steps <n>        Cap planner tool steps",
    "  --max-planner-retries <n>      Same-provider retry count before fallback walking",
    "  --resume-session <id>          Resume an existing persisted session id",
    "  --skip-review-gate             Skip configured review gate for this run",
    "",
    "Safety overrides:",
    "  --allow-dirty-workspace        Override runtimeHardening.allowDirtyWorkspace",
    "  --allow-risky-paths            Override runtimeHardening.allowRiskyPaths",
    "",
    "Git/PR options:",
    "  --git                          Enable git/PR planning (dry-run by default)",
    "  --git-dry-run                  Force planned git/PR actions only",
    "  --git-live                     Execute git/PR automation when review gates pass",
    "  --git-branch <name>            Branch name for git automation",
    "  --git-commit <message>         Commit message",
    "  --git-title <title>            PR title",
    "  --git-body <body>              PR body",
    "  --git-path <path>              Path to stage; repeat for multiple paths"
  ].join("\n");
}

function renderGuruharnessTuiHelp(): string {
  return [
    "Usage: guruharness tui [--interactive | --command <text>] [options]",
    "",
    "Legacy plan/session shell (JSON plan, direction, session, run).",
    "For the daily-driver interactive harness (composer, steer, slash menu), run: guru",
    "",
    "Options:",
    "  --interactive           Run the legacy readline shell",
    "  --command <text>        Run one legacy TUI command and print JSON output",
    "  --config <path>         Use alternate config file",
    "  --cwd <path>            Set working directory",
    "  -h, --help              Show this help"
  ].join("\n");
}
