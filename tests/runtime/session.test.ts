import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  createHarnessRuntime,
  createInMemoryOperationalStore,
  createInMemorySessionPersistenceStore,
  createToolRegistry,
  startHarnessSession,
  type HarnessRuntime,
  type ToolDefinition
} from "../../src/index.js";
import { initExtensions } from "../../src/extensions/initExtensions.js";
import { ensureGuruHome } from "../../src/home/paths.js";
import { manageBackgroundTask, resetBackgroundTasks } from "../../src/tools/builtins/backgroundTaskRegistry.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fakeMcpServer = resolve(repoRoot, "tests", "mcp", "fixtures", "fake-mcp-server.mjs");

async function writeMcpConfig(servers: readonly Record<string, unknown>[]): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(resolve(tmpdir(), "guruharness-runtime-mcp-"));
  const path = resolve(directory, "guruharness.config.json");
  await writeFile(path, JSON.stringify({ mcpServers: servers }), "utf8");
  return { directory, path };
}

function fakeMcpConfig(id = "fake"): Record<string, unknown> {
  return {
    id,
    transport: "stdio",
    command: process.execPath,
    args: [fakeMcpServer],
    category: "test",
    timeoutMs: 10_000
  };
}

async function closeRuntimeAndRemoveConfig(runtime: HarnessRuntime, directory: string): Promise<void> {
  await runtime.close();
  await rm(directory, { recursive: true, force: true });
}

