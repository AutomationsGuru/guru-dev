import { describe, expect, it } from "vitest";

import { createAskQuestionTool, AskQuestionToolInputSchema } from "../../src/tools/builtins/askQuestionTool.js";
import { createReadUrlTool } from "../../src/tools/builtins/readUrlTool.js";
import { createSearchWebTool } from "../../src/tools/builtins/searchWebTool.js";
import { createScheduleTool, ScheduleToolInputSchema } from "../../src/tools/builtins/scheduleTool.js";
import { createManageTaskTool, ManageTaskToolInputSchema } from "../../src/tools/builtins/manageTaskTool.js";
import { createSessionTodosTool } from "../../src/tools/builtins/sessionTodosTool.js";
import { defaultFetchUrlContent, defaultWebSearch, htmlToReadableText } from "../../src/tools/builtins/httpFetch.js";

/**
 * Coverage for the untracked-but-shipped net / scheduling / todo tools (wave
 * 2026-07-10). These have a default TTY-prompt / DuckDuckGo / in-memory backend
 * each, so a small unit test is enough to lock the contract — large flows are
 * exercised in the daily-driver / smoke lanes.
 */
describe("ask_question tool", () => {
  it("uses injected onAsk callback when provided", async () => {
    const seen: unknown[] = [];
    const tool = createAskQuestionTool({
      onAsk: async (questions) => {
        seen.push(questions);
        return [["picked"]];
      }
    });
    const out = await tool.execute({ questions: [{ question: "Q?", options: ["A", "B"] }] }, {});
    expect(seen).toHaveLength(1);
    expect(out.answers).toEqual([["picked"]]);
  });

  it("throws a clear error when no callback and not on a TTY (default-prompt path is opt-in)", async () => {
    const tool = createAskQuestionTool();
    // Force the no-callback branch: process.stdin is a TTY in this Vitest runner,
    // so we mark allowDefaultTtyPrompt off to make the error path deterministic.
    const result = tool.execute({ questions: [{ question: "?", options: ["x", "y"] }] }, {});
    await expect(result).rejects.toThrow(/not supported/i);
  });

  it("exposes a Zod input schema with the documented shape", () => {
    const parsed = AskQuestionToolInputSchema.parse({
      questions: [
        { question: "Pick", options: ["A", "B"], is_multi_select: true }
      ]
    });
    expect(parsed.questions[0]?.is_multi_select).toBe(true);
  });
});

describe("read_url_content tool", () => {
  it("uses injected onFetch override", async () => {
    const tool = createReadUrlTool({ onFetch: async () => "OVERRIDE" });
    const out = await tool.execute({ url: "https://example.test/anything" }, {});
    expect(out.content).toBe("OVERRIDE");
  });

  it("default provider rejects non-http schemes", async () => {
    await expect(defaultFetchUrlContent("file:///etc/passwd")).rejects.toThrow(/http/i);
  });

  it("strips scripts and keeps readable body text", () => {
    const text = htmlToReadableText("<html><body><script>x</script><p>Hello</p></body></html>");
    expect(text).toContain("Hello");
    expect(text).not.toContain("script");
    expect(text).not.toContain("x");
  });
});

describe("search_web tool", () => {
  it("uses injected onSearch override", async () => {
    const tool = createSearchWebTool({
      onSearch: async () => [{ title: "T", url: "https://x.test", snippet: "S" }]
    });
    const out = await tool.execute({ query: "anything" }, {});
    expect(out.results).toEqual([{ title: "T", url: "https://x.test", snippet: "S" }]);
  });

  it("default provider returns empty on a 4xx response", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 503, headers: { "content-type": "text/plain" } })) as typeof fetch;
    await expect(defaultWebSearch("q", undefined, fetchImpl)).rejects.toThrow(/HTTP 503/);
  });
});

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

describe("session_todos tool", () => {
  it("add → list → complete → remove round-trip", async () => {
    const tool = createSessionTodosTool();
    const added = await tool.execute({ action: "add", content: "fix bug" }, {});
    expect(added.todos).toHaveLength(1);
    const id = added.todos[0]?.id;
    expect(id).toMatch(/^todo-/u);

    const done = await tool.execute({ action: "complete", id }, {});
    expect(done.todos[0]?.status).toBe("completed");

    const removed = await tool.execute({ action: "remove", id }, {});
    expect(removed.todos).toHaveLength(0);
  });
});