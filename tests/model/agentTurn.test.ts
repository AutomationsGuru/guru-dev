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

  it("falls back to the earlier turn's text when the terminal turn is empty (review 2026-07-08)", async () => {
    // Common pattern: the model says "Let me check" + tool_use on turn 1, runs
    // the tool, then ends on turn 2 with empty text. Old code returned "" from
    // the terminal turn and the user saw a blank reply.
    let call = 0;
    const result = await directAgentTurn(route, [{ role: "user", content: "branch?" }], {
      env,
      tools: [repoTool],
      executeTool: async (toolId) => observation(toolId, { gitStatus: "## main [ahead 7]" }),
      approveTool: () => true,
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        call += 1;
        if (call === 1) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: "Let me check the branch.",
                    tool_calls: [{ id: "c1", function: { name: "repo__context__resolve", arguments: JSON.stringify({ cwd: "." }) } }]
                  }
                }
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5 }
            }),
            { status: 200 }
          );
        }
        // Terminal turn: empty content, no tool calls.
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "" } }], usage: { prompt_tokens: 20, completion_tokens: 2 } }),
          { status: 200 }
        );
      }) as typeof fetch
    });

    expect(result.toolCallCount).toBe(1);
    expect(result.text).toBe("Let me check the branch."); // NOT "" — falls back to turn-1 text
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

  it("normalizes array-shaped assistant content (Bedrock/GLM) so the next turn doesn't 400 (review 2026-07-08)", async () => {
    // Some OpenAI-compatible providers return message.content as an array of
    // {type:"text",text:...} blocks. Pushing that array back into the conversation
    // made the provider reject the next turn ("content must be a string"). The
    // loop now normalizes array content to a string at the boundary.
    let call = 0;
    let secondRequestBody = "";
    const result = await directAgentTurn(route, [{ role: "user", content: "branch?" }], {
      env,
      tools: [repoTool],
      executeTool: async (toolId) => observation(toolId, { gitStatus: "## main" }),
      approveTool: () => true,
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        call += 1;
        if (call === 2) {
          secondRequestBody = init.body ?? "";
        }
        if (call === 1) {
          // Tool-bearing turn with ARRAY content (the Bedrock mantle shape).
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: [{ type: "text", text: "Let me check." }],
                    tool_calls: [{ id: "c1", function: { name: "repo__context__resolve", arguments: JSON.stringify({ cwd: "." }) } }]
                  }
                }
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5 }
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "On main." } }], usage: { prompt_tokens: 20, completion_tokens: 3 } }),
          { status: 200 }
        );
      }) as typeof fetch
    });

    expect(result.toolCallCount).toBe(1);
    expect(result.text).toBe("On main.");
    // The assistant message echoed into the second request must carry content as a
    // STRING ("Let me check."), not the raw array — that's what was crashing the turn.
    expect(secondRequestBody).toContain('"Let me check."');
    expect(secondRequestBody).not.toContain('"type":"text"');
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


  it("no-tool turn still continues when a mid-run steer arrives (plain chat steer)", async () => {
    let apiCalls = 0;
    let steered = false;
    const result = await directAgentTurn(route, [{ role: "user", content: "explain this" }], {
      env,
      tools: [],
      pullSteering: () => {
        if (!steered) {
          steered = true;
          return ["keep it under 3 bullets"];
        }
        return [];
      },
      executeTool: async (toolId) => observation(toolId, {}),
      approveTool: () => true,
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        apiCalls += 1;
        const body = JSON.parse(init.body ?? "{}") as { messages: unknown[] };
        if (apiCalls === 1) {
          return new Response(JSON.stringify({ choices: [{ message: { content: "a long essay..." } }] }), { status: 200 });
        }
        expect(JSON.stringify(body.messages)).toContain("[steering] keep it under 3 bullets");
        return new Response(JSON.stringify({ choices: [{ message: { content: "- one\n- two\n- three" } }] }), { status: 200 });
      }) as typeof fetch
    });
    expect(apiCalls).toBe(2);
    expect(result.text).toContain("one");
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

