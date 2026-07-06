import { z } from "zod";

import { buildToolDeclarations, directAgentTurn, toApiToolName } from "../../src/model/agentTurn.js";
import { defineProviderRoute } from "../../src/providers/registry.js";
import type { ToolDefinition, ToolObservation } from "../../src/tools/registry.js";

const route = defineProviderRoute({
  providerId: "zai",
  modelId: "glm-5-turbo",
  routeId: "zai/glm-5-turbo",
  routeType: "direct-api",
  apiFamily: "openai-chat-completions",
  baseUrl: "https://example.test/api",
  credentialSource: { type: "env-var", envVarName: "TEST_CHAT_KEY", envVarNames: [] },
  status: "ready-unverified",
  directFirstRank: 1,
  allowedRouterFallback: true
});

const env = { TEST_CHAT_KEY: "test-secret" };

const repoTool: ToolDefinition = {
  id: "repo.context.resolve",
  title: "Resolve repository context",
  description: "Resolve git root and status.",
  inputSchema: z.object({ cwd: z.string().optional() }),
  outputSchema: z.object({ gitStatus: z.string() }),
  execute: () => ({ gitStatus: "## main...origin/main [ahead 7]" })
};

const editTool: ToolDefinition = {
  id: "fs.edit.apply",
  title: "Apply file edit",
  description: "Mutating edit.",
  inputSchema: z.object({ path: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: () => ({ ok: true })
};

function observation(toolId: string, output: unknown): ToolObservation {
  const now = new Date().toISOString();
  return { toolId, status: "succeeded", startedAt: now, endedAt: now, durationMs: 5, output };
}

describe("toApiToolName / buildToolDeclarations", () => {
  it("maps dotted tool ids to API-safe names and JSON-schema parameters", () => {
    expect(toApiToolName("repo.context.resolve")).toBe("repo__context__resolve");
    const declarations = buildToolDeclarations([repoTool]);
    expect(declarations[0]).toMatchObject({ apiName: "repo__context__resolve", toolId: "repo.context.resolve" });
    expect(declarations[0]?.parameters).toMatchObject({ type: "object" });
  });
});

describe("directAgentTurn (openai-chat-completions)", () => {
  it("round-trips a tool call and answers from the result", async () => {
    const executed: string[] = [];
    let call = 0;
    const result = await directAgentTurn(route, [{ role: "user", content: "branch?" }], {
      env,
      tools: [repoTool],
      executeTool: async (toolId, input) => {
        executed.push(toolId);
        expect(input).toEqual({ cwd: "." });
        return observation(toolId, { gitStatus: "## main [ahead 7]" });
      },
      approveTool: () => true,
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        call += 1;
        const body = JSON.parse(init.body ?? "{}") as { messages: unknown[]; tools?: unknown[] };
        if (call === 1) {
          expect(body.tools?.length).toBe(1);
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [{ id: "c1", function: { name: "repo__context__resolve", arguments: JSON.stringify({ cwd: "." }) } }]
                  }
                }
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5 }
            }),
            { status: 200 }
          );
        }
        // Second call must include the tool result in the conversation.
        const serialized = JSON.stringify(body.messages);
        expect(serialized).toContain("ahead 7");
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "On branch main, ahead by 7." } }], usage: { prompt_tokens: 20, completion_tokens: 8 } }),
          { status: 200 }
        );
      }) as typeof fetch
    });

    expect(executed).toEqual(["repo.context.resolve"]);
    expect(result.text).toContain("ahead by 7");
    expect(result.toolCallCount).toBe(1);
    // inputTokens is the cumulative SUM across the tool loop (10 + 20);
    // lastRequestInputTokens is the FINAL request's prompt size — the true
    // context footprint that compaction triggers on.
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 13, lastRequestInputTokens: 20 });
  });

  it("blocks non-approved (mutating) tools and tells the model", async () => {
    const executed: string[] = [];
    let call = 0;
    const result = await directAgentTurn(route, [{ role: "user", content: "edit a file" }], {
      env,
      tools: [repoTool, editTool],
      executeTool: async (toolId) => {
        executed.push(toolId);
        return observation(toolId, { ok: true });
      },
      approveTool: (toolId) => toolId === "repo.context.resolve",
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        call += 1;
        if (call === 1) {
          return new Response(
            JSON.stringify({
              choices: [
                { message: { content: null, tool_calls: [{ id: "c1", function: { name: "fs__edit__apply", arguments: JSON.stringify({ path: "x" }) } }] } }
              ]
            }),
            { status: 200 }
          );
        }
        const serialized = JSON.stringify((JSON.parse(init.body ?? "{}") as { messages: unknown[] }).messages);
        expect(serialized).toContain("blocked by the harness approval policy");
        return new Response(JSON.stringify({ choices: [{ message: { content: "The edit was blocked by policy." } }] }), { status: 200 });
      }) as typeof fetch
    });

    expect(executed).toEqual([]);
    expect(result.toolEvents[0]).toMatchObject({ toolId: "fs.edit.apply", status: "blocked" });
    expect(result.text).toContain("blocked");
  });

  it("caps the tool-call budget so a looping model cannot spin forever", async () => {
    let apiCalls = 0;
    const result = await directAgentTurn(route, [{ role: "user", content: "loop" }], {
      env,
      tools: [repoTool],
      maxToolCalls: 2,
      executeTool: async (toolId) => observation(toolId, { gitStatus: "ok" }),
      approveTool: () => true,
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        apiCalls += 1;
        const serialized = init.body ?? "";
        if (serialized.includes("Tool-call budget exhausted")) {
          return new Response(JSON.stringify({ choices: [{ message: { content: "Stopping: budget exhausted." } }] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: null, tool_calls: [{ id: `c${apiCalls}`, function: { name: "repo__context__resolve", arguments: "{}" } }] } }
            ]
          }),
          { status: 200 }
        );
      }) as typeof fetch
    });

    expect(result.text).toContain("budget exhausted");
    expect(result.toolCallCount).toBeLessThanOrEqual(2);
  });
});

