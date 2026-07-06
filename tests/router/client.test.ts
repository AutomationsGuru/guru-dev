import { describe, expect, it } from "vitest";

import { RouterClientError, callRouterAnthropicMessages, callRouterOpenAiChat, callRouterOpenAiResponses } from "../../src/router/client.js";

describe("router clients", () => {
  it("should call OpenAI chat completions through the LiteLLM router", async () => {
    const calls: Array<{ url: string; body: unknown; authorization?: string }> = [];
    const result = await callRouterOpenAiChat(
      { model: "router-openai-api", messages: [{ role: "user", content: "hi" }] },
      {
        apiKey: "secret-router-key",
        fetchImpl: (async (url, init) => {
          const authorization = (init?.headers as Record<string, string>).authorization;
          calls.push({ url: String(url), body: JSON.parse(String(init?.body)), ...(authorization ? { authorization } : {}) });
          return new Response(JSON.stringify({ id: "chatcmpl-test" }), { status: 200 });
        }) as typeof fetch
      }
    );

    expect(calls[0]).toMatchObject({ url: "http://127.0.0.1:4000/v1/chat/completions", body: { model: "router-openai-api" }, authorization: "Bearer secret-router-key" });
    expect(result.body).toEqual({ id: "chatcmpl-test" });
  });

  it("should call OpenAI Responses and Anthropic Messages endpoints", async () => {
    const paths: string[] = [];
    const fetchImpl = (async (url) => {
      paths.push(String(url));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await callRouterOpenAiResponses({ model: "router-openai-api", input: "hello" }, { fetchImpl });
    await callRouterAnthropicMessages({ model: "router-claude-api", messages: [], max_tokens: 32 }, { fetchImpl });

    expect(paths).toEqual(["http://127.0.0.1:4000/v1/responses", "http://127.0.0.1:4000/v1/messages"]);
  });

  it("should redact Authorization/API key values from thrown errors", async () => {
    await expect(
      callRouterOpenAiChat(
        { model: "router-openai-api", messages: [] },
        {
          apiKey: "sk-secret-value",
          fetchImpl: (async () => new Response(JSON.stringify({ error: "authorization=Bearer sk-secret-value api_key=sk-other-secret" }), { status: 401 })) as typeof fetch
        }
      )
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(RouterClientError);
      expect(JSON.stringify(error)).not.toContain("sk-secret-value");
      expect(JSON.stringify((error as RouterClientError).details.body)).not.toContain("sk-other-secret");
      return true;
    });
  });

  it("should preserve response body structure while redacting only sensitive fields", async () => {
    await expect(
      callRouterOpenAiChat(
        { model: "router-openai-api", messages: [] },
        {
          fetchImpl: (async () =>
            new Response(
              JSON.stringify({ error: { message: "bad request", api_key: "sk-leak", nested: { token: "sk-leak2", ok: "keep-me" } } }),
              { status: 400 }
            )) as typeof fetch
        }
      )
    ).rejects.toSatisfy((error: unknown) => {
      const body = (error as RouterClientError).details.body as { error?: { message?: string; api_key?: string; nested?: { token?: string; ok?: string } } };
      expect(body.error?.message).toBe("bad request");
      expect(body.error?.api_key).toBe("[redacted]");
      expect(body.error?.nested?.token).toBe("[redacted]");
      expect(body.error?.nested?.ok).toBe("keep-me");
      expect(JSON.stringify(body)).not.toContain("sk-leak");
      return true;
    });
  });
});
