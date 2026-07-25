import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { AgentTurnResult } from '../../src/model/agentTurn.js';
import { ProviderRouteDescriptorSchema } from '../../src/providers/schemas.js';
import { clearRegisteredSecretValues } from '../../src/safety/secretSafety.js';
import type { AgentSession, AgentSessionStats } from '../../src/session/agentSession.js';
import {
  PrintReceiptSchema,
  runPrintMode,
  type PrintReceipt
} from '../../src/surfaces/printReceipt.js';

const route = ProviderRouteDescriptorSchema.parse({
  providerId: "stub",
  routeId: "stub/model",
  modelId: "stub-model",
  routeType: "direct-api",
  apiFamily: "openai-chat-completions",
  status: "active",
  directFirstRank: 0,
  allowedRouterFallback: false,
  capabilities: { supportsTools: true },
  context: { contextWindowTokens: 128_000 }
});

const stats: AgentSessionStats = {
  turns: 1,
  inputTokens: 12,
  outputTokens: 7,
  lastInputTokens: 12,
  contextWindowTokens: 128_000,
  historyLength: 2
};

function fakeSession(
  promptDrainingFollowUps: (prompt: string) => Promise<AgentTurnResult>
): AgentSession {
  return {
    activeRoute: route,
    promptDrainingFollowUps,
    stats: () => stats
  } as unknown as AgentSession;
}

async function captureReceipt(session: AgentSession): Promise<{ readonly raw: string; readonly receipt: PrintReceipt }> {
  const output = new PassThrough();
  let raw = "";
  output.on("data", (chunk) => {
    raw += String(chunk);
  });

  await runPrintMode({ prompt: "explain it", session, output });
  const lines = raw.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe("");
  return { raw, receipt: PrintReceiptSchema.parse(JSON.parse(lines[0] as string)) };
}

describe("runPrintMode", () => {
  it("emits exactly one validated success receipt with route, tool-call, and usage fields", async () => {
    const seenPrompts: string[] = [];
    const session = fakeSession(async (prompt) => {
      seenPrompts.push(prompt);
      return {
        text: "finished",
        modelId: route.modelId,
        routeId: route.routeId,
        apiFamily: route.apiFamily ?? "openai-chat-completions",
        usage: { inputTokens: 12, outputTokens: 7, lastRequestInputTokens: 12 },
        toolCallCount: 2,
        toolEvents: []
      };
    });

    const { raw, receipt } = await captureReceipt(session);

    expect(raw.endsWith("\n")).toBe(true);
    expect(seenPrompts).toEqual(["explain it"]);
    expect(receipt).toEqual({
      ok: true,
      route: {
        routeId: "stub/model",
        modelId: "stub-model",
        apiFamily: "openai-chat-completions"
      },
      text: "finished",
      toolCalls: 2,
      usage: {
        turns: 1,
        inputTokens: 12,
        outputTokens: 7,
        contextWindowTokens: 128_000
      },
      sanitizedPatterns: []
    });
  });

  it("scrubs assistant secrets and reports deduplicated pattern names only", async () => {
    clearRegisteredSecretValues();
    const secret = "sk-abcdefghijklmnop1234ZZ";
    const session = fakeSession(async () => ({
      text: `first ${secret}; repeated ${secret}`,
      modelId: route.modelId,
      routeId: route.routeId,
      apiFamily: route.apiFamily ?? "openai-chat-completions",
      toolCallCount: 0,
      toolEvents: []
    }));

    const { raw, receipt } = await captureReceipt(session);

    expect(receipt.ok).toBe(true);
    expect(receipt.text).toContain("[redacted:secret-shape]");
    expect(receipt.text).not.toContain(secret);
    expect(receipt.sanitizedPatterns).toEqual(["openai-key"]);
    expect(raw).not.toContain(secret);
  });

  it("emits a validated failure receipt with a scrubbed error and zeroed result fields", async () => {
    clearRegisteredSecretValues();
    const secret = "sk-abcdefghijklmnop1234ZZ";
    const session = fakeSession(async () => {
      throw new Error(`provider rejected ${secret}`);
    });

    const { raw, receipt } = await captureReceipt(session);

    expect(receipt).toMatchObject({
      ok: false,
      route: {
        routeId: "stub/model",
        modelId: "stub-model",
        apiFamily: "openai-chat-completions"
      },
      text: "",
      toolCalls: 0,
      usage: {
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        contextWindowTokens: 0
      },
      sanitizedPatterns: ["openai-key"]
    });
    expect(receipt.ok).toBe(false);
    if (receipt.ok) {
      throw new Error("Expected a failure receipt.");
    }
    expect(receipt.error).toBeTruthy();
    expect(receipt.error).toContain("[redacted:secret-shape]");
    expect(raw).not.toContain(secret);
    expect(() => PrintReceiptSchema.parse(receipt)).not.toThrow();
  });
});