describe("directAgentTurn — abort + mid-run steering (§17 scenario 13)", () => {
  it("a pre-aborted signal stops the loop before any request (returns partial, no fetch)", async () => {
    let apiCalls = 0;
    const result = await directAgentTurn(route, [{ role: "user", content: "go" }], {
      env,
      tools: [repoTool],
      signal: AbortSignal.abort(),
      executeTool: async (toolId) => observation(toolId, { gitStatus: "ok" }),
      approveTool: () => true,
      fetchImpl: (async () => {
        apiCalls += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: "should not run" } }] }), { status: 200 });
      }) as typeof fetch
    });
    expect(apiCalls).toBe(0); // aborted at the first checkpoint, before the model call
    expect(result.text).toBe("");
  });

  it("aborting AFTER the first tool round stops the loop and returns the partial text", async () => {
    const controller = new AbortController();
    let apiCalls = 0;
    const result = await directAgentTurn(route, [{ role: "user", content: "go" }], {
      env,
      tools: [repoTool],
      signal: controller.signal,
      executeTool: async (toolId) => observation(toolId, { gitStatus: "ok" }),
      approveTool: () => true,
      fetchImpl: (async () => {
        apiCalls += 1;
        // First response: a bit of reasoning text + a tool call; then the operator aborts.
        controller.abort();
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "working on it", tool_calls: [{ id: "c1", function: { name: "repo__context__resolve", arguments: "{}" } }] } }]
          }),
          { status: 200 }
        );
      }) as typeof fetch
    });
    expect(apiCalls).toBe(1); // stopped at iteration 1's checkpoint, no second model call
    expect(result.text).toBe("working on it"); // the partial assistant text is returned
  });

  it("mid-run steering injects the operator's note into the next request", async () => {
    let apiCalls = 0;
    let steered = false;
    const result = await directAgentTurn(route, [{ role: "user", content: "go" }], {
      env,
      tools: [repoTool],
      pullSteering: () => {
        if (!steered) {
          steered = true;
          return ["prioritize the failing test"];
        }
        return [];
      },
      executeTool: async (toolId) => observation(toolId, { gitStatus: "ok" }),
      approveTool: () => true,
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        apiCalls += 1;
        const body = JSON.parse(init.body ?? "{}") as { messages: unknown[] };
        if (apiCalls === 1) {
          return new Response(
            JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "repo__context__resolve", arguments: "{}" } }] } }] }),
            { status: 200 }
          );
        }
        // The second request must carry the mid-run steer.
        expect(JSON.stringify(body.messages)).toContain("[steering] prioritize the failing test");
        return new Response(JSON.stringify({ choices: [{ message: { content: "done, prioritized" } }] }), { status: 200 });
      }) as typeof fetch
    });
    expect(apiCalls).toBe(2);
    expect(result.text).toContain("prioritized");
  });
});

