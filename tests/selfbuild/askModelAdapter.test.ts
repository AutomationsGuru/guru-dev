import { describe, expect, it } from "vitest";

import { makeAskModelFromRoute } from "../../src/selfbuild/askModelAdapter.js";
import { defineProviderRoute } from "../../src/providers/registry.js";

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

describe("makeAskModelFromRoute (P7) — a live askModel for critics", () => {
  it("returns the assistant text for a single-turn prompt, offering NO tools", async () => {
    let sawTools: unknown = "unset";
    const askModel = makeAskModelFromRoute(route, {
      env,
      fetchImpl: (async (_url: unknown, init: { body?: string }) => {
        const body = JSON.parse(init.body ?? "{}") as { tools?: unknown[] };
        sawTools = body.tools;
        return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }), { status: 200 });
      }) as typeof fetch
    });

    const text = await askModel("Review this diff for security issues.", { persona: "security", phase: "find" });
    expect(text).toBe("[]");
    // Critics are read-only by construction — the turn offers no tools.
    expect(sawTools === undefined || (Array.isArray(sawTools) && sawTools.length === 0)).toBe(true);
  });
});
