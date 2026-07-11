import { describe, it, expect } from "vitest";
import { directAgentTurn } from "../../src/model/agentTurn.js";
import { RetryConfigSchema } from "../../src/model/retryPolicy.js";
import { defineProviderRoute } from "../../src/providers/registry.js";

const env = { TEST_CHAT_KEY: "test-secret" };

function sseResponse(lines: readonly string[]): Response {
  const body = lines.map((line) => `${line}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunkedSseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

function sseResponseThenFailure(contentBeforeFailure: string): Response {
  const encoder = new TextEncoder();
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(encoder.encode(contentBeforeFailure));
            return;
          }
          controller.error(new TypeError("socket reset mid-stream"));
        }
      },
      { highWaterMark: 0 }
    ),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
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

const responsesRoute = defineProviderRoute({
  providerId: "openai",
  modelId: "gpt-test",
  routeId: "openai/gpt-test-responses",
  routeType: "direct-api",
  apiFamily: "openai-responses",
  baseUrl: "https://example.test/api",
  credentialSource: { type: "env-var", envVarName: "TEST_CHAT_KEY", envVarNames: [] },
  status: "ready-unverified",
  directFirstRank: 3,
  allowedRouterFallback: true
});

describe("streaming: openai-chat-completions", () => {
  it("parses CRLF event boundaries split across transport chunks", async () => {
    const result = await directAgentTurn(chatRoute, [{ role: "user", content: "hi" }], {
      env,
      tools: [],
      executeTool: async () => ({ toolId: "x", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0 }),
      approveTool: () => true,
      onToken: () => undefined,
      fetchImpl: (async () =>
        chunkedSseResponse([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\r',
          "\n\r",
          '\ndata: {"choices":[{"delta":{"content":"lo"}}]}\r\n\r',
          "\ndata: [DONE]\r\n\r\n"
        ])) as typeof fetch
    });

    expect(result.text).toBe("Hello");
  });

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

  it("surfaces a streaming 400 as a real error instead of silently doubling the request (review 2026-07-08)", async () => {
    // Old behavior: ANY non-OK on the streaming request returned null → the caller
    // re-sent the identical request non-streaming. A 400/401/404 is a genuine
    // request error (bad model, bad URL, bad key); doubling it wasted a call and
    // reported the SECOND attempt's error. Now it surfaces the first immediately.
    let calls = 0;
    await expect(
      directAgentTurn(chatRoute, [{ role: "user", content: "hi" }], {
        env,
        tools: [],
        executeTool: async () => ({ toolId: "x", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0 }),
        approveTool: () => true,
        onToken: () => undefined,
        fetchImpl: (async () => {
          calls += 1;
          return new Response(JSON.stringify({ error: "bad request" }), { status: 400 });
        }) as typeof fetch
      })
    ).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1); // NOT 2 — the request was not re-sent
  });

  it.each([
    ["HTTP 429", () => new Response("busy", { status: 429 })],
    ["HTTP 503", () => new Response("unavailable", { status: 503 })],
    ["a network failure", () => Promise.reject(new TypeError("socket reset"))]
  ])("retries a streaming open after %s", async (_label, firstAttempt) => {
    let calls = 0;
    const streamFlags: boolean[] = [];
    const sleeps: number[] = [];
    const result = await directAgentTurn(chatRoute, [{ role: "user", content: "hi" }], {
      env,
      tools: [],
      executeTool: async () => ({ toolId: "x", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0 }),
      approveTool: () => true,
      onToken: () => undefined,
      retrySleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      retryRandom: () => 0,
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        calls += 1;
        streamFlags.push((JSON.parse(init.body ?? "{}") as { stream?: boolean }).stream === true);
        if (calls === 1) {
          return firstAttempt();
        }
        return sseResponse(['data: {"choices":[{"delta":{"content":"recovered"}}]}', "data: [DONE]"]);
      }) as typeof fetch
    });

    expect(result.text).toBe("recovered");
    expect(calls).toBe(2);
    expect(streamFlags).toEqual([true, true]);
    expect(sleeps).toHaveLength(1);
  });

  it("falls back to non-streaming only on streaming-unsupported statuses (415/405/501)", async () => {
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
          return new Response(JSON.stringify({ error: "streaming not supported" }), { status: 415 });
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

describe("streaming: partial response retention", () => {
  it.each([
    {
      family: "openai-chat-completions",
      route: chatRoute,
      sse: 'data: {"choices":[{"delta":{"content":"visible partial"}}]}\n\n'
    },
    {
      family: "openai-responses",
      route: responsesRoute,
      sse: 'data: {"type":"response.output_text.delta","delta":"visible partial"}\n\n'
    },
    {
      family: "anthropic-messages",
      route: anthropicRoute,
      sse:
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"visible partial"}}\n\n'
    }
  ])("returns accumulated $family text after a body read failure", async ({ route, sse }) => {
    const tokens: string[] = [];
    const result = await directAgentTurn(route, [{ role: "user", content: "hi" }], {
      env,
      tools: [],
      executeTool: async () => ({ toolId: "x", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0 }),
      approveTool: () => true,
      onToken: (token) => tokens.push(token),
      fetchImpl: (async () => sseResponseThenFailure(sse)) as typeof fetch
    });

    expect(tokens.join("")).toBe("visible partial");
    expect(result.text).toBe("visible partial");
  });

  it("discards an unfinished OpenAI tool call instead of executing it with empty arguments", async () => {
    let requests = 0;
    let executions = 0;
    const result = await directAgentTurn(chatRoute, [{ role: "user", content: "inspect" }], {
      env,
      tools: [
        {
          id: "repo.context.resolve",
          title: "Repo",
          description: "Resolve repository context",
          inputSchema: (await import("zod")).z.object({ cwd: (await import("zod")).z.string() }),
          outputSchema: (await import("zod")).z.object({}).passthrough(),
          execute: () => ({})
        }
      ],
      executeTool: async () => {
        executions += 1;
        return { toolId: "repo.context.resolve", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0 };
      },
      approveTool: () => true,
      onToken: () => undefined,
      fetchImpl: (async () => {
        requests += 1;
        if (requests === 1) {
          return sseResponseThenFailure(
            'data: {"choices":[{"delta":{"content":"visible partial"}}]}\n\n' +
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"repo__context__resolve","arguments":"{\\"cwd\\":"}}]}}]}\n\n'
          );
        }
        return sseResponse(['data: {"choices":[{"delta":{"content":"unexpected retry"}}]}', "data: [DONE]"]);
      }) as typeof fetch
    });

    expect(result.text).toBe("visible partial");
    expect(result.toolCallCount).toBe(0);
    expect(executions).toBe(0);
    expect(requests).toBe(1);
  });

  it("discards tool calls when a stream closes cleanly without a completion marker", async () => {
    let executions = 0;
    const result = await directAgentTurn(chatRoute, [{ role: "user", content: "inspect" }], {
      env,
      tools: [
        {
          id: "repo.context.resolve",
          title: "Repo",
          description: "Resolve repository context",
          inputSchema: (await import("zod")).z.object({}).passthrough(),
          outputSchema: (await import("zod")).z.object({}).passthrough(),
          execute: () => ({})
        }
      ],
      executeTool: async () => {
        executions += 1;
        return { toolId: "repo.context.resolve", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0 };
      },
      approveTool: () => true,
      onToken: () => undefined,
      fetchImpl: (async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"visible partial","tool_calls":[{"index":0,"id":"c1","function":{"name":"repo__context__resolve","arguments":"{}"}}]}}]}'
        ])) as typeof fetch
    });

    expect(result.text).toBe("visible partial");
    expect(result.toolCallCount).toBe(0);
    expect(executions).toBe(0);
  });

  it("does not execute a streamed tool call after Ctrl+C aborts the turn", async () => {
    const controller = new AbortController();
    let approvals = 0;
    let executions = 0;
    const result = await directAgentTurn(chatRoute, [{ role: "user", content: "inspect" }], {
      env,
      signal: controller.signal,
      tools: [
        {
          id: "repo.context.resolve",
          title: "Repo",
          description: "Resolve repository context",
          inputSchema: (await import("zod")).z.object({}).passthrough(),
          outputSchema: (await import("zod")).z.object({}).passthrough(),
          execute: () => ({})
        }
      ],
      executeTool: async () => {
        executions += 1;
        return { toolId: "repo.context.resolve", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0 };
      },
      approveTool: () => {
        approvals += 1;
        return true;
      },
      onToken: () => controller.abort(),
      fetchImpl: (async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"visible partial","tool_calls":[{"index":0,"id":"c1","function":{"name":"repo__context__resolve","arguments":"{}"}}]}}]}',
          "data: [DONE]"
        ])) as typeof fetch
    });

    expect(result.text).toBe("visible partial");
    expect(result.toolCallCount).toBe(0);
    expect(approvals).toBe(0);
    expect(executions).toBe(0);
  });

  it("rechecks abort after an asynchronous approval before executing a tool", async () => {
    const controller = new AbortController();
    let executions = 0;
    const result = await directAgentTurn(chatRoute, [{ role: "user", content: "inspect" }], {
      env,
      signal: controller.signal,
      tools: [
        {
          id: "repo.context.resolve",
          title: "Repo",
          description: "Resolve repository context",
          inputSchema: (await import("zod")).z.object({}).passthrough(),
          outputSchema: (await import("zod")).z.object({}).passthrough(),
          execute: () => ({})
        }
      ],
      executeTool: async () => {
        executions += 1;
        return { toolId: "repo.context.resolve", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0 };
      },
      approveTool: async () => {
        controller.abort();
        return true;
      },
      onToken: () => undefined,
      fetchImpl: (async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"repo__context__resolve","arguments":"{}"}}]}}]}',
          "data: [DONE]"
        ])) as typeof fetch
    });

    expect(result.text).toBe("");
    expect(result.toolCallCount).toBe(0);
    expect(executions).toBe(0);
  });

  it("discards an unfinished Anthropic tool_use block after retaining partial text", async () => {
    let requests = 0;
    let executions = 0;
    const result = await directAgentTurn(anthropicRoute, [{ role: "user", content: "inspect" }], {
      env,
      tools: [
        {
          id: "repo.context.resolve",
          title: "Repo",
          description: "Resolve repository context",
          inputSchema: (await import("zod")).z.object({ cwd: (await import("zod")).z.string() }),
          outputSchema: (await import("zod")).z.object({}).passthrough(),
          execute: () => ({})
        }
      ],
      executeTool: async () => {
        executions += 1;
        return { toolId: "repo.context.resolve", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0 };
      },
      approveTool: () => true,
      onToken: () => undefined,
      fetchImpl: (async () => {
        requests += 1;
        if (requests === 1) {
          return sseResponseThenFailure(
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"visible partial"}}\n\n' +
              'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"c1","name":"repo__context__resolve"}}\n\n' +
              'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"cwd\\":"}}\n\n'
          );
        }
        return sseResponse([
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"unexpected retry"}}'
        ]);
      }) as typeof fetch
    });

    expect(result.text).toBe("visible partial");
    expect(result.toolCallCount).toBe(0);
    expect(executions).toBe(0);
    expect(requests).toBe(1);
  });
});

describe("streaming: exhausted network failures", () => {
  it("does not re-send the request non-streaming after the streaming retry budget is exhausted", async () => {
    let calls = 0;
    const streamFlags: boolean[] = [];
    await expect(
      directAgentTurn(chatRoute, [{ role: "user", content: "hi" }], {
        env,
        tools: [],
        executeTool: async () => ({ toolId: "x", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0 }),
        approveTool: () => true,
        onToken: () => undefined,
        retrySleep: () => Promise.resolve(),
        fetchImpl: (async (_url: unknown, init: { body?: string }) => {
          calls += 1;
          streamFlags.push((JSON.parse(init.body ?? "{}") as { stream?: boolean }).stream === true);
          throw new TypeError("fetch failed"); // socket reset / DNS blip on the stream attempt
        }) as typeof fetch
      })
    ).rejects.toThrow(/failed/iu);

    expect(calls).toBe(4); // initial attempt + the default policy's three retries
    expect(streamFlags).toEqual([true, true, true, true]);
  });

  it("still surfaces an honest error when every streaming attempt fails", async () => {
    await expect(
      directAgentTurn(chatRoute, [{ role: "user", content: "hi" }], {
        env,
        tools: [],
        executeTool: async () => ({ toolId: "x", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0 }),
        approveTool: () => true,
        onToken: () => undefined,
        // Instant sleeps keep this deterministic; the honest error still surfaces
        // after the streaming retry policy is exhausted.
        retrySleep: () => Promise.resolve(),
        fetchImpl: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch
      })
    ).rejects.toThrow(/failed/iu);
  });
});

describe("streaming: per-request timeout is terminal, not retried (review 2026-07-08)", () => {
  it("surfaces a timeout immediately instead of retrying into the same hang", async () => {
    // Old behavior: the timeout AbortController fires a SEPARATE signal, so
    // context.signal (the operator signal) was NOT aborted. The catch fell to the
    // network-failure branch → retried 3× → a blackholed route hung for minutes.
    // Now an abort-style error with no operator abort is a terminal timeout.
    let calls = 0;
    await expect(
      directAgentTurn(chatRoute, [{ role: "user", content: "hi" }], {
        env,
        tools: [],
        executeTool: async () => ({ toolId: "x", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0 }),
        approveTool: () => true,
        onToken: () => undefined,
        retrySleep: () => Promise.resolve(),
        fetchImpl: (async () => {
          calls += 1;
          // The timeout AbortController aborts the fetch — the fetch rejects with
          // a DOMException named "AbortError". No operator signal is involved.
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          throw err;
        }) as typeof fetch
      })
    ).rejects.toThrow(/timed out/iu);
    expect(calls).toBe(1); // NOT retried
  });
});

describe("streaming: body idle timeout", () => {
  it("fails promptly when an SSE body stops producing data after headers", async () => {
    let calls = 0;
    const controller = new AbortController();
    const turn = directAgentTurn(chatRoute, [{ role: "user", content: "hi" }], {
      env,
      tools: [],
      executeTool: async () => ({ toolId: "x", status: "succeeded", startedAt: "", endedAt: "", durationMs: 0 }),
      approveTool: () => true,
      onToken: () => undefined,
      signal: controller.signal,
      retry: RetryConfigSchema.parse({ maxRetries: 0, provider: { timeoutMs: 20 } }),
      fetchImpl: (async () => {
        calls += 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => undefined)
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }) as typeof fetch
    });

    const outcome = await Promise.race([
      turn.then(
        () => new Error("turn unexpectedly resolved"),
        (error: unknown) => error
      ),
      new Promise<Error>((resolve) => setTimeout(() => resolve(new Error("stream remained pending")), 100))
    ]);
    controller.abort();

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/stream.*idle.*20ms/iu);
    expect(calls).toBe(1);
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
