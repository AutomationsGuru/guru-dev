import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  createHarnessRuntime,
  createInMemoryOperationalStore,
  type HarnessRuntime
} from '../../src/index.js';
import { PLAN_MODE_DENY_CODE } from '../../src/planner/workApprovalAxes.js';

async function makeRuntime(): Promise<{ runtime: HarnessRuntime; directory: string }> {
  const directory = await mkdtemp(resolve(tmpdir(), "guruharness-plan-posture-"));
  const runtime = createHarnessRuntime({
    operationalStore: createInMemoryOperationalStore()
  });

  return { runtime, directory };
}

describe("plan-mode session gate (dual-axis consult)", () => {
  it("denies a non-certified tool in plan mode with the stable error code before execution", async () => {
    const { runtime, directory } = await makeRuntime();
    try {
      const session = await runtime.startSession({ cwd: directory });
      const observation = await runtime.executePlanModeTool(session.id, "write", { path: "x", content: "y" });

      expect(observation.status).toBe("failed");
      expect(observation.error).toContain(PLAN_MODE_DENY_CODE);
      expect(observation.error).toContain("write");
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows a certified read-only tool in plan mode at the default ask posture", async () => {
    const { runtime, directory } = await makeRuntime();
    try {
      const session = await runtime.startSession({ cwd: directory });
      const observation = await runtime.executePlanModeTool(session.id, "ls", { repoRoot: directory, path: "." });

      expect(observation.status).toBe("succeeded");
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps denying non-certified tools even when the approval posture is full (posture never widens the plan floor)", async () => {
    const { runtime, directory } = await makeRuntime();
    try {
      const session = await runtime.startSession({ cwd: directory });
      const observation = await runtime.executePlanModeTool(session.id, "bash", { command: "echo hi" }, undefined, {
        workMode: "plan",
        approvalPosture: "full"
      });

      expect(observation.status).toBe("failed");
      expect(observation.error).toContain(PLAN_MODE_DENY_CODE);
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on garbage axis input", async () => {
    const { runtime, directory } = await makeRuntime();
    try {
      const session = await runtime.startSession({ cwd: directory });
      const observation = await runtime.executePlanModeTool(session.id, "write", { path: "x" }, undefined, {
        workMode: "bogus",
        approvalPosture: "bogus"
      });

      expect(observation.status).toBe("failed");
      expect(observation.error).toContain(PLAN_MODE_DENY_CODE);
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
