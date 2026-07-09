import { describe, expect, it } from "vitest";

import {
  computeRetryDelay,
  DEFAULT_RETRY_CONFIG,
  isRetryableFailure,
  parseRetryAfterMs,
  RetryConfigSchema,
  RetryDelayExceededError,
  runWithRetryPolicy
} from "../../src/model/retryPolicy.js";

// Re-export assertion surface: default timeout is part of the public contract.

const config = (overrides: object = {}) => RetryConfigSchema.parse(overrides);

describe("classification — the binding table (ADR 2026-07-05)", () => {
  it("retries network failures, 408, 429, and 5xx", () => {
    expect(isRetryableFailure({ networkError: true })).toBe(true);
    expect(isRetryableFailure({ status: 408 })).toBe(true);
    expect(isRetryableFailure({ status: 429 })).toBe(true);
    expect(isRetryableFailure({ status: 500 })).toBe(true);
    expect(isRetryableFailure({ status: 503 })).toBe(true);
  });

  it("NEVER retries auth/validation errors — they are real", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableFailure({ status }), `status ${status}`).toBe(false);
    }
    expect(isRetryableFailure({})).toBe(false);
  });

  it("NEVER retries operator abort", () => {
    expect(isRetryableFailure({ aborted: true })).toBe(false);
    expect(isRetryableFailure({ aborted: true, networkError: true })).toBe(false);
  });
});

describe("default provider timeout", () => {
  it("ships a 60s default so blackholed providers surface an error before the operator gives up", () => {
    expect(DEFAULT_RETRY_CONFIG.provider.timeoutMs).toBe(60_000);
  });
});

describe("Retry-After parsing", () => {
  it("parses delta-seconds and HTTP-dates", () => {
    expect(parseRetryAfterMs("30")).toBe(30_000);
    const now = () => Date.parse("2026-07-05T12:00:00.000Z");
    expect(parseRetryAfterMs("Sun, 05 Jul 2026 12:00:45 GMT", now)).toBe(45_000);
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("garbage")).toBeUndefined();
  });

  it("fractional/negative numerics are delta-seconds — NEVER Date.parse'd into 0ms hammering", () => {
    expect(parseRetryAfterMs("0.5")).toBe(500);
    expect(parseRetryAfterMs("5.5")).toBe(5_500);
    expect(parseRetryAfterMs("-1")).toBe(0);
    // Letterless non-numerics never reach the lenient date parser.
    expect(parseRetryAfterMs("1/2")).toBeUndefined();
  });
});

describe("backoff math", () => {
  it("is exponential (base × 2^(n−1)) with bounded jitter", () => {
    const cfg = config();
    // random() = 0 → no jitter: exact 2s, 4s, 8s.
    expect(computeRetryDelay({ attempt: 1, config: cfg, random: () => 0 }).delayMs).toBe(2_000);
    expect(computeRetryDelay({ attempt: 2, config: cfg, random: () => 0 }).delayMs).toBe(4_000);
    expect(computeRetryDelay({ attempt: 3, config: cfg, random: () => 0 }).delayMs).toBe(8_000);
    // random() = 1 → +25% max jitter.
    expect(computeRetryDelay({ attempt: 1, config: cfg, random: () => 1 }).delayMs).toBe(2_500);
  });

  it("uses the server-requested delay when within the cap; FAILS FAST beyond it", () => {
    const cfg = config();
    expect(computeRetryDelay({ attempt: 1, config: cfg, retryAfterMs: 10_000, random: () => 0 }).delayMs).toBe(10_000);
    const decision = computeRetryDelay({ attempt: 1, config: cfg, retryAfterMs: 5 * 60 * 60 * 1_000, random: () => 0 });
    expect(decision.failFast).toEqual({ requestedMs: 18_000_000, capMs: 60_000 });
  });

  it("caps ordinary backoff at maxRetryDelayMs", () => {
    const cfg = config({ baseDelayMs: 50_000, provider: { maxRetryDelayMs: 60_000 } });
    expect(computeRetryDelay({ attempt: 3, config: cfg, random: () => 0 }).delayMs).toBe(60_000);
  });
});