describe("startHarnessSession", () => {
  it("should assemble the next task, repo, skill catalog, memory, policy, and tools", async () => {
    const session = await startHarnessSession({ cwd: repoRoot });

    expect(session).toMatchObject({
      runtimeName: "GuruHarness",
      status: "ready",
      task: {
        id: "api-startup-dogfood",
        title: "Dogfood API startup playbook"
      },
      direction: {
        verdict: "GREEN"
      },
      repo: {
        repoRoot,
        agentsChain: [
          expect.objectContaining({
            relativePath: "AGENTS.md"
          })
        ]
      },
      memory: {
        provider: "in-memory-operational-store",
        status: "available",
        projectSlug: "guruharness"
      },
      policy: {
        validationCommands: expect.arrayContaining(["test", "typecheck", "build", "repo-hygiene"]),
        reviewGate: { provider: "native-critic-panel", required: true },
        approvalPolicy: {
          autoCommitPushPr: true,
          allowLocalMerge: false,
          allowForcePush: false
        }
      }
    });
    expect(session.skills.catalog.skills.map((skill) => skill.id)).toEqual(
      expect.arrayContaining(["guruharness-self-build"])
    );
    expect(session.tools.map((tool) => tool.id)).toEqual([
      "ask_question",
      "bash",
      "edit",
      "fs.edit.apply",
      "get_task_output",
      "git.pr.run",
      "github.pr.comment",
      "github.pr.review",
      "github.pr.status",
      "glob",
      "grep",
      "honcho_context",
      "honcho_log_turn",
      "honcho_memory_status",
      "honcho_recall",
      "honcho_remember",
      "kill_task",
      "ls",
      "lsp",
      "maintenance.audit.run",
      "manage_task",
      "mcp_bridge_status",
      "memory_doctor",
      "memory_forget",
      "memory_get",
      "memory_remember",
      "memory_search",
      "memory_status",
      "operational.backlog.create",
      "operational.backlog.list",
      "operational.blocker.record",
      "operational.decision.upsert",
      "operational.implementation.create",
      "operational.project.get",
      "operational.state.list",
      "operational.state.write",
      "provider_cli_run",
      "provider_cli_status",
      "pyautogui_keyboard",
      "pyautogui_mouse",
      "pyautogui_screen",
      "pyautogui_status",
      "read",
      "read_diagnostics",
      "repo.context.resolve",
      "resolve_capability_gap",
      "review.gates.run",
      "schedule",
      "search_tool",
      "service_readiness_report",
      "shell.command.run",
      "skill.document.load",
      "skills.catalog.list",
      "spawn_agent",
      "todo_list",
      "todo_write",
      "use_tool",
      "web_fetch",
      "web_search",
      "write"
    ]);
    expect(session.blockers).toEqual([]);
    expect(session.nextActions).toContain("Dispatch typed tools through the session registry as needed.");
  });

  it("should load requested skill documents into the session context", async () => {
    const session = await startHarnessSession({ cwd: repoRoot, skillIds: ["guruharness-self-build"] });

    expect(session.status).toBe("ready");
    expect(session.skills.loaded).toHaveLength(1);
    expect(session.skills.loaded[0]?.manifest.id).toBe("guruharness-self-build");
    expect(session.skills.loaded[0]?.content).toContain("GuruHarness Self-Build");
  });

  it("should block the session when a requested skill cannot be loaded", async () => {
    const session = await startHarnessSession({ cwd: repoRoot, skillIds: ["missing-skill"] });

    expect(session.status).toBe("blocked");
    expect(session.blockers).toEqual(expect.arrayContaining([expect.stringContaining("missing-skill")]));
    expect(session.nextActions).toEqual(["Resolve session blocker(s), then restart the harness session."]);
  });

  it("should block the session when an explicit task id is unknown", async () => {
    const session = await startHarnessSession({ cwd: repoRoot, taskId: "missing-task" });

    expect(session.status).toBe("blocked");
    expect(session.task).toBeNull();
    expect(session.blockers).toEqual(["Self-build task not found: missing-task"]);
  });

  it("should start an explicit task when a task id is provided", async () => {
    const session = await startHarnessSession({ cwd: repoRoot, taskId: "planner-runtime" });

    expect(session.status).toBe("ready");
    expect(session.task?.id).toBe("planner-runtime");
    expect(session.direction.task?.thereContribution).toContain("model-backed planning");
  });

  it("chat purpose: no self-build task is planned and no planner blockers apply", async () => {
    const session = await startHarnessSession({ cwd: repoRoot, purpose: "chat" });

    expect(session.status).toBe("ready");
    expect(session.task).toBeNull();
    expect(session.blockers).toEqual([]);
  });

  it("chat purpose rejects a taskId — chat sessions carry no self-build task", async () => {
    await expect(startHarnessSession({ cwd: repoRoot, purpose: "chat", taskId: "planner-runtime" })).rejects.toThrow(/chat/u);
  });

  it("creates a usable project-specific harness in a fresh non-Git folder", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "guruharness-fresh-project-"));
    const homeDirectory = resolve(root, "home");
    const projectDirectory = resolve(root, "project");
    const home = ensureGuruHome({ homeDirectory }).paths;
    await mkdir(resolve(home.skillsDirectory, "shared"), { recursive: true });
    await writeFile(
      resolve(home.skillsDirectory, "shared", "SKILL.md"),
      "---\nname: shared-home-skill\ndescription: Available through the home profile.\n---\n# Shared home skill\n",
      "utf8"
    );

    try {
      const session = await startHarnessSession({
        cwd: projectDirectory,
        purpose: "chat",
        guruHomeDirectory: homeDirectory
      });

      expect(session.status).toBe("ready");
      expect(session.repo).toBeNull();
      expect(session.config).toMatchObject({ source: "project", status: "loaded" });
      expect(session.projectHarness).toMatchObject({
        status: "ready",
        projectRoot: projectDirectory,
        configPath: resolve(projectDirectory, ".guru", "guruharness.config.json")
      });
      expect(session.skills.catalog.skills.map((skill) => skill.id)).toContain("shared-home-skill");
      expect(session.projectHarness?.manifest?.toolIds).toContain("read");
      expect(existsSync(resolve(projectDirectory, ".guru", "harness.json"))).toBe(true);
      expect(existsSync(resolve(projectDirectory, ".guru", "memory", "MEMORY.md"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("createHarnessRuntime", () => {
  afterEach(() => {
    resetBackgroundTasks();
  });

  it("forwards interactive schedule delivery without enabling recurring or conditional modes", async () => {
    const delivered: string[] = [];
    const runtime = createHarnessRuntime({
      interactiveCallbacks: {
        schedule: async (message) => {
          delivered.push(message);
        }
      }
    });

    try {
      const session = await runtime.startSession({ cwd: repoRoot });
      const scheduled = await runtime.executeTool(session.id, "schedule", {
        Prompt: "check the worker",
        DurationSeconds: "0.001"
      });

      expect(scheduled).toMatchObject({ status: "succeeded", output: { taskId: "task-1" } });
      await vi.waitFor(() => expect(delivered).toEqual(["[scheduled] check the worker"]));

      for (const input of [
        { Prompt: "cron", CronExpression: "* * * * *" },
        { Prompt: "repeat", DurationSeconds: "1", MaxIterations: "2" },
        { Prompt: "conditional", DurationSeconds: "1", TimerCondition: "any" }
      ]) {
        const rejected = await runtime.executeTool(session.id, "schedule", input);
        expect(rejected).toMatchObject({ status: "failed" });
        expect(rejected.error).toMatch(/not supported|unsupported/iu);
      }
    } finally {
      await runtime.close();
    }
  });

  it("keeps schedule fail-closed when no interactive delivery callback is configured", async () => {
    const runtime = createHarnessRuntime();

    try {
      const session = await runtime.startSession({ cwd: repoRoot });
      const observation = await runtime.executeTool(session.id, "schedule", {
        Prompt: "never scheduled",
        DurationSeconds: "1"
      });

      expect(observation).toMatchObject({ status: "failed" });
      expect(observation.error).toMatch(/scheduler backend/iu);
    } finally {
      await runtime.close();
    }
  });

  it("clears pending scheduled notifications when the runtime closes", async () => {
    const runtime = createHarnessRuntime({
      interactiveCallbacks: { schedule: async () => {} }
    });
    const session = await runtime.startSession({ cwd: repoRoot });

    await runtime.executeTool(session.id, "schedule", {
      Prompt: "must be cleared",
      DurationSeconds: "60"
    });
    expect(await manageBackgroundTask("list")).toEqual([
      expect.objectContaining({ kind: "scheduled", state: "running" })
    ]);

    await runtime.close();

    expect(await manageBackgroundTask("list")).toEqual([]);
  });

  it("should attach configured MCP tools to a new runtime session", async () => {
    const config = await writeMcpConfig([fakeMcpConfig()]);
    const runtime = createHarnessRuntime();

    try {
      const session = await runtime.startSession({ cwd: repoRoot, configPath: config.path });

      expect(session.tools.map((tool) => tool.id)).toContain("mcp.fake.echo");
      expect(runtime.getSessionTools(session.id).map((tool) => tool.id)).toContain("mcp.fake.echo");
      expect(runtime.getSessionMcpStatuses(session.id)).toEqual([
        expect.objectContaining({ serverId: "fake", status: "ready", toolCount: 4 })
      ]);

      const observation = await runtime.executeTool(session.id, "mcp.fake.echo", { arguments: { value: "runtime" } });
      expect(observation).toMatchObject({
        status: "succeeded",
        output: expect.objectContaining({ status: "succeeded", text: expect.stringContaining('echo:{"value":"runtime"}') })
      });
    } finally {
      await closeRuntimeAndRemoveConfig(runtime, config.directory);
    }
  });

  it("should surface partial MCP attachment failures without blocking session startup", async () => {
    const missingEnvName = "GURUHARNESS_RUNTIME_MCP_TEST_KEY_THAT_IS_UNSET";
    delete process.env[missingEnvName];
    const config = await writeMcpConfig([
      fakeMcpConfig(),
      { ...fakeMcpConfig("keyless"), requiredEnvNames: [missingEnvName] },
      { ...fakeMcpConfig("broken"), command: "definitely-not-a-real-binary-guruharness", timeoutMs: 500 }
    ]);
    const runtime = createHarnessRuntime();

    try {
      const session = await runtime.startSession({ cwd: repoRoot, configPath: config.path });
      const statuses = new Map(runtime.getSessionMcpStatuses(session.id).map((status) => [status.serverId, status]));

      expect(session.status).toBe("ready");
      expect(runtime.getSessionTools(session.id).map((tool) => tool.id)).toContain("mcp.fake.echo");
      expect(statuses.get("fake")).toMatchObject({ status: "ready", toolCount: 4 });
      expect(statuses.get("keyless")).toMatchObject({ status: "missing-env", missingEnvNames: [missingEnvName] });
      expect(statuses.get("broken")).toMatchObject({ status: "error" });
    } finally {
      await closeRuntimeAndRemoveConfig(runtime, config.directory);
    }
  });

  it("should reattach configured MCP tools when resuming a persisted session", async () => {
    const config = await writeMcpConfig([fakeMcpConfig()]);
    const persistence = createInMemorySessionPersistenceStore();
    const firstRuntime = createHarnessRuntime({ sessionPersistenceStore: persistence });
    const secondRuntime = createHarnessRuntime({ sessionPersistenceStore: persistence });

    try {
      const started = await firstRuntime.startSession({ cwd: repoRoot });
      const resumed = await secondRuntime.resumeSession(started.id, { cwd: repoRoot, configPath: config.path });

      expect(resumed?.tools.map((tool) => tool.id)).toContain("mcp.fake.echo");
      expect(secondRuntime.getSessionTools(started.id).map((tool) => tool.id)).toContain("mcp.fake.echo");
      expect(secondRuntime.getSessionMcpStatuses(started.id)).toEqual([
        expect.objectContaining({ serverId: "fake", status: "ready", toolCount: 4 })
      ]);
    } finally {
      await firstRuntime.close();
      await closeRuntimeAndRemoveConfig(secondRuntime, config.directory);
    }
  });

  it("should close and forget one runtime session explicitly", async () => {
    const config = await writeMcpConfig([fakeMcpConfig()]);
    const runtime = createHarnessRuntime();

    try {
      const session = await runtime.startSession({ cwd: repoRoot, configPath: config.path });

      await expect(runtime.closeSession(session.id)).resolves.toBe(true);
      expect(runtime.getSessionTools(session.id)).toEqual([]);
      expect(runtime.getSessionMcpStatuses(session.id)).toEqual([]);
      await expect(runtime.closeSession(session.id)).resolves.toBe(false);
    } finally {
      await closeRuntimeAndRemoveConfig(runtime, config.directory);
    }
  });

  it("should close every retained MCP client during runtime teardown", async () => {
    const config = await writeMcpConfig([fakeMcpConfig()]);
    const runtime = createHarnessRuntime();

    try {
      const first = await runtime.startSession({ cwd: repoRoot, configPath: config.path });
      const second = await runtime.startSession({ cwd: repoRoot, configPath: config.path });

      await runtime.close();

      expect(runtime.getSessionTools(first.id)).toEqual([]);
      expect(runtime.getSessionTools(second.id)).toEqual([]);
      await expect(runtime.close()).resolves.toBeUndefined();
    } finally {
      await closeRuntimeAndRemoveConfig(runtime, config.directory);
    }
  });

  it("should dispatch typed tools through the session registry", async () => {
    const runtime = createHarnessRuntime();
    const session = await runtime.startSession({ cwd: repoRoot });

    const observation = await runtime.executeTool(session.id, "repo.context.resolve", { cwd: repoRoot });

    expect(observation).toMatchObject({
      toolId: "repo.context.resolve",
      status: "succeeded",
      output: expect.objectContaining({ repoRoot })
    });
  });

  it("emits one ordered execute/result pair with the returned sanitized observation", async () => {
    const runtime = createHarnessRuntime();
    const session = await runtime.startSession({ cwd: repoRoot });
    const host = initExtensions().host;
    const sendMessage = vi.spyOn(host, "sendMessage");

    try {
      const succeeded = await runtime.executeTool(session.id, "repo.context.resolve", { cwd: repoRoot });
      const failed = await runtime.executeTool(session.id, "not.registered", {});
      const toolEvents = sendMessage.mock.calls.filter(([event]) => event === "tool:execute" || event === "tool:result");

      expect(toolEvents).toEqual([
        ["tool:execute", { toolId: "repo.context.resolve", input: { cwd: repoRoot } }],
        ["tool:result", { toolId: "repo.context.resolve", output: succeeded }],
        ["tool:execute", { toolId: "not.registered", input: {} }],
        ["tool:result", { toolId: "not.registered", output: failed }]
      ]);
      expect(JSON.stringify(toolEvents[1]?.[1])).toBe(JSON.stringify({ toolId: "repo.context.resolve", output: succeeded }));
      expect(JSON.stringify(toolEvents[3]?.[1])).toBe(JSON.stringify({ toolId: "not.registered", output: failed }));
    } finally {
      sendMessage.mockRestore();
      await runtime.close();
    }
  });

  it("does not emit false tool lifecycle events for missing-session or mandate-blocked calls", async () => {
    const runtime = createHarnessRuntime({
      mandatePolicy: () => ({ outcome: "deny", reason: "test denial", verbs: ["write"] })
    });
    const session = await runtime.startSession({ cwd: repoRoot });
    const host = initExtensions().host;
    const sendMessage = vi.spyOn(host, "sendMessage");

    try {
      const missing = await runtime.executeTool("missing-session", "repo.context.resolve", { cwd: repoRoot });
      const blocked = await runtime.executeTool(session.id, "write", {
        repoRoot,
        path: "must-not-write.txt",
        contents: "blocked",
        dryRun: false
      });

      expect(missing.status).toBe("failed");
      expect(blocked).toMatchObject({ status: "failed", error: expect.stringContaining("Blocked by mandate") });
      expect(sendMessage.mock.calls.filter(([event]) => event === "tool:execute" || event === "tool:result")).toEqual([]);
    } finally {
      sendMessage.mockRestore();
      await runtime.close();
    }
  });

  it("returns the observation unchanged when a post-result listener throws", async () => {
    const runtime = createHarnessRuntime();
    const session = await runtime.startSession({ cwd: repoRoot });
    const host = initExtensions().host;
    const originalSendMessage = host.sendMessage.bind(host);
    const sendMessage = vi.spyOn(host, "sendMessage").mockImplementation((event, payload) => {
      if (event === "tool:result") {
        throw new Error("broken result listener");
      }
      originalSendMessage(event as never, payload as never);
    });

    try {
      const observation = await runtime.executeTool(session.id, "not.registered", {});
      expect(observation).toMatchObject({
        toolId: "not.registered",
        status: "failed",
        error: "Tool not registered: not.registered"
      });
    } finally {
      sendMessage.mockRestore();
      await runtime.close();
    }
  });

  it("should return a failed observation for an unknown session", async () => {
    const runtime = createHarnessRuntime();
    const observation = await runtime.executeTool("missing-session", "repo.context.resolve", { cwd: repoRoot });

    expect(observation).toMatchObject({
      toolId: "repo.context.resolve",
      status: "failed",
      error: "Harness session not found: missing-session"
    });
  });

  it("should bind an injected operational store", async () => {
    const runtime = createHarnessRuntime({ operationalStore: createInMemoryOperationalStore() });
    const session = await runtime.startSession({ cwd: repoRoot });

    expect(session.memory.provider).toBe("injected-operational-store");

    const observation = await runtime.executeTool(session.id, "operational.project.get", { projectSlug: "guruharness" });

    expect(observation).toMatchObject({
      status: "succeeded",
      output: {
        project: expect.objectContaining({ slug: "guruharness" })
      }
    });
  });
});

describe("createToolRegistry", () => {
  it("should still support custom registries independently of runtime sessions", () => {
    const echoTool: ToolDefinition = {
      id: "custom.echo",
      title: "Custom echo",
      description: "Echo a message.",
      inputSchema: z.object({ message: z.string() }),
      outputSchema: z.object({ message: z.string() }),
      execute(input) {
        return input;
      }
    };

    const registry = createToolRegistry([echoTool]);

    expect(registry.list().map((tool) => tool.id)).toEqual(["custom.echo"]);
  });
});

describe("plan-mode runtime gate", () => {
  it("exposes exactly glob, grep, ls, read in registry order for a live session", async () => {
    const runtime = createHarnessRuntime();
    try {
      const session = await runtime.startSession({ cwd: repoRoot });

      expect(runtime.getSessionPlanModeTools(session.id).map((tool) => tool.id)).toEqual(["glob", "grep", "ls", "read"]);
    } finally {
      await runtime.close();
    }
  });

  it("runs a certified read and forwards the turn abort signal without invoking a planner/provider", async () => {
    const runtime = createHarnessRuntime();
    try {
      const session = await runtime.startSession({ cwd: repoRoot });
      const controller = new AbortController();

      const observation = await runtime.executePlanModeTool(
        session.id,
        "read",
        { repoRoot, path: "package.json", limit: 80 },
        controller.signal
      );

      expect(observation).toMatchObject({ toolId: "read", status: "succeeded" });
    } finally {
      await runtime.close();
    }
  });

  it("refuses write: failed observation, no file created, and no execute/result extension hooks", async () => {
    const runtime = createHarnessRuntime();
    const host = initExtensions().host;
    const sendMessage = vi.spyOn(host, "sendMessage");
    const targetDir = await mkdtemp(resolve(tmpdir(), "guruharness-plan-mode-write-"));
    const targetPath = resolve(targetDir, "must-not-create.txt");

    try {
      const session = await runtime.startSession({ cwd: repoRoot });
      const observation = await runtime.executePlanModeTool(session.id, "write", {
        repoRoot: targetDir,
        path: "must-not-create.txt",
        contents: "blocked",
        dryRun: false
      });

      expect(observation).toMatchObject({
        toolId: "write",
        status: "failed",
        error: expect.stringContaining("not allowlisted")
      });
      expect(existsSync(targetPath)).toBe(false);
      expect(sendMessage.mock.calls.filter(([event]) => event === "tool:execute" || event === "tool:result")).toEqual([]);
    } finally {
      sendMessage.mockRestore();
      await runtime.close();
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("refuses bash without invoking its executor", async () => {
    let executorCalls = 0;
    const runtime = createHarnessRuntime({
      commandExecutor: async () => {
        executorCalls += 1;

        return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
      }
    });

    try {
      const session = await runtime.startSession({ cwd: repoRoot });
      const observation = await runtime.executePlanModeTool(session.id, "bash", {
        repoRoot,
        command: "node",
        args: ["-e", "1"],
        dryRun: false
      });

      expect(observation).toMatchObject({ toolId: "bash", status: "failed", error: expect.stringContaining("not allowlisted") });
      expect(executorCalls).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("excludes attached MCP tools from the certified surface and refuses to invoke them", async () => {
    const config = await writeMcpConfig([fakeMcpConfig()]);
    const runtime = createHarnessRuntime();

    try {
      const session = await runtime.startSession({ cwd: repoRoot, configPath: config.path });

      expect(runtime.getSessionTools(session.id).map((tool) => tool.id)).toContain("mcp.fake.echo");
      expect(runtime.getSessionPlanModeTools(session.id).map((tool) => tool.id)).toEqual(["glob", "grep", "ls", "read"]);

      const observation = await runtime.executePlanModeTool(session.id, "mcp.fake.echo", { arguments: { value: "runtime" } });

      expect(observation).toMatchObject({
        toolId: "mcp.fake.echo",
        status: "failed",
        error: expect.stringContaining("not allowlisted")
      });
      expect(observation.output).toBeUndefined();
    } finally {
      await closeRuntimeAndRemoveConfig(runtime, config.directory);
    }
  });

  it("treats unknown and closed sessions as empty-list / failed-observation parity", async () => {
    const runtime = createHarnessRuntime();

    try {
      expect(runtime.getSessionPlanModeTools("missing-session")).toEqual([]);
      const missing = await runtime.executePlanModeTool("missing-session", "read", { repoRoot, path: "package.json" });

      expect(missing).toMatchObject({ toolId: "read", status: "failed", error: expect.stringContaining("session not found") });

      const session = await runtime.startSession({ cwd: repoRoot });
      await runtime.closeSession(session.id);

      expect(runtime.getSessionPlanModeTools(session.id)).toEqual([]);
      const closed = await runtime.executePlanModeTool(session.id, "read", { repoRoot, path: "package.json" });

      expect(closed).toMatchObject({ status: "failed" });
    } finally {
      await runtime.close();
    }
  });

  it("exposes the same restricted surface on start and resume without a configured planner model", async () => {
    const persistence = createInMemorySessionPersistenceStore();
    const firstRuntime = createHarnessRuntime({ sessionPersistenceStore: persistence });
    const secondRuntime = createHarnessRuntime({ sessionPersistenceStore: persistence });

    try {
      const started = await firstRuntime.startSession({ cwd: repoRoot });
      const surface = firstRuntime.getSessionPlanModeTools(started.id).map((tool) => tool.id);

      expect(surface).toEqual(["glob", "grep", "ls", "read"]);

      const resumed = await secondRuntime.resumeSession(started.id, { cwd: repoRoot });

      expect(resumed).toBeDefined();
      expect(secondRuntime.getSessionPlanModeTools(started.id).map((tool) => tool.id)).toEqual(surface);

      const observation = await secondRuntime.executePlanModeTool(started.id, "read", { repoRoot, path: "package.json", limit: 50 });

      expect(observation.status).toBe("succeeded");
    } finally {
      await firstRuntime.close();
      await secondRuntime.close();
    }
  });
});
