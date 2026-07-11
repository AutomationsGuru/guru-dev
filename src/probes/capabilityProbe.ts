import { z } from "zod";

import type { ProviderRouteDescriptor } from "../providers/schemas.js";
import { resolveRouteCredential, isChatCapableFamily } from "../model/directChat.js";
import { directAgentTurn, adjustProviderBase } from "../model/agentTurn.js";
import { resolveProviderWire } from "../model/providerWire.js";
import { RetryConfigSchema, type RetryConfig } from "../model/retryPolicy.js";

/**
 * Probes disable the turn-loop retry policy: they own a single rate-limit-
 * friendly retry (1.5s, network-failure only) and must stay CHEAP against dead
 * or tier-gated lanes — the default policy would nest with it (2026-07-05).
 */
const PROBE_RETRY_CONFIG: RetryConfig = RetryConfigSchema.parse({ enabled: false });

/**
 * Capability probe — empirically verifies, PER ROUTE and THROUGH the harness's own
 * machinery, what the model sheet only claims: chat, tools, vision, thinking.
 *
 * Honesty rules: every verdict carries raw evidence (status code, tool args, token
 * counts); "accepted but no evidence" stays `unclear` — it is never rounded up to a
 * pass. Missing credentials → `skipped` with the env NAME (values never read).
 * Probes are token-capped (max 64 output tokens; thinking probe budget-capped).
 */

export const ProbeVerdictSchema = z.enum(["pass", "fail", "rejected", "ignored", "unclear", "skipped", "n/a"]);
export type ProbeVerdict = z.infer<typeof ProbeVerdictSchema>;

