import { describe, expect, it } from "vitest";

import { createScheduleTool, ScheduleToolInputSchema } from "../../src/tools/builtins/scheduleTool.js";
import { createManageTaskTool, ManageTaskToolInputSchema } from "../../src/tools/builtins/manageTaskTool.js";
import { createMonitorTool, MonitorToolInputSchema } from "../../src/tools/builtins/monitorTool.js";
import { GURU_CHAT_TOOL_IDS, READ_ONLY_TOOL_IDS } from "../../src/guru.js";
import { MANDATE_READ_ONLY_TOOLS, verbsForCall } from "../../src/mandates/evaluate.js";

/**
 * Coverage for the schedule / manage_task tools (wave 2026-07-10). Each has an
 * injectable backend seam, so a small unit test locks the contract — large
 * flows are exercised in the daily-driver / smoke lanes. The web/todo/ask
 * duplicates from this wave were superseded by the v1.4.2–v1.4.8 remote tools
 * (web_search / web_fetch / todo_write / todo_list / ask_question).
 */
describe("schedule tool", () => {
  it("throws a clear error when no scheduler backend is wired", async () => {
    const tool = createScheduleTool();
    const result = tool.execute(
      { Prompt: "ping", DurationSeconds: "5" },
      {}
    );
    await expect(result).rejects.toThrow(/scheduler backend/i);
  });

  it("calls injected onSchedule and returns its taskId", async () => {
    const tool = createScheduleTool({ onSchedule: async () => "sched-42" });
    const out = await tool.execute({ Prompt: "ping", DurationSeconds: "10" }, {});
    expect(out.taskId).toBe("sched-42");
  });

  it("schema rejects when both DurationSeconds and CronExpression are set", () => {
    expect(() =>
      ScheduleToolInputSchema.parse({ Prompt: "x", DurationSeconds: "5", CronExpression: "* * * * *" })
    ).toThrow();
  });
});

describe("manage_task tool", () => {
  it("throws a clear error when no task manager backend is wired", async () => {
    const tool = createManageTaskTool();
    const result = tool.execute({ Action: "list" }, {});
    await expect(result).rejects.toThrow(/task manager backend/i);
  });

  it("validates TaskId is present for kill/status/send_input", async () => {
    const calls: Array<[string, string | undefined, string | undefined]> = [];
    const tool = createManageTaskTool({
      onManage: async (action, taskId, input) => {
        calls.push([action, taskId, input]);
        return { ok: true };
      }
    });
    await expect(tool.execute({ Action: "kill" }, {})).rejects.toThrow(/TaskId/);
    await expect(tool.execute({ Action: "send_input" }, {})).rejects.toThrow(/TaskId/);
    await expect(tool.execute({ Action: "send_input", TaskId: "t1" }, {})).rejects.toThrow(/Input/);
    expect(calls).toEqual([]); // all three validation-failed before invoking the backend
  });

  it("forwards list/kill/status calls to the backend", async () => {
    const calls: Array<[string, string | undefined, string | undefined]> = [];
    const tool = createManageTaskTool({
      onManage: async (action, taskId, input) => {
        calls.push([action, taskId, input]);
        return { action, taskId, input };
      }
    });
    const list = await tool.execute({ Action: "list" }, {});
    expect(list.result).toEqual({ action: "list", taskId: undefined, input: undefined });
    const kill = await tool.execute({ Action: "kill", TaskId: "t1" }, {});
    expect(kill.result).toEqual({ action: "kill", taskId: "t1", input: undefined });
    const send = await tool.execute({ Action: "send_input", TaskId: "t2", Input: "ping" }, {});
    expect(send.result).toEqual({ action: "send_input", taskId: "t2", input: "ping" });
  });

  it("exposes a Zod input schema with the documented shape", () => {
    const parsed = ManageTaskToolInputSchema.parse({ Action: "list" });
    expect(parsed.Action).toBe("list");
  });
});

describe("monitor tool", () => {
  it("requires a backend when used outside the default base-tool factory", async () => {
    const tool = createMonitorTool();
    await expect(tool.execute({ TaskId: "t1", AfterCursor: 0, MaxLines: 50 }, {})).rejects.toThrow(/monitor backend/iu);
  });

  it("uses bounded cursor defaults and returns only structured observation fields", async () => {
    const calls: Array<[string, number, number]> = [];
    const tool = createMonitorTool({
      onMonitor: async (taskId, afterCursor, maxLines) => {
        calls.push([taskId, afterCursor, maxLines]);
        return {
          taskId,
          state: "completed",
          lines: [{ cursor: 1, stream: "stdout", text: "ok" }],
          nextCursor: 1,
          truncated: false,
          oldestCursor: 1
        };
      }
    });

    const output = await tool.execute({ TaskId: "t1", AfterCursor: 0, MaxLines: 50 }, {});
    expect(calls).toEqual([["t1", 0, 50]]);
    expect(output).toEqual({
      taskId: "t1",
      state: "completed",
      lines: [{ cursor: 1, stream: "stdout", text: "ok" }],
      nextCursor: 1,
      truncated: false,
      oldestCursor: 1
    });
  });

  it("has a strict non-mutating schema with the documented bounds", () => {
    expect(MonitorToolInputSchema.parse({ TaskId: "t1" })).toEqual({ TaskId: "t1" });
    expect(MonitorToolInputSchema.safeParse({ TaskId: "t1", AfterCursor: -1 }).success).toBe(false);
    expect(MonitorToolInputSchema.safeParse({ TaskId: "t1", MaxLines: 0 }).success).toBe(false);
    expect(MonitorToolInputSchema.safeParse({ TaskId: "t1", MaxLines: 201 }).success).toBe(false);
    expect(MonitorToolInputSchema.safeParse({ TaskId: "t1", Action: "kill" }).success).toBe(false);
    expect(MonitorToolInputSchema.safeParse({ TaskId: "t1", Input: "payload" }).success).toBe(false);
  });

  it("is exposed to chat and classified read-only across both policy registries", () => {
    expect(GURU_CHAT_TOOL_IDS.has("monitor")).toBe(true);
    expect(READ_ONLY_TOOL_IDS.has("monitor")).toBe(true);
    expect(MANDATE_READ_ONLY_TOOLS.has("monitor")).toBe(true);
    expect(verbsForCall("monitor", { TaskId: "t1", Action: "kill" })).toEqual([]);
  });
});
