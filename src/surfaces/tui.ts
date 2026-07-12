import { createInterface } from "node:readline";

import { createDirectionAlignmentReport } from "../direction/hereThere.js";
import { type ApiDirectionRequest, type ApiRunRequest, type ApiSessionStartRequest, type ApiSelfBuildPlanRequest } from "./api.js";
import { createSelfBuildState, applySelfBuildProgress, planNextSelfBuildTask } from "../kernel/selfBuildLoop.js";
import { loadHarnessConfig } from "../config/loadConfig.js";
import { startHarnessSession } from "../runtime/session.js";
import { runSelfBuildExecutor, type RunSelfBuildExecutorOptions } from "../executor/selfBuildExecutor.js";
import type { StartHarnessSessionOptions } from "../runtime/schemas.js";

export interface TuiContext {
  readonly configPath?: string;
  readonly cwd?: string;
  readonly handlers?: TuiDependencyHandlers;
}

export interface TuiDependencyHandlers {
  readonly plan?: (request: ApiSelfBuildPlanRequest) => Promise<unknown>;
  readonly direction?: (request: ApiDirectionRequest) => Promise<unknown>;
  readonly sessionStart?: (request: ApiSessionStartRequest) => Promise<unknown>;
  readonly run?: (request: ApiRunRequest) => Promise<unknown>;
}

export interface TuiCommandResult {
  readonly output: string;
  readonly shouldExit: boolean;
}

export async function runTuiCommand(commandLine: string, context: TuiContext = {}): Promise<TuiCommandResult> {
  const parts = commandLine.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return {
      shouldExit: false,
      output: renderTuiHelp()
    };
  }

  const [command, ...tokens] = parts;
  const handlers = {
    plan: context.handlers?.plan ?? defaultPlan,
    direction: context.handlers?.direction ?? defaultDirection,
    sessionStart: context.handlers?.sessionStart ?? ((request) => startHarnessSession(toSessionRequest(request))),
    run: context.handlers?.run ?? ((request) => runSelfBuildExecutor(toRunRequest(request)))
  };

  if (command === "help") {
    return { output: renderTuiHelp(), shouldExit: false };
  }

  if (command === "exit" || command === "quit") {
    return { output: "Goodbye from GuruHarness TUI.", shouldExit: true };
  }

  if (command === "plan") {
    const request = parseContextRequest(tokens, context);

    return {
      shouldExit: false,
      output: JSON.stringify(await handlers.plan(request), null, 2)
    };
  }

  if (command === "direction") {
    const request = parseContextRequest(tokens, context);

    return {
      shouldExit: false,
      output: JSON.stringify(await handlers.direction(request), null, 2)
    };
  }

  if (command === "session") {
    const parsed = parseSessionOptions(tokens, context);

    return {
      shouldExit: false,
      output: JSON.stringify(await handlers.sessionStart(parsed), null, 2)
    };
  }

  if (command === "run") {
    const parsed = parseRunOptions(tokens, context);

    return {
      shouldExit: false,
      output: JSON.stringify(await handlers.run(parsed), null, 2)
    };
  }

  return {
    shouldExit: false,
    output: `Unknown command: ${command}\n${renderTuiHelp()}`
  };
}

export function runInteractiveTui(context: TuiContext = {}): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "guruharness> " });

    console.log("GuruHarness TUI shell. Type help for commands, exit to quit.");
    rl.prompt();

    const handleLine = async (line: string): Promise<void> => {
      const result = await runTuiCommand(line, context);

      if (result.output.length > 0) {
        console.log(result.output);
      }

      if (result.shouldExit) {
        rl.close();
      } else {
        rl.prompt();
      }
    };

    rl.on("line", (line) => {
      // A rejected command (zod parse error, handler throw) must print + re-prompt,
      // not kill the whole shell with an unhandled rejection.
      handleLine(line).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        rl.prompt();
      });
    });

    rl.on("close", () => {
      resolve();
    });
  });
}

async function defaultPlan(request: ApiSelfBuildPlanRequest): Promise<unknown> {
  const configResult = loadHarnessConfig({ ...(request.configPath ? { configPath: request.configPath } : {}), ...(request.cwd ? { cwd: request.cwd } : {}) });
  const baseState = createSelfBuildState();
  const state = applySelfBuildProgress(baseState, configResult.config.selfBuild.completedTaskIds);
  const nextTask = planNextSelfBuildTask(state);

  return {
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
    direction: createDirectionAlignmentReport({ here: state.here, there: state.there, ...(nextTask ? { task: nextTask } : {}) }),
    taskCount: state.tasks.length,
    completedTaskIds: configResult.config.selfBuild.completedTaskIds,
    constraints: state.constraints,
    validationCommands: configResult.config.validationCommands.map((validationCommand) => validationCommand.name)
  };
}

