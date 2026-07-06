import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarnessRuntime, type PlannerModel, type PlannerModelRequest } from "../../src/index.js";
import { expectSamePath } from "../helpers/paths.js";

const tempDirectories: string[] = [];

const SENTINEL = "clean-room-sentinel";

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

describe("clean-room harness dogfood", () => {
  it("should run a trivial repo end-to-end with a one-turn no-tool sentinel plan", async () => {
    const repoRoot = makeCleanRoomRepo();
    const planner = new SentinelPlanner();
    const runtime = createHarnessRuntime({ plannerModel: planner });

    const session = await runtime.startSession({ cwd: repoRoot });
    const report = await runtime.runPlanner(session.id, { objective: SENTINEL, maxSteps: 1 });

    expect(session.status).toBe("ready");
    expectSamePath(session.repo?.repoRoot, repoRoot);
    expect(planner.requests).toHaveLength(1);
    expectSamePath(planner.requests[0]?.session.repo?.repoRoot, repoRoot);
    expect(report).toMatchObject({
      objective: SENTINEL,
      status: "completed",
      blockers: [],
      observations: [],
      plan: {
        objective: SENTINEL,
        summary: SENTINEL,
        steps: []
      }
    });
  });
});

class SentinelPlanner implements PlannerModel {
  readonly requests: PlannerModelRequest[] = [];

  createPlan(request: PlannerModelRequest): unknown {
    this.requests.push(request);

    return {
      objective: request.objective,
      summary: SENTINEL,
      steps: []
    };
  }
}

function makeCleanRoomRepo(): string {
  const directory = mkdtempSync(join(tmpdir(), "guruharness-clean-room-"));
  tempDirectories.push(directory);
  execFileSync("git", ["init"], { cwd: directory, stdio: "ignore" });
  writeFileSync(join(directory, "AGENTS.md"), "# Clean Room\n\nNo special instructions.\n", "utf8");

  return directory;
}