describe("runWithRetryPolicy — the loop", () => {
  const failure = (status?: number, retryAfterMs?: number, networkError?: boolean) => {
    const error = new Error(`fail ${status ?? "network"}`);
    Object.assign(error, { status, retryAfterMs, networkError });
    return error;
  };
  const describeFailure = (error: unknown) => {
    const e = error as { status?: number; retryAfterMs?: number; networkError?: boolean };
    return {
      ...(e.status !== undefined ? { status: e.status } : {}),
      ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
      ...(e.networkError !== undefined ? { networkError: e.networkError } : {})
    };
  };
  const instantHooks = (slept: number[], retries: object[]) => ({
    sleep: (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
    random: () => 0,
    onRetry: (info: object) => {
      retries.push(info);
    }
  });

  it("429 twice then success: completes with exponential delays and indicator calls", async () => {
    const slept: number[] = [];
    const retries: object[] = [];
    let calls = 0;
    const result = await runWithRetryPolicy(
      () => {
        calls += 1;
        if (calls <= 2) {
          return Promise.reject(failure(429));
        }
        return Promise.resolve("ok");
      },
      { config: DEFAULT_RETRY_CONFIG, describeFailure, hooks: instantHooks(slept, retries) }
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(slept).toEqual([2_000, 4_000]);
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatchObject({ attempt: 1, maxAttempts: 3, delayMs: 2_000, reason: "HTTP 429" });
  });

  it("401 fails immediately with ZERO retries", async () => {
    const slept: number[] = [];
    let calls = 0;
    await expect(
      runWithRetryPolicy(
        () => {
          calls += 1;
          return Promise.reject(failure(401));
        },
        { config: DEFAULT_RETRY_CONFIG, describeFailure, hooks: instantHooks(slept, []) }
      )
    ).rejects.toThrow("fail 401");
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  it("enabled=false restores single-attempt behavior exactly", async () => {
    let calls = 0;
    await expect(
      runWithRetryPolicy(
        () => {
          calls += 1;
          return Promise.reject(failure(429));
        },
        { config: config({ enabled: false }), describeFailure, hooks: instantHooks([], []) }
      )
    ).rejects.toThrow("fail 429");
    expect(calls).toBe(1);
  });

  it("exhausts maxRetries then rethrows the last error", async () => {
    let calls = 0;
    await expect(
      runWithRetryPolicy(
        () => {
          calls += 1;
          return Promise.reject(failure(503));
        },
        { config: DEFAULT_RETRY_CONFIG, describeFailure, hooks: instantHooks([], []) }
      )
    ).rejects.toThrow("fail 503");
    expect(calls).toBe(4); // 1 + maxRetries(3)
  });

  it("a Retry-After beyond the cap fails fast with the requested delay named", async () => {
    let calls = 0;
    await expect(
      runWithRetryPolicy(
        () => {
          calls += 1;
          return Promise.reject(failure(429, 18_000_000));
        },
        { config: DEFAULT_RETRY_CONFIG, describeFailure, hooks: instantHooks([], []) }
      )
    ).rejects.toThrow(RetryDelayExceededError);
    expect(calls).toBe(1);
    try {
      await runWithRetryPolicy(() => Promise.reject(failure(429, 18_000_000)), {
        config: DEFAULT_RETRY_CONFIG,
        describeFailure,
        hooks: instantHooks([], [])
      });
    } catch (error) {
      expect((error as Error).message).toContain("18000s");
      expect((error as Error).message).toContain("60s cap");
    }
  });

  it("provider.maxRetries grants EXTRA attempts only for provider-requested retries", async () => {
    const slept: number[] = [];
    let calls = 0;
    // maxRetries 1, provider.maxRetries 2: a Retry-After failure may retry 3 times.
    const cfg = config({ maxRetries: 1, provider: { maxRetries: 2 } });
    await expect(
      runWithRetryPolicy(
        () => {
          calls += 1;
          return Promise.reject(failure(429, 1_000));
        },
        { config: cfg, describeFailure, hooks: instantHooks(slept, []) }
      )
    ).rejects.toThrow("fail 429");
    expect(calls).toBe(4); // 1 + base(1) + providerExtra(2)
    // Same config, NO Retry-After: only the base budget applies.
    calls = 0;
    await expect(
      runWithRetryPolicy(
        () => {
          calls += 1;
          return Promise.reject(failure(500));
        },
        { config: cfg, describeFailure, hooks: instantHooks([], []) }
      )
    ).rejects.toThrow("fail 500");
    expect(calls).toBe(2); // 1 + base(1)
  });
});