async function defaultDirection(request: ApiDirectionRequest): Promise<unknown> {
  const configResult = loadHarnessConfig({ ...(request.configPath ? { configPath: request.configPath } : {}), ...(request.cwd ? { cwd: request.cwd } : {}) });
  const baseState = createSelfBuildState();
  const state = applySelfBuildProgress(baseState, configResult.config.selfBuild.completedTaskIds);
  const nextTask = planNextSelfBuildTask(state);

  return createDirectionAlignmentReport({ here: state.here, there: state.there, ...(nextTask ? { task: nextTask } : {}) });
}

function parseContextRequest(tokens: string[], context: TuiContext): ApiSelfBuildPlanRequest {
  const configPath = getFlagValue(tokens, "--config") ?? context.configPath;
  const cwd = getFlagValue(tokens, "--cwd") ?? context.cwd;
  const request: ApiSelfBuildPlanRequest = {};

  if (typeof configPath === "string" && configPath.length > 0) {
    request.configPath = configPath;
  }

  if (typeof cwd === "string" && cwd.length > 0) {
    request.cwd = cwd;
  }

  return request;
}

function parseSessionOptions(tokens: string[], context: TuiContext): ApiSessionStartRequest {
  const configPath = getFlagValue(tokens, "--config") ?? context.configPath;
  const cwd = getFlagValue(tokens, "--cwd") ?? context.cwd;
  const request: ApiSessionStartRequest = {};

  if (typeof configPath === "string" && configPath.length > 0) {
    request.configPath = configPath;
  }

  if (typeof cwd === "string" && cwd.length > 0) {
    request.cwd = cwd;
  }

  const targetPath = getFlagValue(tokens, "--target");
  const taskId = getFlagValue(tokens, "--task-id");
  const projectSlug = getFlagValue(tokens, "--project");
  const skill = getFlagValue(tokens, "--skill");

  if (typeof targetPath === "string" && targetPath.length > 0) {
    request.targetPath = targetPath;
  }

  if (typeof taskId === "string" && taskId.length > 0) {
    request.taskId = taskId;
  }

  if (typeof projectSlug === "string" && projectSlug.length > 0) {
    request.projectSlug = projectSlug;
  }

  const skillTokens = getFlagValues(tokens, "--skill");
  if (skillTokens.length > 0) {
    request.skillIds = skillTokens;
  } else if (typeof skill === "string" && skill.length > 0) {
    request.skillIds = [skill];
  }

  return request;
}

function parseRunOptions(tokens: string[], context: TuiContext): ApiRunRequest {
  const configPath = getFlagValue(tokens, "--config") ?? context.configPath;
  const cwd = getFlagValue(tokens, "--cwd") ?? context.cwd;
  const request: ApiRunRequest = {
    includeReviewGate: true
  };

  if (typeof configPath === "string" && configPath.length > 0) {
    request.configPath = configPath;
  }

  if (typeof cwd === "string" && cwd.length > 0) {
    request.cwd = cwd;
  }

  const targetPath = getFlagValue(tokens, "--target");
  const taskId = getFlagValue(tokens, "--task-id");
  const objective = getFlagValue(tokens, "--objective");
  const project = getFlagValue(tokens, "--project");
  const maxPlannerSteps = parsePositiveInt(getFlagValue(tokens, "--max-planner-steps"), "--max-planner-steps");
  if (typeof maxPlannerSteps === "number") {
    request.maxPlannerSteps = maxPlannerSteps;
  }
  if (typeof targetPath === "string" && targetPath.length > 0) {
    request.targetPath = targetPath;
  }

  if (typeof taskId === "string" && taskId.length > 0) {
    request.taskId = taskId;
  }

  if (typeof objective === "string" && objective.length > 0) {
    request.objective = objective;
  }

  if (typeof project === "string" && project.length > 0) {
    request.projectSlug = project;
  }

  const maxPlannerRetries = parsePositiveInt(getFlagValue(tokens, "--max-planner-retries"), "--max-planner-retries");
  if (typeof maxPlannerRetries === "number") {
    request.maxPlannerRetries = maxPlannerRetries;
  }

  if (hasFlag(tokens, "--allow-dirty-workspace")) {
    request.allowDirtyWorkspace = true;
  }

  if (hasFlag(tokens, "--allow-risky-paths")) {
    request.allowRiskyPaths = true;
  }

  const resumeSessionId = getFlagValue(tokens, "--resume-session");
  if (resumeSessionId !== undefined && resumeSessionId.length > 0) {
    request.resumeSessionId = resumeSessionId;
  }

  if (hasFlag(tokens, "--skip-review-gate")) {
    request.includeReviewGate = false;
  }

  const runGit = hasFlag(tokens, "--git") || hasFlag(tokens, "--git-live") || hasFlag(tokens, "--git-dry-run");
  if (runGit) {
    const gitDryRun = hasFlag(tokens, "--git-dry-run");
    const gitLive = hasFlag(tokens, "--git-live");
    const gitOptions: ApiRunRequest["git"] = {
      enabled: true,
      dryRun: gitDryRun ? true : gitLive ? false : true
    };
    const gitBranch = getFlagValue(tokens, "--git-branch");
    if (gitBranch !== undefined) {
      gitOptions.branchName = gitBranch;
    }

    const gitCommit = getFlagValue(tokens, "--git-commit");
    if (gitCommit !== undefined) {
      gitOptions.commitMessage = gitCommit;
    }

    const gitTitle = getFlagValue(tokens, "--git-title");
    if (gitTitle !== undefined) {
      gitOptions.prTitle = gitTitle;
    }

    const gitBody = getFlagValue(tokens, "--git-body");
    if (gitBody !== undefined) {
      gitOptions.prBody = gitBody;
    }

    const gitPaths = getFlagValues(tokens, "--git-path").filter((path) => path.length > 0);
    if (gitPaths.length > 0) {
      gitOptions.paths = gitPaths;
    }

    request.git = gitOptions;
  }

  return request;
}

