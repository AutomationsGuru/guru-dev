import { describe, expect, it } from "vitest";

import {
  createScheduleTool,
  ScheduleToolInputSchema,
  ScheduleToolOutputSchema
} from '../../src/tools/builtins/scheduleTool.js';
import { createBaseTools } from '../../src/tools/builtins/baseToolFactory.js';

/**
 * GAP-0001 residual: the schedule tool must never be a silent noop.
 *
 * Truth on tip:
 *  - Bare createScheduleTool() (no backend) stays FAIL-CLOSED at execute time
 *    with a clear host-bridge message — it never fabricates a taskId.
 *  - An injected onSchedule backend is called with the parsed input and its
 *    taskId is returned verbatim.
 *  - Base-tool factory HONESTY: the factory must not register a dead schedule
 *    tool. With no backend it OMITS schedule from the base set; with a backend
 *    it registers a live one. (Surfaces with a delivery callback — TUI — keep
 *    schedule; headless surfaces simply do not offer it.)
 */
describe("scheduleTool — GAP-0001 honesty", () => {
  describe("fail-closed without a backend", () => {
    it("bare createScheduleTool() throws a clear host-bridge error and never returns a taskId", async () => {
      const tool = createScheduleTool();
      await expect(tool.execute({ Prompt: "ping", DurationSeconds: "5" }, {})).rejects.toThrow(
        /scheduler backend/i
      );
    });

    it("fail-closed message is stable for cron-shaped input too (no silent acceptance)", async () => {
      const tool = createScheduleTool();
      await expect(
        tool.execute({ Prompt: "nightly", CronExpression: "0 3 * * *" }, {})
      ).rejects.toThrow(/scheduler backend/i);
    });

    it("explicit empty options still fails closed", async () => {
      const tool = createScheduleTool({});
      await expect(tool.execute({ Prompt: "ping", DurationSeconds: "1" }, {})).rejects.toThrow(
        /scheduler backend/i
      );
    });
  });

  describe("injected backend", () => {
    it("invokes onSchedule with the exact parsed input and returns its taskId", async () => {
      const seen: unknown[] = [];
      const tool = createScheduleTool({
        onSchedule: async (input) => {
          seen.push(input);
          return "task-abc";
        }
      });
      const out = await tool.execute({ Prompt: "wake", DurationSeconds: "12" }, {});
      expect(out).toEqual({ taskId: "task-abc" });
      expect(seen).toEqual([{ Prompt: "wake", DurationSeconds: "12" }]);
    });

    it("output matches the declared output schema", async () => {
      const tool = createScheduleTool({ onSchedule: async () => "tid-9" });
      const out = await tool.execute({ Prompt: "p", DurationSeconds: "2" }, {});
      expect(() => ScheduleToolOutputSchema.parse(out)).not.toThrow();
    });
  });

  describe("schema honesty (input validation, no loose acceptance)", () => {
    it("requires exactly one of DurationSeconds / CronExpression", () => {
      expect(ScheduleToolInputSchema.safeParse({ Prompt: "x" }).success).toBe(false);
      expect(
        ScheduleToolInputSchema.safeParse({ Prompt: "x", DurationSeconds: "5", CronExpression: "* * * * *" }).success
      ).toBe(false);
      expect(ScheduleToolInputSchema.safeParse({ Prompt: "x", DurationSeconds: "5" }).success).toBe(true);
      expect(ScheduleToolInputSchema.safeParse({ Prompt: "x", CronExpression: "* * * * *" }).success).toBe(true);
    });

    it("rejects an empty Prompt", () => {
      expect(ScheduleToolInputSchema.safeParse({ Prompt: "", DurationSeconds: "5" }).success).toBe(false);
    });

    it("is strict: unknown keys are rejected", () => {
      expect(
        ScheduleToolInputSchema.safeParse({ Prompt: "x", DurationSeconds: "5", Bogus: "1" }).success
      ).toBe(false);
    });
  });

  describe("base-tool factory honesty", () => {
    it("registers schedule FAIL-CLOSED when no backend is injected (no silent noop; never fabricates a taskId)", async () => {
      const schedule = createBaseTools().find((t) => t.id === "schedule");
      expect(schedule).toBeDefined();
      await expect(schedule!.execute({ Prompt: "p", DurationSeconds: "3" }, {})).rejects.toThrow(
        /scheduler backend/i
      );
    });

    it("REGISTERS a working schedule tool when a backend is injected", async () => {
      const tools = createBaseTools({ schedule: { onSchedule: async () => "live-1" } });
      const schedule = tools.find((t) => t.id === "schedule");
      expect(schedule).toBeDefined();
      const out = await schedule!.execute({ Prompt: "p", DurationSeconds: "3" }, {});
      expect(out).toEqual({ taskId: "live-1" });
    });

    it("the schedule entry never disturbs the sibling base tools", () => {
      const ids = createBaseTools().map((t) => t.id);
      for (const id of ["read", "write", "edit", "bash", "grep", "glob", "ls", "manage_task", "monitor"]) {
        expect(ids).toContain(id);
      }
    });
  });
});
