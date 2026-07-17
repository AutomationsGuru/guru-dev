import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBaseTools } from "../../src/tools/builtins/baseToolFactory.js";
import { resetBackgroundTasks } from "../../src/tools/builtins/backgroundTaskRegistry.js";
import { createToolRegistry, executeRegisteredTool, type ToolObservation } from "../../src/tools/registry.js";

interface ManagedTaskView {
  readonly state?: string;
}

function managedView(observation: ToolObservation): ManagedTaskView {
  return ((observation.output as { readonly result?: ManagedTaskView } | undefined)?.result ?? {});
}

describe("manage_task secret-safety choke point", () => {
  let repoRoot: string;

  beforeEach(async () => {
    resetBackgroundTasks();
    repoRoot = await mkdtemp(join(tmpdir(), "guruharness-manage-secret-"));
  });

  afterEach(async () => {
    resetBackgroundTasks();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("scrubs background stdout before list or status reaches the agent", async () => {
    const syntheticSecret = ["sk", "abcdefghijklmnop1234"].join("-");
    const script = "process.stdout.write(['sk', 'abcdefghijklmnop1234'].join('-'))";
    const registry = createToolRegistry(createBaseTools({ bash: { shellAllowlist: [process.execPath] } }));

    const launched = await executeRegisteredTool(registry, "bash", {
      repoRoot,
      command: process.execPath,
      args: ["-e", script],
      background: true,
      dryRun: false
    });
    const taskId = (launched.output as { readonly taskId?: string } | undefined)?.taskId;
    expect(taskId).toMatch(/^task-/u);

    const deadline = Date.now() + 5_000;
    let status = await executeRegisteredTool(registry, "manage_task", { Action: "status", TaskId: taskId });
    while (managedView(status).state === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await executeRegisteredTool(registry, "manage_task", { Action: "status", TaskId: taskId });
    }

    expect(managedView(status).state).toBe("completed");
    const statusText = JSON.stringify(status.output);
    expect(statusText).not.toContain(syntheticSecret);
    expect(statusText).toContain("[redacted:secret-shape]");

    const listed = await executeRegisteredTool(registry, "manage_task", { Action: "list" });
    const listText = JSON.stringify(listed.output);
    expect(listText).not.toContain(syntheticSecret);
    expect(listText).toContain("[redacted:secret-shape]");
  });
});