export const ProbeResultSchema = z.object({
  verdict: ProbeVerdictSchema,
  evidence: z.string(),
  durationMs: z.number().int().nonnegative().optional()
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export const RouteProbeReportSchema = z.object({
  routeId: z.string(),
  providerId: z.string(),
  modelId: z.string(),
  apiFamily: z.string(),
  probedAt: z.string(),
  chat: ProbeResultSchema,
  tools: ProbeResultSchema,
  vision: ProbeResultSchema,
  thinking: ProbeResultSchema
});
export type RouteProbeReport = z.infer<typeof RouteProbeReportSchema>;

/** 32×32 solid-red PNG (97 bytes) — deterministic vision probe image. */
export const PROBE_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";

const PROBE_TIMEOUT_MS = 60_000;
const MAX_PROBE_TOKENS = 64;

export interface ProbeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

interface RouteWire {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly family: string;
  readonly modelId: string;
  readonly bodyExtras: Record<string, unknown>;
}

function resolveWire(route: ProviderRouteDescriptor, env: NodeJS.ProcessEnv): RouteWire | { skip: string } {
  const credential = resolveRouteCredential(route, env);
  if (!credential.usable) {
    return { skip: credential.reason };
  }
  const rawBase = route.baseUrl?.startsWith("os.environ/") ? env[route.baseUrl.replace("os.environ/", "")] : route.baseUrl;
  if (!rawBase) {
    return { skip: "no usable baseUrl" };
  }
  const secret = credential.value ?? (credential.envName ? env[credential.envName] : undefined);
  const family = route.apiFamily ?? "openai-chat-completions";
  const wire = resolveProviderWire(route, env);
  const headers: Record<string, string> = { "content-type": "application/json", ...wire.extraHeaders };
  if (family === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
  }
  if (secret) {
    if (wire.headerStyle === "api-key") {
      headers["api-key"] = secret;
    } else if (wire.headerStyle === "x-api-key") {
      headers["x-api-key"] = secret;
    } else {
      headers.authorization = `Bearer ${secret}`;
    }
  }

  return { baseUrl: adjustProviderBase(route.providerId, rawBase.replace(/\/+$/u, "")), headers, family, modelId: route.modelId, bodyExtras: route.wire?.bodyExtras ?? {} };
}

async function postProbe(
  wire: RouteWire,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  retried = false
): Promise<{ status: number; json: unknown } | { transportError: string }> {
  const path = wire.family === "anthropic-messages" ? "/v1/messages" : wire.family === "openai-responses" ? "/responses" : "/chat/completions";
  try {
    const response = await fetchImpl(`${wire.baseUrl}${path}`, {
      method: "POST",
      headers: wire.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    const text = await response.text();
    let json: unknown = {};
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: response.status, json };
  } catch (error) {
    if (!retried) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return postProbe(wire, body, fetchImpl, true);
    }
    return { transportError: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160) };
  }
}

function extractText(family: string, json: unknown): string {
  const data = json as Record<string, any>;
  if (family === "anthropic-messages") {
    return (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text ?? "").join(" ");
  }
  if (family === "openai-responses") {
    if (typeof data.output_text === "string") return data.output_text;
    return (data.output ?? [])
      .flatMap((item: any) => item.content ?? [])
      .filter((b: any) => b.type === "output_text" || b.type === "text")
      .map((b: any) => b.text ?? "")
      .join(" ");
  }
  return data.choices?.[0]?.message?.content ?? "";
}

/** Chat probe rides directAgentTurn — a pass means "works from the harness loop". */
async function probeChat(route: ProviderRouteDescriptor, options: ProbeOptions, retrying = false): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    const result = await directAgentTurn(route, [{ role: "user", content: "Reply with exactly: ok" }], {
      ...(options.env ? { env: options.env } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      tools: [],
      executeTool: async () => ({ toolId: "none", status: "failed", startedAt: "", endedAt: "", durationMs: 0 }),
      approveTool: () => false,
      // Thinking-mode models can consume a small budget before emitting text.
      maxTokens: 256,
      // Probes own their single rate-limit-friendly retry below — the default
      // policy would NEST with it (8 requests, ~30s of real sleeps per dead lane).
      retry: PROBE_RETRY_CONFIG
    });
    const text = result.text.trim().toLowerCase();
    return text.includes("ok")
      ? { verdict: "pass", evidence: `replied ${JSON.stringify(result.text.trim().slice(0, 40))}`, durationMs: Date.now() - startedAt }
      : { verdict: "unclear", evidence: `unexpected reply ${JSON.stringify(result.text.trim().slice(0, 60))}`, durationMs: Date.now() - startedAt };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 160);
    if (/fetch failed|abort|timeout|econnrefused|enotfound/iu.test(message) && !retrying) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return probeChat(route, options, true);
    }
    // A persistent transport failure after retry is NOT a capability verdict
    // (review 2026-07-08): the model may be fully capable; the network was just down.
    return { verdict: "unclear", evidence: `transport error after retry: ${message}`, durationMs: Date.now() - startedAt };
  }
}

/** Tools probe: one trivial declaration; success = the model actually calls it. */
async function probeTools(route: ProviderRouteDescriptor, options: ProbeOptions, retrying = false): Promise<ProbeResult> {
  const startedAt = Date.now();
  let calledWith: unknown = null;
  const echoTool = {
    id: "probe_echo",
    title: "Echo probe",
    description: "Echoes the provided value back. Call this exactly once.",
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ echoed: z.string() }),
    execute: (input: { value: string }) => ({ echoed: input.value })
  };
  try {
    const result = await directAgentTurn(route, [{ role: "user", content: "Call the probe_echo tool with value \"hello\", then say done." }], {
      ...(options.env ? { env: options.env } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      tools: [echoTool as never],
      executeTool: async (_toolId, input) => {
        calledWith = input;
        return {
          toolId: "probe_echo",
          status: "succeeded",
          startedAt: "",
          endedAt: "",
          durationMs: 0,
          output: { echoed: (input as { value?: string }).value ?? "" }
        };
      },
      approveTool: () => true,
      maxToolCalls: 2,
      maxTokens: 128,
      retry: PROBE_RETRY_CONFIG
    });
    if (calledWith !== null) {
      const value = (calledWith as { value?: string }).value;
      return value === "hello"
        ? { verdict: "pass", evidence: `called probe_echo({value:"hello"})`, durationMs: Date.now() - startedAt }
        : { verdict: "pass", evidence: `called probe_echo with ${JSON.stringify(calledWith).slice(0, 60)}`, durationMs: Date.now() - startedAt };
    }
    return { verdict: "ignored", evidence: `no tool call; replied ${JSON.stringify(result.text.trim().slice(0, 50))}`, durationMs: Date.now() - startedAt };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 160);
    if (/fetch failed/iu.test(message) && !retrying) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return probeTools(route, options, true);
    }
    const rejected = /tool|function/iu.test(message) && /not supported|invalid|400/iu.test(message);
    return { verdict: rejected ? "rejected" : "fail", evidence: message, durationMs: Date.now() - startedAt };
  }
}

