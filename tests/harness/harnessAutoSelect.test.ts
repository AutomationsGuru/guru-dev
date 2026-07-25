import { describe, it, expect } from "vitest";

import { inferHarness } from '../../src/harness/harnessAutoSelect.js';

describe("inferHarness", () => {
  it("returns explicit non-empty profile as-is over any provider/model", () => {
    expect(
      inferHarness({
        providerId: "anthropic",
        modelId: "claude-sonnet-4",
        explicit: "minimal"
      })
    ).toBe("minimal");

    expect(
      inferHarness({
        providerId: "moonshot",
        modelId: "kimi-k2",
        explicit: "  custom-profile  "
      })
    ).toBe("custom-profile");
  });

  it("does not treat empty / whitespace-only / null / undefined explicit as a win", () => {
    expect(
      inferHarness({
        providerId: "anthropic",
        modelId: "claude-3",
        explicit: ""
      })
    ).toBe("claude-shaped");

    expect(
      inferHarness({
        providerId: "anthropic",
        modelId: "claude-3",
        explicit: "   "
      })
    ).toBe("claude-shaped");

    expect(
      inferHarness({
        providerId: "anthropic",
        modelId: "claude-3",
        explicit: null
      })
    ).toBe("claude-shaped");

    expect(
      inferHarness({
        providerId: "anthropic",
        modelId: "claude-3"
      })
    ).toBe("claude-shaped");
  });

  it("maps moonshot / kimi family to kimi-shaped", () => {
    expect(
      inferHarness({
        providerId: "moonshot",
        modelId: "kimi-k2"
      })
    ).toBe("kimi-shaped");

    expect(
      inferHarness({
        providerId: "openai-compat",
        modelId: "kimi-k2-instruct"
      })
    ).toBe("kimi-shaped");

    expect(
      inferHarness({
        providerId: "Moonshot",
        modelId: "other"
      })
    ).toBe("kimi-shaped");
  });

  it("maps anthropic / claude family to claude-shaped", () => {
    expect(
      inferHarness({
        providerId: "anthropic",
        modelId: "claude-sonnet-4"
      })
    ).toBe("claude-shaped");

    expect(
      inferHarness({
        providerId: "openrouter",
        modelId: "anthropic/claude-3.5-sonnet"
      })
    ).toBe("claude-shaped");

    expect(
      inferHarness({
        providerId: "proxy",
        modelId: "Claude-Opus-4"
      })
    ).toBe("claude-shaped");
  });

  it("maps qwen provider or model to qwen-shaped", () => {
    expect(
      inferHarness({
        providerId: "qwen",
        modelId: "qwen2.5-72b"
      })
    ).toBe("qwen-shaped");

    expect(
      inferHarness({
        providerId: "dashscope",
        modelId: "Qwen/Qwen2.5-Coder"
      })
    ).toBe("qwen-shaped");
  });

  it("falls back to native for unknown provider/model", () => {
    expect(
      inferHarness({
        providerId: "openai",
        modelId: "gpt-4o"
      })
    ).toBe("native");

    expect(
      inferHarness({
        providerId: "google",
        modelId: "gemini-2.0-flash"
      })
    ).toBe("native");
  });

  it("does not invent a profile from baseUrl alone without family tokens", () => {
    expect(
      inferHarness({
        providerId: "custom",
        modelId: "local-model",
        baseUrl: "https://api.anthropic.com/v1"
      })
    ).toBe("native");

    expect(
      inferHarness({
        providerId: "custom",
        modelId: "local-model",
        baseUrl: "https://api.moonshot.cn/v1"
      })
    ).toBe("native");
  });
});
