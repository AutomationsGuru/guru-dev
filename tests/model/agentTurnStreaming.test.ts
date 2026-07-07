import { describe, it, expect } from "vitest";
import { directAgentTurn } from "../../src/model/agentTurn.js";
import { defineProviderRoute } from "../../src/providers/registry.js";

const env = { TEST_CHAT_KEY: "test-secret" };

function sseResponse(lines: readonly string[]): Response {
  const body = lines.map((line) => `${line}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const chatRoute = defineProviderRoute({
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

describe("streaming: openai-chat-completions", () => {
  it("emits incremental tokens and assembles the final text", async () => {
    const tokens: string[] = [];
    let sawStreamFlag = false;
    const result = await directAgentTurn(chatRoute, [{ role: "user", content: "hi" }], {
      env,
      tools: [],
      executeTool: async () => ({ toolId: "x", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0 }),
      approveTool: () => true,
      onToken: (chunk) => tokens.push(chunk),
      fetchImpl: (async (_url: unknown, init: { body?: string; headers?: Record<string, string> }) => {
        const body = JSON.parse(init.body ?? "{}") as { stream?: boolean };
        sawStreamFlag = body.stream === true;
        expect(init.headers?.accept).toBe("text/event-stream");
        return sseResponse([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}',
          'data: {"choices":[{"delta":{"content":"lo"}}]}',
          'data: {"choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
          "data: [DONE]"
        ]);
      }) as typeof fetch
    });

    expect(sawStreamFlag).toBe(true);
    expect(tokens).toEqual(["Hel", "lo", "!"]);
    expect(result.text).toBe("Hello!");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, lastRequestInputTokens: 3 });
  });

  it("streams a tool call across deltas, runs it, then streams the final answer", async () => {
    const tokens: string[] = [];
    let call = 0;
    const result = await directAgentTurn(chatRoute, [{ role: "user", content: "branch?" }], {
      env,
      tools: [
        {
          id: "repo.context.resolve",
          title: "Repo",
          description: "d",
          inputSchema: (await import("zod")).z.object({}).passthrough(),
          outputSchema: (await import("zod")).z.object({}).passthrough(),
          execute: () => ({ gitStatus: "## main" })
        }
      ],
      executeTool: async () => ({ toolId: "repo.context.resolve", status: "succeeded", startedAt: "", endedAt: "", durationMs: 1, output: { gitStatus: "## main" } }),
      approveTool: () => true,
      onToken: (chunk) => tokens.push(chunk),
      fetchImpl: (async () => {
        call += 1;
        if (call === 1) {
          return sseResponse([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"repo__context__resolve","arguments":"{}"}}]}}]}',
            "data: [DONE]"
          ]);
        }
        return sseResponse(['data: {"choices":[{"delta":{"content":"On main."}}]}', "data: [DONE]"]);
      }) as typeof fetch
    });

    expect(result.toolCallCount).toBe(1);
    expect(tokens.join("")).toBe("On main.");
    expect(result.text).toBe("On main.");
  });

  it("falls back to non-streaming when the provider rejects the stream request", async () => {
    let calls = 0;
    const result = await directAgentTurn(chatRoute, [{ role: "user", content: "hi" }], {
      env,
      tools: [],
      executeTool: async () => ({ toolId: "x", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0 }),
      approveTool: () => true,
      onToken: () => undefined,
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ error: "streaming not supported" }), { status: 400 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "non-stream ok" } }] }), { status: 200 });
      }) as typeof fetch
    });

    expect(calls).toBe(2);
    expect(result.text).toBe("non-stream ok");
  });
});

describe("streaming: anthropic-messages", () => {
  it("assembles content_block_delta text and streams tokens", async () => {
    const tokens: string[] = [];
    const result = await directAgentTurn(anthropicRoute, [{ role: "user", content: "hi" }], {
      env,
      tools: [],
      executeTool: async () => ({ toolId: "x", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0 }),
      approveTool: () => true,
      onToken: (chunk) => tokens.push(chunk),
      fetchImpl: (async () =>
        sseResponse([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}'
        ])) as typeof fetch
    });

    expect(tokens).toEqual(["Hi ", "there"]);
    expect(result.text).toBe("Hi there");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2, lastRequestInputTokens: 5 });
  });
});

describe("streaming: network-level failure fallback", () => {
  it("falls back to non-streaming when the SSE fetch rejects (shakedown fix)", async () => {
    const tokens: string[] = [];
    let calls = 0;
    const result = await directAgentTurn(chatRoute, [{ role: "user", content: "hi" }], {
      env,
      tools: [],
      executeTool: async () => ({ toolId: "x", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0 }),
      approveTool: () => true,
      onToken: (chunk) => tokens.push(chunk),
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        calls += 1;
        const body = JSON.parse(init.body ?? "{}") as { stream?: boolean };
        if (body.stream === true) {
          throw new TypeError("fetch failed"); // socket reset / DNS blip on the stream attempt
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "recovered" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }) as typeof fetch
    });

    expect(calls).toBe(2); // failed stream attempt + successful non-streaming retry
    expect(result.text).toBe("recovered");
  });

  it("still surfaces an honest error when the non-streaming retry also fails", async () => {
    await expect(
      directAgentTurn(chatRoute, [{ role: "user", content: "hi" }], {
        env,
        tools: [],
        executeTool: async () => ({ toolId: "x", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0 }),
        approveTool: () => true,
        onToken: () => undefined,
        // The non-stream fallback now carries the retry policy — instant sleeps keep
        // this deterministic; the honest error still surfaces after the retries.
        retrySleep: () => Promise.resolve(),
        fetchImpl: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch
      })
    ).rejects.toThrow(/failed/iu);
  });
});

describe("streaming: anthropic tool_use round-trip parity (no live credential — unit proof)", () => {
  it("reconstructs streamed tool_use blocks and echoes them with a matching tool_result", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let executed: unknown = null;
    const result = await directAgentTurn(anthropicRoute, [{ role: "user", content: "fix it" }], {
      env,
      tools: [
        {
          id: "read",
          title: "Read file",
          description: "Reads a file",
          inputSchema: (await import("zod")).z.object({ path: (await import("zod")).z.string() }),
          outputSchema: (await import("zod")).z.object({ text: (await import("zod")).z.string() }),
          execute: () => ({ text: "file contents" })
        } as never
      ],
      executeTool: async (toolId, input) => {
        executed = { toolId, input };
        return {
          toolId,
          status: "succeeded",
          startedAt: "",
          endedAt: "",
          durationMs: 1,
          output: { text: "file contents" }
        } as never;
      },
      approveTool: () => true,
      onToken: () => undefined,
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        requests.push(body);
        if (requests.length === 1) {
          return sseResponse([
            'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_123","name":"read"}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a.js\\"}"}}',
            'data: {"type":"content_block_stop","index":0}',
            'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
            'data: {"type":"message_stop"}'
          ]);
        }
        return sseResponse([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":20}}}',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
          'data: {"type":"message_stop"}'
        ]);
      }) as typeof fetch
    });

    expect(executed).toMatchObject({ toolId: "read", input: { path: "a.js" } });
    expect(result.text).toBe("done");
    // Round-trip echo: request 2 must carry the assistant tool_use block verbatim-enough
    // (type/id/name/input) plus a user tool_result with the MATCHING tool_use_id.
    const second = requests[1] as { messages: Array<{ role: string; content: unknown }> };
    const assistant = second.messages.find((m) => m.role === "assistant");
    const toolResultMsg = JSON.stringify(second.messages);
    expect(JSON.stringify(assistant?.content)).toContain('"tool_use"');
    expect(JSON.stringify(assistant?.content)).toContain('"toolu_123"');
    expect(JSON.stringify(assistant?.content)).toContain('"a.js"');
    expect(toolResultMsg).toContain('"tool_result"');
    expect(toolResultMsg).toContain('"tool_use_id":"toolu_123"');
  });
});

describe("streaming: openai-responses codex backfill (Finale Wave)", () => {
  const responsesRoute = defineProviderRoute({
    providerId: "openai-codex",
    modelId: "gpt-5.5",
    routeId: "openai-codex/gpt-5.5",
    routeType: "operator-provider-plan-auth",
    apiFamily: "openai-responses",
    baseUrl: "https://example.test/codex",
    credentialSource: { type: "env-var", envVarName: "TEST_CHAT_KEY", envVarNames: [] },
    status: "active",
    directFirstRank: 1,
    allowedRouterFallback: false,
    wire: { headers: [], requireStreaming: true }
  });

  it("backfills accumulated delta text when response.completed carries an EMPTY output[] (codex shape)", async () => {
    const result = await directAgentTurn(responsesRoute, [{ role: "user", content: "reply ok" }], {
      env,
      tools: [],
      executeTool: async () => ({ toolId: "none", status: "failed", startedAt: "", endedAt: "", durationMs: 0 }),
      approveTool: () => false,
      fetchImpl: (async () =>
        sseResponse([
          'data: {"type":"response.output_text.delta","delta":"ok"}',
          'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":1,"output_tokens":1}}}'
        ])) as unknown as typeof fetch
    });
    // Without the backfill this would be "" (empty output[]); with it, the deltas win.
    expect(result.text).toBe("ok");
  });

  it("prefers the completed response's own output when it is populated (non-codex)", async () => {
    const result = await directAgentTurn(responsesRoute, [{ role: "user", content: "reply hi" }], {
      env,
      tools: [],
      executeTool: async () => ({ toolId: "none", status: "failed", startedAt: "", endedAt: "", durationMs: 0 }),
      approveTool: () => false,
      fetchImpl: (async () =>
        sseResponse([
          'data: {"type":"response.output_text.delta","delta":"partial"}',
          'data: {"type":"response.completed","response":{"output_text":"full answer","output":[]}}'
        ])) as unknown as typeof fetch
    });
    expect(result.text).toBe("full answer");
  });
});
