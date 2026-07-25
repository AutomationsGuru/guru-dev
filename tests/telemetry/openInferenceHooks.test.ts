import { describe, expect, it, vi } from "vitest";

import {
  createOpenInferenceHooks,
  withSpan,
  type SpanEnd,
  type SpanStart
} from '../../src/telemetry/openInferenceHooks.js';

describe("OpenInference span hooks — default-off contract", () => {
  it("executes the callback directly without recorder work by default", async () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const callback = vi.fn(async () => "result");

    await expect(
      withSpan("turn", callback, {
        recorder: { onStart, onEnd }
      })
    ).resolves.toBe("result");

    expect(callback).toHaveBeenCalledOnce();
    expect(onStart).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("does not turn a disabled hook into a telemetry dependency when the callback fails", async () => {
    const failure = new Error("callback failed");
    const onStart = vi.fn();
    const onEnd = vi.fn();

    expect(() =>
      withSpan(
        "tool",
        () => {
          throw failure;
        },
        { recorder: { onStart, onEnd } }
      )
    ).toThrow(failure);

    expect(onStart).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });
});

describe("OpenInference span hooks — explicit opt-in", () => {
  it("records sanitized start and successful completion for an enabled span", async () => {
    const starts: SpanStart[] = [];
    const ends: SpanEnd[] = [];
    const dates = [
      new Date("2026-07-20T12:00:00.000Z"),
      new Date("2026-07-20T12:00:00.025Z")
    ];
    const hooks = createOpenInferenceHooks({
      enabled: true,
      now: () => dates.shift() ?? new Date("2026-07-20T12:00:00.025Z"),
      recorder: {
        onStart: (span) => starts.push(span),
        onEnd: (span) => ends.push(span)
      }
    });

    await expect(
      hooks.withSpan("tool.execute", async () => "done", {
        "openinference.span.kind": "TOOL",
        "tool.name": "workspace.read",
        "llm.model_name": "gpt-5",
        "turn.index": 3,
        input: "must not be recorded",
        userEmail: "operator@example.com"
      })
    ).resolves.toBe("done");

    expect(starts).toEqual([
      {
        name: "tool.execute",
        startedAt: "2026-07-20T12:00:00.000Z",
        attributes: {
          "openinference.span.kind": "TOOL",
          "tool.name": "workspace.read",
          "llm.model_name": "gpt-5",
          "turn.index": 3
        }
      }
    ]);
    expect(ends).toEqual([
      {
        name: "tool.execute",
        startedAt: "2026-07-20T12:00:00.000Z",
        endedAt: "2026-07-20T12:00:00.025Z",
        durationMs: 25,
        status: "ok",
        attributes: {
          "openinference.span.kind": "TOOL",
          "tool.name": "workspace.read",
          "llm.model_name": "gpt-5",
          "turn.index": 3
        }
      }
    ]);
  });

  it("records an error completion and rethrows the callback error", async () => {
    const starts: SpanStart[] = [];
    const ends: SpanEnd[] = [];
    const failure = new Error("tool failed");
    const hooks = createOpenInferenceHooks({
      enabled: true,
      now: (() => {
        const dates = [
          new Date("2026-07-20T12:01:00.000Z"),
          new Date("2026-07-20T12:01:00.010Z")
        ];
        return () => dates.shift() ?? new Date("2026-07-20T12:01:00.010Z");
      })(),
      recorder: {
        onStart: (span) => starts.push(span),
        onEnd: (span) => ends.push(span)
      }
    });

    expect(() =>
      hooks.withSpan(
        "tool.execute",
        () => {
          throw failure;
        },
        { "openinference.span.kind": "TOOL" }
      )
    ).toThrow(failure);

    expect(starts).toHaveLength(1);
    expect(ends).toEqual([
      {
        name: "tool.execute",
        startedAt: "2026-07-20T12:01:00.000Z",
        endedAt: "2026-07-20T12:01:00.010Z",
        durationMs: 10,
        status: "error",
        attributes: { "openinference.span.kind": "TOOL" }
      }
    ]);
  });

  it("accepts no recorder without changing callback behavior", async () => {
    const hooks = createOpenInferenceHooks({ enabled: true });

    expect(hooks.withSpan("turn", () => 42)).toBe(42);
  });
});

describe("OpenInference span attributes — structural metadata-only filtering", () => {
  it("drops unknown, PII-shaped, secret-shaped, and non-primitive attributes", async () => {
    const starts: SpanStart[] = [];
    const hooks = createOpenInferenceHooks({
      enabled: true,
      recorder: { onStart: (span) => starts.push(span) }
    });

    await hooks.withSpan("turn", () => undefined, {
      operation: "agent.turn",
      status: "ok",
      "turn.index": 2,
      "user.email": "operator@example.com",
      apiKey: "sk-live-secret-value",
      input: "private prompt",
      nested: { hidden: "value" },
      list: ["not metadata"]
    });

    expect(starts[0]?.attributes).toEqual({
      operation: "agent.turn",
      status: "ok",
      "turn.index": 2
    });
    expect(JSON.stringify(starts)).not.toContain("operator@example.com");
    expect(JSON.stringify(starts)).not.toContain("sk-live-secret-value");
    expect(JSON.stringify(starts)).not.toContain("private prompt");
  });
});