function visionBody(wire: RouteWire): Record<string, unknown> {
  const question = "One word: what color is this image?";
  const dataUri = `data:image/png;base64,${PROBE_IMAGE_BASE64}`;
  if (wire.family === "anthropic-messages") {
    return {
      model: wire.modelId,
      max_tokens: MAX_PROBE_TOKENS,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: PROBE_IMAGE_BASE64 } },
            { type: "text", text: question }
          ]
        }
      ]
    };
  }
  if (wire.family === "openai-responses") {
    return {
      model: wire.modelId,
      max_output_tokens: MAX_PROBE_TOKENS,
      ...wire.bodyExtras,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: question },
            { type: "input_image", image_url: dataUri }
          ]
        }
      ]
    };
  }
  return {
    model: wire.modelId,
    max_tokens: MAX_PROBE_TOKENS,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: question },
          { type: "image_url", image_url: { url: dataUri } }
        ]
      }
    ]
  };
}

/** Swap max_tokens → max_completion_tokens (OpenAI-family quirk) and retry once. */
async function postAdaptive(
  wire: RouteWire,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch
): Promise<Awaited<ReturnType<typeof postProbe>>> {
  const first = await postProbe(wire, body, fetchImpl);
  if (
    "status" in first &&
    first.status === 400 &&
    /max_completion_tokens/u.test(JSON.stringify(first.json)) &&
    body.max_tokens !== undefined
  ) {
    const { max_tokens: maxTokens, ...rest } = body;
    return postProbe(wire, { ...rest, max_completion_tokens: maxTokens }, fetchImpl);
  }
  return first;
}

async function probeVision(wire: RouteWire, fetchImpl: typeof fetch): Promise<ProbeResult> {
  const startedAt = Date.now();
  const outcome = await postAdaptive(wire, visionBody(wire), fetchImpl);
  if ("transportError" in outcome) {
    // A transport failure (timeout/DNS/network) is NOT a capability verdict — the
    // model may well support vision (review 2026-07-08). 'unclear' keeps the
    // lane eligible instead of permanently disabling vision for a transient blip.
    return { verdict: "unclear", evidence: `transport error: ${outcome.transportError}`, durationMs: Date.now() - startedAt };
  }
  if (outcome.status === 401 || outcome.status === 403) {
    // Auth failure isn't a capability verdict either — an expired/revoked key
    // shouldn't mark a model as vision-incapable.
    return { verdict: "unclear", evidence: `HTTP ${outcome.status} (auth — not a capability verdict)`, durationMs: Date.now() - startedAt };
  }
  if (outcome.status >= 400) {
    const body = JSON.stringify(outcome.json).slice(0, 160);
    return { verdict: "rejected", evidence: `HTTP ${outcome.status}: ${body}`, durationMs: Date.now() - startedAt };
  }
  const text = extractText(wire.family, outcome.json).trim().toLowerCase();
  if (text.includes("red")) {
    return { verdict: "pass", evidence: `answered ${JSON.stringify(text.slice(0, 30))}`, durationMs: Date.now() - startedAt };
  }
  return { verdict: text.length === 0 ? "unclear" : "fail", evidence: `answered ${JSON.stringify(text.slice(0, 60))}`, durationMs: Date.now() - startedAt };
}