function getFlagValue(tokens: string[], flagName: string): string | undefined {
  const index = tokens.indexOf(flagName);

  if (index < 0 || index >= tokens.length - 1) {
    return undefined;
  }

  return tokens[index + 1];
}

function getFlagValues(tokens: string[], flagName: string): string[] {
  const values: string[] = [];

  let cursor = 0;
  while (cursor < tokens.length) {
    const index = tokens.indexOf(flagName, cursor);
    if (index < 0) {
      break;
    }

    const value = tokens[index + 1];
    if (value !== undefined) {
      values.push(value);
    }

    cursor = index + 2;
  }

  return values;
}

function hasFlag(tokens: string[], flagName: string): boolean {
  return tokens.includes(flagName);
}

function parsePositiveInt(value?: string, flagName = "--max-planner-steps"): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flagName}: ${value}`);
  }

  return parsed;
}

function toSessionRequest(value: ApiSessionStartRequest): StartHarnessSessionOptions {
  return {
    ...(value.configPath !== undefined ? { configPath: value.configPath } : {}),
    ...(value.cwd !== undefined ? { cwd: value.cwd } : {}),
    ...(value.targetPath !== undefined ? { targetPath: value.targetPath } : {}),
    ...(value.taskId !== undefined ? { taskId: value.taskId } : {}),
    ...(value.skillIds !== undefined ? { skillIds: [...value.skillIds] } : {}),
    ...(value.projectSlug !== undefined ? { projectSlug: value.projectSlug } : {})
  };
}

function toRunRequest(value: ApiRunRequest): RunSelfBuildExecutorOptions {
  return {
    ...(value.configPath !== undefined ? { configPath: value.configPath } : {}),
    ...(value.cwd !== undefined ? { cwd: value.cwd } : {}),
    ...(value.targetPath !== undefined ? { targetPath: value.targetPath } : {}),
    ...(value.taskId !== undefined ? { taskId: value.taskId } : {}),
    ...(value.objective !== undefined ? { objective: value.objective } : {}),
    ...(value.projectSlug !== undefined ? { projectSlug: value.projectSlug } : {}),
    ...(value.maxPlannerSteps !== undefined ? { maxPlannerSteps: value.maxPlannerSteps } : {}),
    ...(value.maxPlannerRetries !== undefined ? { maxPlannerRetries: value.maxPlannerRetries } : {}),
    ...(value.allowDirtyWorkspace !== undefined ? { allowDirtyWorkspace: value.allowDirtyWorkspace } : {}),
    ...(value.allowRiskyPaths !== undefined ? { allowRiskyPaths: value.allowRiskyPaths } : {}),
    ...(value.resumeSessionId !== undefined ? { resumeSessionId: value.resumeSessionId } : {}),
    ...(value.includeReviewGate !== undefined ? { includeReviewGate: value.includeReviewGate } : {}),
    ...(value.git !== undefined ? { git: { ...value.git } } : {})
  };
}

function renderTuiHelp(): string {
  return [
    "guruharness TUI commands:",
    "- plan [--config path] [--cwd path]",
    "- direction [--config path] [--cwd path]",
    "- session [--config path] [--cwd path] [--target path] [--task-id id] [--project slug] [--skill id]",
    "- run [--config path] [--cwd path] [--target path] [--task-id id] [--objective text] [--project slug] [--max-planner-steps N] [--max-planner-retries N] [--resume-session id] [--allow-dirty-workspace] [--allow-risky-paths] [--skip-review-gate]",
    "- run [--git] [--git-dry-run] [--git-live] [--git-branch name] [--git-commit msg] [--git-title title] [--git-body body] [--git-path path]...",
    "- exit / quit"
  ].join("\n");
}
