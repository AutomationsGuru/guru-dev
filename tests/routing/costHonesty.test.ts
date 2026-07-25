import { describe, expect, it } from "vitest";

import { aggregateUsage, formatCost } from '../../src/routing/costHonesty.js';
import type { UsageEntry } from '../../src/routing/costHonesty.js';
import type { RouteCost } from '../../src/providers/schemas.js';

// ── formatCost ──────────────────────────────────────────────────────────────

describe("formatCost", () => {
  it("null → 'unknown' (never claim $0 when pricing is missing)", () => {
    expect(formatCost(null)).toBe("unknown");
  });

  it("known zero → '$0.00' (genuinely free, pricing is present)", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  it("positive cents → formatted USD", () => {
    expect(formatCost(123)).toBe("$1.23");
  });

  it("fractional cents are rounded", () => {
    // 0.7 cents rounds to 1 cent = $0.01
    expect(formatCost(0.7)).toBe("$0.01");
    // 0.3 cents rounds to 0 cents = $0.00
    expect(formatCost(0.3)).toBe("$0.00");
  });

  it("large values format correctly", () => {
    expect(formatCost(12345)).toBe("$123.45");
    expect(formatCost(100000)).toBe("$1000.00");
  });
});

// ── aggregateUsage ──────────────────────────────────────────────────────────

describe("aggregateUsage", () => {
  // Sample cost descriptors
  const knownPricing: RouteCost = {
    currency: "USD",
    inputPerMillionTokens: 3.0,  // $3 / 1M input tokens
    outputPerMillionTokens: 15.0, // $15 / 1M output tokens
    notes: [],
  };

  const zeroPricing: RouteCost = {
    currency: "USD",
    inputPerMillionTokens: 0,
    outputPerMillionTokens: 0,
    notes: [],
  };

  const missingInputPricing: RouteCost = {
    currency: "USD",
    // inputPerMillionTokens is missing
    outputPerMillionTokens: 15.0,
    notes: [],
  };

  const missingOutputPricing: RouteCost = {
    currency: "USD",
    inputPerMillionTokens: 3.0,
    // outputPerMillionTokens is missing
    notes: [],
  };

  const emptyCost: RouteCost = {
    currency: "USD",
    notes: [],
  };

  function costLookup(modelId: string): RouteCost | undefined {
    switch (modelId) {
      case "claude-sonnet-5":
        return knownPricing;
      case "free-model":
        return zeroPricing;
      case "partial-input":
        return missingInputPricing;
      case "partial-output":
        return missingOutputPricing;
      case "no-pricing":
        return emptyCost;
      default:
        return undefined; // model not in catalog
    }
  }

  it("empty entries → empty map", () => {
    const result = aggregateUsage([], costLookup);
    expect(result.size).toBe(0);
  });

  it("single model, single entry → aggregated correctly", () => {
    const entries: UsageEntry[] = [
      { modelId: "claude-sonnet-5", inputTokens: 1000, outputTokens: 500 },
    ];
    const result = aggregateUsage(entries, costLookup);
    expect(result.size).toBe(1);

    const bucket = result.get("claude-sonnet-5")!;
    expect(bucket.inputTokens).toBe(1000);
    expect(bucket.outputTokens).toBe(500);
    expect(bucket.totalTokens).toBe(1500);
    // input:  (1000 / 1e6) * 3.0 * 100 = 0.3 cents
    // output: (500  / 1e6) * 15.0 * 100 = 0.75 cents
    // total: 1.05 → round to 1
    expect(bucket.estimatedCostCents).toBe(1);
  });

  it("single model, multiple entries → summed", () => {
    const entries: UsageEntry[] = [
      { modelId: "claude-sonnet-5", inputTokens: 1000, outputTokens: 500 },
      { modelId: "claude-sonnet-5", inputTokens: 2000, outputTokens: 300 },
    ];
    const result = aggregateUsage(entries, costLookup);
    expect(result.size).toBe(1);

    const bucket = result.get("claude-sonnet-5")!;
    expect(bucket.inputTokens).toBe(3000);
    expect(bucket.outputTokens).toBe(800);
    expect(bucket.totalTokens).toBe(3800);
  });

  it("multi-model entries → separate buckets with separate pricing", () => {
    const entries: UsageEntry[] = [
      { modelId: "claude-sonnet-5", inputTokens: 1000, outputTokens: 500 },
      { modelId: "free-model",      inputTokens: 5000, outputTokens: 2000 },
      { modelId: "claude-sonnet-5", inputTokens: 300,  outputTokens: 100 },
    ];
    const result = aggregateUsage(entries, costLookup);
    expect(result.size).toBe(2);

    const claude = result.get("claude-sonnet-5")!;
    expect(claude.inputTokens).toBe(1300);
    expect(claude.outputTokens).toBe(600);
    expect(claude.estimatedCostCents).not.toBeNull();

    const free = result.get("free-model")!;
    expect(free.inputTokens).toBe(5000);
    expect(free.outputTokens).toBe(2000);
    // Zero pricing × non-zero tokens = genuinely $0.00
    expect(free.estimatedCostCents).toBe(0);
  });

  it("model not in catalog → cost is null (honest unknown)", () => {
    const entries: UsageEntry[] = [
      { modelId: "unknown-model", inputTokens: 1000, outputTokens: 500 },
    ];
    const result = aggregateUsage(entries, costLookup);
    expect(result.size).toBe(1);

    const bucket = result.get("unknown-model")!;
    expect(bucket.inputTokens).toBe(1000);
    expect(bucket.outputTokens).toBe(500);
    expect(bucket.estimatedCostCents).toBeNull();
  });

  it("partial pricing (only input) → cost is null", () => {
    const entries: UsageEntry[] = [
      { modelId: "partial-input", inputTokens: 1000, outputTokens: 500 },
    ];
    const result = aggregateUsage(entries, costLookup);
    const bucket = result.get("partial-input")!;
    expect(bucket.estimatedCostCents).toBeNull();
  });

  it("partial pricing (only output) → cost is null", () => {
    const entries: UsageEntry[] = [
      { modelId: "partial-output", inputTokens: 1000, outputTokens: 500 },
    ];
    const result = aggregateUsage(entries, costLookup);
    const bucket = result.get("partial-output")!;
    expect(bucket.estimatedCostCents).toBeNull();
  });

  it("empty cost (no pricing fields) → cost is null", () => {
    const entries: UsageEntry[] = [
      { modelId: "no-pricing", inputTokens: 1000, outputTokens: 500 },
    ];
    const result = aggregateUsage(entries, costLookup);
    const bucket = result.get("no-pricing")!;
    expect(bucket.estimatedCostCents).toBeNull();
  });

  it("known pricing + zero tokens → genuinely zero cost (not unknown)", () => {
    const entries: UsageEntry[] = [
      { modelId: "claude-sonnet-5", inputTokens: 0, outputTokens: 0 },
    ];
    const result = aggregateUsage(entries, costLookup);
    const bucket = result.get("claude-sonnet-5")!;
    expect(bucket.inputTokens).toBe(0);
    expect(bucket.outputTokens).toBe(0);
    // Pricing is known, tokens are zero → cost is genuinely $0.00
    expect(bucket.estimatedCostCents).toBe(0);
  });

  it("unknown pricing + non-zero tokens → unknown cost (not mistaken for free)", () => {
    const entries: UsageEntry[] = [
      { modelId: "no-pricing", inputTokens: 100000, outputTokens: 50000 },
    ];
    const result = aggregateUsage(entries, costLookup);
    const bucket = result.get("no-pricing")!;
    // Tokens are tracked honestly
    expect(bucket.inputTokens).toBe(100000);
    expect(bucket.outputTokens).toBe(50000);
    // But cost is null — we don't know the price, so we don't claim $0
    expect(bucket.estimatedCostCents).toBeNull();
  });

  it("back-and-forth model switch: each model's counters stay independent", () => {
    const entries: UsageEntry[] = [
      { modelId: "claude-sonnet-5", inputTokens: 100, outputTokens: 50 },
      { modelId: "free-model",      inputTokens: 200, outputTokens: 80 },
      { modelId: "claude-sonnet-5", inputTokens: 300, outputTokens: 150 },
      { modelId: "free-model",      inputTokens: 400, outputTokens: 120 },
    ];
    const result = aggregateUsage(entries, costLookup);
    expect(result.size).toBe(2);

    const claude = result.get("claude-sonnet-5")!;
    expect(claude.inputTokens).toBe(400);
    expect(claude.outputTokens).toBe(200);

    const free = result.get("free-model")!;
    expect(free.inputTokens).toBe(600);
    expect(free.outputTokens).toBe(200);
  });
});