describe("directAgentTurn (anthropic-messages)", () => {
  const anthropicRoute = defineProviderRoute({
    providerId: "anthropic",
    modelId: "claude-sonnet-4-6",
    routeId: "anthropic/claude-sonnet-4-6",
    routeType: "direct-api",
    apiFamily: "anthropic-messages",
    baseUrl: "https://example.test",
    credentialSource: { type: "env-var", envVarName: "TEST_CHAT_KEY", envVarNames: [] },
    status: "ready-unverified",
    directFirstRank: 2,
    allowedRouterFallback: true
  });

  it("round-trips tool_use blocks", async () => {
    let call = 0;
    const result = await directAgentTurn(anthropicRoute, [{ role: "user", content: "branch?" }], {
      env,
      tools: [repoTool],
      executeTool: async (toolId) => observation(toolId, { gitStatus: "## main" }),
      approveTool: () => true,
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        call += 1;
        if (call === 1) {
          const body = JSON.parse(init.body ?? "{}") as { tools?: Array<{ name?: string }> };
          expect(body.tools?.[0]?.name).toBe("repo__context__resolve");
          return new Response(
            JSON.stringify({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "repo__context__resolve", input: {} }] }),
            { status: 200 }
          );
        }
        const serialized = init.body ?? "";
        expect(serialized).toContain("tool_result");
        return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "main branch." }] }), { status: 200 });
      }) as typeof fetch
    });

    expect(result.text).toBe("main branch.");
    expect(result.toolCallCount).toBe(1);
  });
});

describe("iteration hard cap (probe-harness discovery)", () => {
  it("throws honestly when a model never stops requesting tools", async () => {
    const { defineProviderRoute } = await import("../../src/providers/registry.js");
    const relentless = defineProviderRoute({
      providerId: "loop",
      modelId: "loop-model",
      routeId: "loop/loop-model",
      routeType: "direct-api",
      apiFamily: "openai-chat-completions",
      baseUrl: "https://loop.test/v1",
      credentialSource: { type: "env-var", envVarName: "LOOP_KEY", envVarNames: [] },
      status: "ready-unverified",
      directFirstRank: 1,
      allowedRouterFallback: false
    });
    const { directAgentTurn } = await import("../../src/model/agentTurn.js");
    const { z } = await import("zod");
    await expect(
      directAgentTurn(relentless, [{ role: "user", content: "go" }], {
        env: { LOOP_KEY: "k" },
        tools: [
          {
            id: "spin",
            title: "Spin",
            description: "spin",
            inputSchema: z.object({}),
            outputSchema: z.object({}),
            execute: () => ({})
          } as never
        ],
        executeTool: async () => ({ toolId: "spin", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0, output: {} }),
        approveTool: () => true,
        maxToolCalls: 3,
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "x", type: "function", function: { name: "spin", arguments: "{}" } }] } }] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )) as typeof fetch
      })
    ).rejects.toThrow(/iteration cap/u);
  });
});
