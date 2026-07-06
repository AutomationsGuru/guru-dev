import { directAgentTurn } from "../../src/model/agentTurn.js";
import { DirectChatError } from "../../src/model/directChat.js";
import { RetryConfigSchema, RetryDelayExceededError } from "../../src/model/retryPolicy.js";
import { defineProviderRoute } from "../../src/providers/registry.js";

/**
 * Request-level retry policy through the REAL directAgentTurn path (ADR
 * 2026-07-05): fake fetch, injected sleep + zero jitter — no real waits.
 */

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

const okResponse = () =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: "recovered fine" } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
    { status: 200 }
  );

function rig(fetchImpl: (url: unknown, init: unknown) => Promise<Response>) {
  const slept: number[] = [];
  const retries: Array<{ attempt: number; maxAttempts: number; delayMs: number; reason: string }> = [];
  const options = {
    env,
    tools: [],
    executeTool: () => Promise.reject(new Error("no tools in this test")),
    approveTool: () => false,
    fetchImpl: fetchImpl as typeof fetch,
    retrySleep: (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
    retryRandom: () => 0,
    onRetry: (info: { attempt: number; maxAttempts: number; delayMs: number; reason: string }) => {
      retries.push(info);
    }
  };
  return { slept, retries, options };
}

describe("directAgentTurn retry policy (fake fetch, injected sleep)", () => {
  it("429 twice then 200: the turn completes with exponential delays and indicator calls", async () => {
    let calls = 0;
    const { slept, retries, options } = rig(() => {
      calls += 1;
      if (calls <= 2) {
        return Promise.resolve(new Response("rate limited", { status: 429 }));
      }
      return Promise.resolve(okResponse());
    });
    const result = await directAgentTurn(route, [{ role: "user", content: "hi" }], options);
    expect(result.text).toBe("recovered fine");
    expect(calls).toBe(3);
    expect(slept).toEqual([2_000, 4_000]);
    expect(retries.map((info) => info.reason)).toEqual(["HTTP 429", "HTTP 429"]);
  });

  it("a 401 fails immediately — exactly one request, zero sleeps", async () => {
    let calls = 0;
    const { slept, options } = rig(() => {
      calls += 1;
      return Promise.resolve(new Response("unauthorized", { status: 401 }));
    });
    await expect(directAgentTurn(route, [{ role: "user", content: "hi" }], options)).rejects.toThrow(DirectChatError);
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  it("retry.enabled=false restores single-attempt behavior on a 429", async () => {
    let calls = 0;
    const { options } = rig(() => {
      calls += 1;
      return Promise.resolve(new Response("rate limited", { status: 429 }));
    });
    await expect(
      directAgentTurn(route, [{ role: "user", content: "hi" }], { ...options, retry: RetryConfigSchema.parse({ enabled: false }) })
    ).rejects.toThrow(/HTTP 429/u);
    expect(calls).toBe(1);
  });

  it("Retry-After within the cap is honored as the delay", async () => {
    let calls = 0;
    const { slept, options } = rig(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(new Response("busy", { status: 429, headers: { "retry-after": "9" } }));
      }
      return Promise.resolve(okResponse());
    });
    const result = await directAgentTurn(route, [{ role: "user", content: "hi" }], options);
    expect(result.text).toBe("recovered fine");
    expect(slept).toEqual([9_000]);
  });

  it("Retry-After beyond maxRetryDelayMs FAILS FAST naming the requested delay", async () => {
    let calls = 0;
    const { slept, options } = rig(() => {
      calls += 1;
      return Promise.resolve(new Response("quota", { status: 429, headers: { "retry-after": "18000" } }));
    });
    await expect(directAgentTurn(route, [{ role: "user", content: "hi" }], options)).rejects.toThrow(RetryDelayExceededError);
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  it("network-level fetch failures are retryable", async () => {
    let calls = 0;
    const { slept, options } = rig(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error("socket reset"));
      }
      return Promise.resolve(okResponse());
    });
    const result = await directAgentTurn(route, [{ role: "user", content: "hi" }], options);
    expect(result.text).toBe("recovered fine");
    expect(calls).toBe(2);
    expect(slept).toEqual([2_000]);
  });

  it("the max_completion_tokens adaptive flip still works (400 fails fast into the flip, no retry burn)", async () => {
    let calls = 0;
    const bodies: string[] = [];
    const { slept, options } = rig((_url, init) => {
      calls += 1;
      bodies.push((init as { body?: string }).body ?? "");
      if (calls === 1) {
        return Promise.resolve(new Response(JSON.stringify({ error: { message: "use max_completion_tokens instead" } }), { status: 400 }));
      }
      return Promise.resolve(okResponse());
    });
    const result = await directAgentTurn(route, [{ role: "user", content: "hi" }], options);
    expect(result.text).toBe("recovered fine");
    expect(calls).toBe(2);
    expect(slept).toEqual([]); // adaptive flip, not policy retry — no backoff
    expect(bodies[0]).toContain("max_tokens");
    expect(bodies[1]).toContain("max_completion_tokens");
  });
});
