import { defineProviderRoute } from "../../src/providers/registry.js";
import { probeRoute, renderProbeMarkdown, PROBE_IMAGE_BASE64 } from "../../src/probes/capabilityProbe.js";

const env = { PROBE_KEY: "test-secret" };

function route(overrides: Record<string, unknown> = {}) {
  return defineProviderRoute({
    providerId: "probe",
    modelId: "probe-model",
    routeId: "probe/probe-model",
    routeType: "direct-api",
    apiFamily: "openai-chat-completions",
    baseUrl: "https://probe.test/v1",
    credentialSource: { type: "env-var", envVarName: "PROBE_KEY", envVarNames: [] },
    status: "ready-unverified",
    directFirstRank: 1,
    allowedRouterFallback: false,
    ...overrides
  } as never);
}

const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** Fake provider: answers chat, calls tools, sees red, emits reasoning tokens. */
const fullCapabilityFetch = (async (_url: unknown, init: { body?: string }) => {
  const body = JSON.parse(init.body ?? "{}") as Record<string, any>;
  const messages = body.messages ?? [];
  const last = messages.at(-1);
  if (Array.isArray(body.tools) && body.tools.length > 0 && last?.role !== "tool") {
    return ok({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "probe_echo", arguments: '{"value":"hello"}' } }] } }] });
  }
  const content = JSON.stringify(messages);
  if (content.includes("image_url")) {
    return ok({ choices: [{ message: { content: "Red" } }] });
  }
  if (body.reasoning_effort !== undefined) {
    return ok({ choices: [{ message: { content: "391" } }], usage: { completion_tokens_details: { reasoning_tokens: 42 } } });
  }
  return ok({ choices: [{ message: { content: "ok" } }] });
}) as typeof fetch;

describe("capability probe classifier", () => {
  it("full-capability provider passes all four probes with evidence", async () => {
    const report = await probeRoute(route(), { env, fetchImpl: fullCapabilityFetch });
    expect(report.chat.verdict).toBe("pass");
    expect(report.tools).toMatchObject({ verdict: "pass", evidence: expect.stringContaining("hello") });
    expect(report.vision).toMatchObject({ verdict: "pass", evidence: expect.stringContaining("red") });
    expect(report.thinking).toMatchObject({ verdict: "pass", evidence: "reasoning_tokens=42" });
  });

  it("tool-deaf model → ignored; vision 400 → rejected; no reasoning evidence → unclear (never rounded up)", async () => {
    const fetchImpl = (async (_url: unknown, init: { body?: string }) => {
      const body = JSON.parse(init.body ?? "{}") as Record<string, any>;
      if (JSON.stringify(body.messages ?? []).includes("image_url")) {
        return new Response(JSON.stringify({ error: "images not supported" }), { status: 400 });
      }
      return ok({ choices: [{ message: { content: "I cannot call tools, the answer is done. ok" } }] });
    }) as typeof fetch;
    const report = await probeRoute(route(), { env, fetchImpl });
    expect(report.tools.verdict).toBe("ignored");
    expect(report.vision).toMatchObject({ verdict: "rejected", evidence: expect.stringContaining("400") });
    expect(report.thinking.verdict).toBe("unclear");
  });

  it("missing credential skips everything with the env NAME never a value", async () => {
    const report = await probeRoute(route(), { env: {}, fetchImpl: fullCapabilityFetch });
    expect(report.chat.verdict).toBe("skipped");
    expect(JSON.stringify(report)).not.toContain("test-secret");
  });

  it("non-direct routes are n/a", async () => {
    const planRoute = route({ routeType: "operator-provider-plan-auth", credentialSource: { type: "native-cli-token", commandName: "x", envVarNames: [] }, baseUrl: undefined });
    const report = await probeRoute(planRoute, { env, fetchImpl: fullCapabilityFetch });
    expect(report.chat.verdict).toBe("n/a");
  });

  it("anthropic family: thinking blocks and image source shape", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: unknown, init: { body?: string }) => {
      seen.push(String(url));
      const body = JSON.parse(init.body ?? "{}") as Record<string, any>;
      if (body.thinking) {
        return ok({ content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "391" }] });
      }
      const content = JSON.stringify(body.messages ?? []);
      if (content.includes(PROBE_IMAGE_BASE64.slice(0, 20))) {
        expect(content).toContain('"media_type":"image/png"');
        return ok({ content: [{ type: "text", text: "red" }] });
      }
      if (Array.isArray(body.tools) && body.tools.length > 0 && !content.includes("tool_result")) {
        return ok({ content: [{ type: "tool_use", id: "t1", name: "probe_echo", input: { value: "hello" } }], stop_reason: "tool_use" });
      }
      return ok({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
    }) as typeof fetch;
    const report = await probeRoute(route({ apiFamily: "anthropic-messages", baseUrl: "https://anthropic.test" }), { env, fetchImpl });
    expect(report.chat.verdict).toBe("pass");
    expect(report.vision.verdict).toBe("pass");
    expect(report.thinking).toMatchObject({ verdict: "pass", evidence: "thinking block present" });
    expect(seen.some((url) => url.includes("/v1/messages"))).toBe(true);
  });

  it("markdown matrix renders one row per route with glyph verdicts", async () => {
    const report = await probeRoute(route(), { env, fetchImpl: fullCapabilityFetch });
    const markdown = renderProbeMarkdown([report]);
    expect(markdown).toContain("| probe/probe-model | ✅ | ✅ | ✅ | ✅ |");
    expect(markdown).toContain("never rounded up");
  });
});
