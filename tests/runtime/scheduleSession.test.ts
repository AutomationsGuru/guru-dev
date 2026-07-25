import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHarnessRuntime } from '../../src/index.js';
import { resetBackgroundTasks } from '../../src/tools/builtins/backgroundTaskRegistry.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * GAP-0001 residual, session seam (S0-A owns the schedule residual; session.ts
 * wiring itself is S1-A's surface — these tests pin the CONTRACT so the lanes
 * converge on the same truth):
 *
 *  - A live interactive surface that injects `interactiveCallbacks.schedule`
 *    gets a WORKING one-shot `DurationSeconds` schedule: the delivery callback
 *    fires and a real taskId is returned.
 *  - Cron / MaxIterations / conditional timers are explicitly REJECTED with
 *    stable errors — never silently accepted and never half-implemented.
 *  - A session with NO schedule delivery callback is fail-closed: schedule
 *    either is not offered or errors with a clear host-bridge message, and it
 *    NEVER fabricates a taskId.
 */
describe("schedule session backend — GAP-0001", () => {
  afterEach(() => {
    resetBackgroundTasks();
  });

  describe("interactive surface with a delivery callback", () => {
    it("delivers a one-shot DurationSeconds schedule through the injected callback", async () => {
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
        const obs = await runtime.executeTool(session.id, "schedule", {
          Prompt: "check the worker",
          DurationSeconds: "0.001"
        });

        expect(obs).toMatchObject({ status: "succeeded" });
        expect((obs.output as { taskId?: string }).taskId).toMatch(/^task-/u);
        await vi.waitFor(() => expect(delivered).toEqual(["[scheduled] check the worker"]));
      } finally {
        await runtime.close();
      }
    });

    it("rejects cron, MaxIterations, and conditional timers with stable explicit errors", async () => {
      const runtime = createHarnessRuntime({
        interactiveCallbacks: { schedule: async () => {} }
      });

      try {
        const session = await runtime.startSession({ cwd: repoRoot });
        const cases: Array<{ input: Record<string, string>; pattern: RegExp }> = [
          { input: { Prompt: "cron", CronExpression: "* * * * *" }, pattern: /cron|recurring|not supported/iu },
          { input: { Prompt: "repeat", DurationSeconds: "1", MaxIterations: "2" }, pattern: /MaxIterations|not supported/iu },
          { input: { Prompt: "cond", DurationSeconds: "1", TimerCondition: "any" }, pattern: /conditional|TimerCondition|not supported/iu }
        ];
        for (const { input, pattern } of cases) {
          const obs = await runtime.executeTool(session.id, "schedule", input);
          expect(obs).toMatchObject({ status: "failed" });
          expect(obs.error).toMatch(pattern);
        }
      } finally {
        await runtime.close();
      }
    });
  });

  describe("headless surface with no delivery callback", () => {
    it("is fail-closed: schedule never fabricates a taskId without a backend", async () => {
      const runtime = createHarnessRuntime();

      try {
        const session = await runtime.startSession({ cwd: repoRoot });
        const offered = session.tools.map((t) => t.id);
        const obs = await runtime.executeTool(session.id, "schedule", {
          Prompt: "never fires",
          DurationSeconds: "1"
        });

        // Either the tool is omitted (not offered) OR it errors — but it must
        // never report success and never invent a taskId.
        expect(obs.status).toBe("failed");
        expect(obs.error ?? "").not.toMatch(/taskId/u);
        if (!offered.includes("schedule")) {
          expect(obs.error).toMatch(/not registered|scheduler backend/iu);
        } else {
          expect(obs.error).toMatch(/scheduler backend/iu);
        }
      } finally {
        await runtime.close();
      }
    });
  });
});