describe("unknown-tool calls (hallucinated names)", () => {
  it("records a blocked event and does not consume the budget for a call that never executed", async () => {
    let call = 0;
    const executed: string[] = [];
    const bodies: string[] = [];
    const result = await directAgentTurn(route, [{ role: "user", content: "go" }], {
      env,
      tools: [repoTool],
      maxToolCalls: 1,
      executeTool: async (toolId) => {
        executed.push(toolId);
        return observation(toolId, { gitStatus: "## main" });
      },
      approveTool: () => true,
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        call += 1;
        bodies.push(init.body ?? "");
        if (call === 1) {
          // Hallucinated name FIRST, real tool second, budget of ONE: if the
          // unknown call consumed budget (the old stale-last-event bug), the
          // real call could not execute.
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      { id: "c1", function: { name: "no__such__tool", arguments: "{}" } },
                      { id: "c2", function: { name: "repo__context__resolve", arguments: "{}" } }
                    ]
                  }
                }
              ]
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200 });
      }) as typeof fetch
    });

    // The real tool executed despite the hallucinated call ahead of it.
    expect(executed).toEqual(["repo.context.resolve"]);
    // The model was told, and the second request carries the error verbatim.
    expect(bodies[1]).toContain("Unknown tool: no__such__tool");
    // The hallucinated call is VISIBLE in the trace as blocked, under its raw api name.
    expect(result.toolEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ toolId: "no__such__tool", status: "blocked" })])
    );
    expect(result.text).toBe("done");
    expect(result.toolCallCount).toBe(1); // only the real execution counted
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

  it("falls back to the tool-turn's text when the terminal turn is empty (review 2026-07-08)", async () => {
    // Claude often emits the real answer as text alongside the tool_use
    // ("Let me read it" + tool_use), then ends on a later turn with no text.
    // Old code returned "" on that empty terminal turn.
    let call = 0;
    const result = await directAgentTurn(anthropicRoute, [{ role: "user", content: "branch?" }], {
      env,
      tools: [repoTool],
      executeTool: async (toolId) => observation(toolId, { gitStatus: "## main" }),
      approveTool: () => true,
      fetchImpl: (async () => {
        call += 1;
        if (call === 1) {
          return new Response(
            JSON.stringify({
              stop_reason: "tool_use",
              content: [
                { type: "text", text: "Let me check the branch for you." },
                { type: "tool_use", id: "t1", name: "repo__context__resolve", input: {} }
              ]
            }),
            { status: 200 }
          );
        }
        // Terminal turn: empty text, end_turn.
        return new Response(JSON.stringify({ stop_reason: "end_turn", content: [] }), { status: 200 });
      }) as typeof fetch
    });

    expect(result.toolCallCount).toBe(1);
    expect(result.text).toBe("Let me check the branch for you."); // NOT ""
  });

  it("does NOT drain steers on a terminal turn with dangling tool_use blocks (no silent drop)", async () => {
    // stop_reason "max_tokens" with a tool_use block: injection is impossible
    // (anthropic alternation) — pullSteering must not be called, because the
    // drain emits steer.injected and the notes would be silently dropped.
    // They stay queued for the engine's next boundary drain instead.
    let drains = 0;
    const result = await directAgentTurn(anthropicRoute, [{ role: "user", content: "go" }], {
      env,
      tools: [repoTool],
      executeTool: async (toolId) => observation(toolId, { gitStatus: "## main" }),
      approveTool: () => true,
      pullSteering: () => {
        drains += 1;
        return ["late note"];
      },
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            stop_reason: "max_tokens",
            content: [
              { type: "text", text: "partial answer" },
              { type: "tool_use", id: "t1", name: "repo__context__resolve", input: {} }
            ]
          }),
          { status: 200 }
        )) as typeof fetch
    });

    expect(drains).toBe(0);
    expect(result.text).toBe("partial answer");
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

describe("tool trace dry-run visibility", () => {
  it("surfaces DRY RUN detail and [dry-run] input preview for bash dry runs", async () => {
    const events: import("../../src/model/agentTurn.js").AgentToolEvent[] = [];
    const bashTool: ToolDefinition = {
      id: "bash",
      title: "Bash",
      description: "Run shell",
      inputSchema: z.object({ command: z.union([z.string(), z.array(z.string())]), dryRun: z.boolean().optional() }),
      outputSchema: z.object({ executed: z.boolean(), dryRun: z.boolean() }),
      execute: () => ({ executed: false, dryRun: true, command: ["npm", "test"], truncated: false, cancelled: false, blockers: [], summary: "Dry run only" })
    };

    let call = 0;
    await directAgentTurn(route, [{ role: "user", content: "run tests" }], {
      env,
      tools: [bashTool],
      executeTool: async (toolId, input) => {
        expect(input).toMatchObject({ dryRun: true });
        return observation(toolId, { executed: false, dryRun: true, command: ["npm", "test"], summary: "Dry run only" });
      },
      approveTool: () => true,
      onToolEvent: (event) => events.push(event),
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        call += 1;
        if (call === 1) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [{ id: "b1", function: { name: "bash", arguments: JSON.stringify({ command: ["npm", "test"], dryRun: true }) } }]
                  }
                }
              ],
              usage: { prompt_tokens: 5, completion_tokens: 3 }
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), { status: 200 });
      }) as typeof fetch
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatch(/DRY RUN/iu);
    expect(events[0]?.inputPreview).toMatch(/\[dry-run\]/u);
  });
});
