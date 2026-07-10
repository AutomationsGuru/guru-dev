import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  createHarnessRuntime,
  createInMemoryOperationalStore,
  createToolRegistry,
  startHarnessSession,
  type ToolDefinition
} from "../../src/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
        // main is a pristine runtime package (no AGENTS.md by design); AGENTS.md chain-
        // walking is covered against fixture repos in tests/maintenance/audit.test.ts.
        agentsChain: []
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
      "maintenance.audit.run",
      "memory_doctor",
      "memory_forget",
      "memory_get",
      "memory_remember",
      "memory_search",
      "operational.backlog.create",
      "operational.backlog.list",
      "operational.blocker.record",
      "operational.decision.upsert",
      "operational.implementation.create",
      "operational.project.get",
      "operational.state.list",
      "operational.state.write",
      "read",
      "repo.context.resolve",
      "resolve_capability_gap",
      "review.gates.run",
      "service_readiness_report",
      "shell.command.run",
      "skill.document.load",
      "skills.catalog.list",
      "spawn_agent",
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
});

describe("createHarnessRuntime", () => {
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