function thinkingBody(wire: RouteWire): Record<string, unknown> {
  const prompt = "What is 17 * 23? Reply with just the number.";
  if (wire.family === "anthropic-messages") {
    return {
      model: wire.modelId,
      max_tokens: 2048,
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [{ role: "user", content: prompt }]
    };
  }
  if (wire.family === "openai-responses") {
    return {
      model: wire.modelId,
      max_output_tokens: 2048,
      reasoning: { effort: "low" },
      ...wire.bodyExtras,
      input: [{ role: "user", content: prompt }]
    };
  }
  return {
    model: wire.modelId,
    max_tokens: 2048,
    reasoning_effort: "low",
    messages: [{ role: "user", content: prompt }]
  };
}

function thinkingEvidence(family: string, json: unknown): string | null {
  const data = json as Record<string, any>;
  if (family === "anthropic-messages") {
    const block = (data.content ?? []).find((b: any) => b.type === "thinking" || b.type === "redacted_thinking");
    return block ? "thinking block present" : null;
  }
  if (family === "openai-responses") {
    const item = (data.output ?? []).find((i: any) => i.type === "reasoning");
    const tokens = data.usage?.output_tokens_details?.reasoning_tokens ?? 0;
    if (item) return "reasoning item present";
    if (tokens > 0) return `reasoning_tokens=${tokens}`;
    return null;
  }
  const tokens = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const content = data.choices?.[0]?.message?.reasoning_content;
  if (tokens > 0) return `reasoning_tokens=${tokens}`;
  if (typeof content === "string" && content.length > 0) return "reasoning_content present";
  return null;
}

async function probeThinking(wire: RouteWire, fetchImpl: typeof fetch): Promise<ProbeResult> {
  const startedAt = Date.now();
  let outcome = await postAdaptive(wire, thinkingBody(wire), fetchImpl);
  // Newer Claude models replace {type:"enabled",budget_tokens} with {type:"adaptive"}
  // — the 400 says so explicitly; adapt and retry once.
  let adaptiveConfirmed = false;
  if (
    "status" in outcome &&
    outcome.status === 400 &&
    /thinking\.type\.adaptive|"adaptive"/u.test(JSON.stringify(outcome.json))
  ) {
    // The 400 itself is API-issued evidence: this model's thinking mode is
    // "adaptive" (it decides when to think — trivial prompts may emit no blocks).
    adaptiveConfirmed = true;
    outcome = await postAdaptive(wire, { ...thinkingBody(wire), thinking: { type: "adaptive" } }, fetchImpl);
  }
  if ("transportError" in outcome) {
    // Transport failure ≠ capability verdict (review 2026-07-08) — see probeVision.
    return { verdict: "unclear", evidence: `transport error: ${outcome.transportError}`, durationMs: Date.now() - startedAt };
  }
  if (outcome.status === 401 || outcome.status === 403) {
    return { verdict: "unclear", evidence: `HTTP ${outcome.status} (auth — not a capability verdict)`, durationMs: Date.now() - startedAt };
  }
  if (outcome.status >= 400) {
    const body = JSON.stringify(outcome.json).slice(0, 160);
    return { verdict: "rejected", evidence: `HTTP ${outcome.status}: ${body}`, durationMs: Date.now() - startedAt };
  }
  const evidence = thinkingEvidence(wire.family, outcome.json);
  if (evidence !== null) {
    return { verdict: "pass", evidence, durationMs: Date.now() - startedAt };
  }
  if (adaptiveConfirmed) {
    return { verdict: "pass", evidence: "adaptive thinking — model-specific mode confirmed by the API's own 400 guidance", durationMs: Date.now() - startedAt };
  }
  return { verdict: "unclear", evidence: "request accepted but no reasoning evidence in response", durationMs: Date.now() - startedAt };
}

