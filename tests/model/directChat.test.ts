import { defineProviderRoute } from "../../src/providers/registry.js";
import { directChat, DirectChatError, isChatCapableFamily, resolveRouteCredential } from "../../src/model/directChat.js";

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

const responsesRoute = defineProviderRoute({
  providerId: "sakana",
  modelId: "fugu-ultra",
  routeId: "sakana/fugu-ultra",
  routeType: "direct-api",
  apiFamily: "openai-responses",
  baseUrl: "https://example.test/v1",
  credentialSource: { type: "env-var", envVarName: "TEST_CHAT_KEY", envVarNames: [] },
  status: "ready-unverified",
  directFirstRank: 2,
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
  directFirstRank: 3,
  allowedRouterFallback: true
});

const env = { TEST_CHAT_KEY: "test-secret-value" };
const messages = [{ role: "user" as const, content: "hello" }];

describe("resolveRouteCredential", () => {
  it("is honest about missing env NAMES and never exposes values", () => {
    const missing = resolveRouteCredential(chatRoute, {});
    expect(missing.usable).toBe(false);
    expect(missing.reason).toContain("TEST_CHAT_KEY");

    const present = resolveRouteCredential(chatRoute, env);
    expect(present.usable).toBe(true);
    expect(JSON.stringify(present)).not.toContain("test-secret-value");
  });

  it("marks plan-auth/oauth credential types as not directly chat-usable", () => {
    const planRoute = defineProviderRoute({
      providerId: "openai-codex",
      modelId: "codex-plan",
      routeId: "openai-codex/codex-plan",
      routeType: "operator-provider-plan-auth",
      apiFamily: "openai-responses",
      credentialSource: { type: "native-cli-token", commandName: "codex.cmd", envVarNames: [] },
      status: "needs-login",
      directFirstRank: 1,
      allowedRouterFallback: false
    });

    const result = resolveRouteCredential(planRoute, env);
    expect(result.usable).toBe(false);
    expect(result.reason).toContain("login");
  });
});

describe("directChat", () => {
  it("speaks openai-chat-completions with bearer auth and parses the reply", async () => {
    const calls: Array<{ url: string; auth: string | undefined; body: { model?: string } }> = [];
    const result = await directChat(chatRoute, messages, {
      env,
      fetchImpl: (async (url: unknown, init: { headers?: Record<string, string>; body?: string }) => {
        calls.push({ url: String(url), auth: init.headers?.authorization, body: JSON.parse(init.body ?? "{}") });
        return new Response(JSON.stringify({ choices: [{ message: { content: "hi there" } }], usage: { prompt_tokens: 3, completion_tokens: 5 } }), { status: 200 });
      }) as typeof fetch
    });

    expect(calls[0]?.url).toBe("https://example.test/api/chat/completions");
    expect(calls[0]?.auth).toBe("Bearer test-secret-value");
    expect(calls[0]?.body.model).toBe("glm-5-turbo");
    expect(result.text).toBe("hi there");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 5 });
  });

  it("speaks openai-responses and reads output_text", async () => {
    const result = await directChat(responsesRoute, messages, {
      env,
      fetchImpl: (async (url: unknown) => {
        expect(String(url)).toBe("https://example.test/v1/responses");
        return new Response(JSON.stringify({ output_text: "responses ok", usage: { input_tokens: 2, output_tokens: 4 } }), { status: 200 });
      }) as typeof fetch
    });

    expect(result.text).toBe("responses ok");
  });

  it("speaks anthropic-messages with x-api-key and version header", async () => {
    const headers: Array<Record<string, string>> = [];
    const result = await directChat(anthropicRoute, messages, {
      env,
      fetchImpl: (async (url: unknown, init: { headers?: Record<string, string> }) => {
        headers.push(init.headers ?? {});
        expect(String(url)).toBe("https://example.test/v1/messages");
        return new Response(JSON.stringify({ content: [{ type: "text", text: "claude ok" }] }), { status: 200 });
      }) as typeof fetch
    });

    expect(headers[0]?.["x-api-key"]).toBe("test-secret-value");
    expect(headers[0]?.["anthropic-version"]).toBeDefined();
    expect(result.text).toBe("claude ok");
  });

  it("fails honestly with a missing credential and never fakes a turn", async () => {
    await expect(directChat(chatRoute, messages, { env: {} })).rejects.toThrow(/Missing env var: TEST_CHAT_KEY/u);
  });

  it("redacts secrets from HTTP error messages", async () => {
    await expect(
      directChat(chatRoute, messages, {
        env,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ error: { message: "bad key api_key=sk-leaky-secret" } }), { status: 401 })) as typeof fetch
      })
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(DirectChatError);
      expect((error as Error).message).not.toContain("sk-leaky-secret");
      return true;
    });
  });

  it("honors the caller's abort signal (review 2026-07-08)", async () => {
    // Old behavior: the one-shot directChat path built its own private
    // AbortController linked only to the timeout — an operator abort was
    // ignored and the request ran until the timeoutMs ceiling. Now a caller
    // signal fires the fetch's abort immediately.
    let fetchCalled = false;
    const controller = new AbortController();
    controller.abort(); // pre-aborted
    await expect(
      directChat(chatRoute, messages, {
        env,
        signal: controller.signal,
        timeoutMs: 30_000,
        fetchImpl: (async (_url: unknown, init: { signal?: AbortSignal }) => {
          fetchCalled = true;
          expect(init.signal?.aborted).toBe(true);
          // The fetch observes the abort and rejects.
          throw new DOMException("aborted", "AbortError");
        }) as typeof fetch
      })
    ).rejects.toThrow();
    expect(fetchCalled).toBe(true);
  });
});

describe("isChatCapableFamily", () => {
  it("accepts the four supported families and rejects others", () => {
    expect(isChatCapableFamily("openai-chat-completions")).toBe(true);
    expect(isChatCapableFamily("openai-responses")).toBe(true);
    expect(isChatCapableFamily("anthropic-messages")).toBe(true);
    expect(isChatCapableFamily("ollama-openai-compatible")).toBe(true);
    expect(isChatCapableFamily("google-gemini")).toBe(false);
    expect(isChatCapableFamily("native-cli")).toBe(false);
    expect(isChatCapableFamily(undefined)).toBe(false);
  });
});