export async function probeRoute(route: ProviderRouteDescriptor, options: ProbeOptions = {}): Promise<RouteProbeReport> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const base = {
    routeId: route.routeId,
    providerId: route.providerId,
    modelId: route.modelId,
    apiFamily: route.apiFamily ?? "unknown",
    probedAt: new Date().toISOString()
  };
  const skipAll = (evidence: string, verdict: ProbeVerdict = "skipped"): RouteProbeReport => ({
    ...base,
    chat: { verdict, evidence },
    tools: { verdict, evidence },
    vision: { verdict, evidence },
    thinking: { verdict, evidence }
  });

  // Probe any lane that exposes a real HTTP endpoint (baseUrl) + a probe-capable
  // family — this now includes the operator-plan lanes that have been given real
  // direct wiring (Phase B: zai-coding-cn, grok, codex-direct). A lane with no
  // baseUrl is a pure CLI delegate and stays n/a.
  if (!route.baseUrl) {
    return skipAll(`route type ${route.routeType} has no direct endpoint — probes run only on HTTP lanes`, "n/a");
  }
  if (!isChatCapableFamily(route.apiFamily)) {
    return skipAll(`API family ${route.apiFamily ?? "unknown"} not probe-capable`, "n/a");
  }
  const wire = resolveWire(route, env);
  if ("skip" in wire) {
    return skipAll(wire.skip);
  }

  // Sequential per route (rate-limit friendly); routes themselves run in a pool.
  const chat = await probeChat(route, options);
  const tools = await probeTools(route, options);
  const vision = await probeVision(wire, fetchImpl);
  const thinking = await probeThinking(wire, fetchImpl);

  return { ...base, chat, tools, vision, thinking };
}

export async function probeCatalog(
  routes: readonly ProviderRouteDescriptor[],
  options: ProbeOptions & { concurrency?: number; onProgress?: (report: RouteProbeReport) => void } = {}
): Promise<readonly RouteProbeReport[]> {
  const queue = [...routes];
  const reports: RouteProbeReport[] = [];
  const workers = Array.from({ length: Math.max(1, options.concurrency ?? 2) }, async () => {
    for (;;) {
      const route = queue.shift();
      if (!route) return;
      const report = await probeRoute(route, options);
      reports.push(report);
      options.onProgress?.(report);
    }
  });
  await Promise.all(workers);

  return [...reports].sort((left, right) => left.routeId.localeCompare(right.routeId));
}

const VERDICT_GLYPH: Readonly<Record<ProbeVerdict, string>> = {
  pass: "✅",
  fail: "❌",
  rejected: "🚫",
  ignored: "⚠️",
  unclear: "❓",
  skipped: "⛔",
  "n/a": "—"
};

export function renderProbeMarkdown(reports: readonly RouteProbeReport[]): string {
  const lines = [
    "# Model capability matrix (probed)",
    "",
    `Probed: ${reports[0]?.probedAt ?? "n/a"} · ${reports.length} route(s) · verdicts carry raw evidence in model-capabilities.json`,
    "",
    "Legend: ✅ pass · ❌ fail · 🚫 API rejected · ⚠️ ignored tools · ❓ unclear (never rounded up) · ⛔ skipped (no credential) · — n/a",
    "",
    "| route | chat | tools | vision | thinking |",
    "| --- | --- | --- | --- | --- |"
  ];
  for (const report of reports) {
    lines.push(
      `| ${report.routeId} | ${VERDICT_GLYPH[report.chat.verdict]} | ${VERDICT_GLYPH[report.tools.verdict]} | ${VERDICT_GLYPH[report.vision.verdict]} | ${VERDICT_GLYPH[report.thinking.verdict]} |`
    );
  }
  return `${lines.join("\n")}\n`;
}
