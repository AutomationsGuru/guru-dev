import { describe, expect, it } from "vitest";

import { SessionSpendCap } from '../../src/session/sessionSpendCap.js';

describe("SessionSpendCap", () => {
  it("continues when usage is under both limits", () => {
    const cap = new SessionSpendCap({ maxPriceUsd: 1.0, maxTokens: 1_000 });
    cap.trackUsage({ inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
    const decision = cap.checkCap();
    expect(decision).toEqual({ kind: "continue" });
  });

  it("stops with a receipt when cumulative tokens exceed maxTokens", () => {
    const cap = new SessionSpendCap({ maxTokens: 300 });
    cap.trackUsage({ inputTokens: 200, outputTokens: 150 });
    const decision = cap.checkCap();
    expect(decision.kind).toBe("stop");
    if (decision.kind !== "stop") return;
    expect(decision.receipt.limit).toBe("maxTokens");
    expect(decision.receipt.maxTokens).toBe(300);
    expect(decision.receipt.totalTokens).toBe(350);
    expect(decision.receipt.exceeded).toBe(true);
    expect(decision.receipt.summary).toContain("token");
  });

  it("stops with a receipt when cumulative cost exceeds maxPriceUsd", () => {
    const cap = new SessionSpendCap({ maxPriceUsd: 0.05 });
    cap.trackUsage({ inputTokens: 100, outputTokens: 100, costUsd: 0.03 });
    expect(cap.checkCap().kind).toBe("continue");
    cap.trackUsage({ inputTokens: 100, outputTokens: 100, costUsd: 0.03 });
    const decision = cap.checkCap();
    expect(decision.kind).toBe("stop");
    if (decision.kind !== "stop") return;
    expect(decision.receipt.limit).toBe("maxPriceUsd");
    expect(decision.receipt.maxPriceUsd).toBe(0.05);
    expect(decision.receipt.totalCostUsd).toBeCloseTo(0.06, 10);
    expect(decision.receipt.exceeded).toBe(true);
    expect(decision.receipt.summary).toContain("price");
  });

  it("enforces only the token cap when cost is unknown (F49 cost honesty)", () => {
    const cap = new SessionSpendCap({ maxPriceUsd: 0.000001, maxTokens: 1_000 });
    cap.trackUsage({ inputTokens: 10, outputTokens: 10 });
    const decision = cap.checkCap();
    expect(decision).toEqual({ kind: "continue" });
    expect(cap.state.costKnown).toBe(false);
  });

  it("keeps reporting continue once stopped until more usage is tracked after caps change", () => {
    const cap = new SessionSpendCap({ maxTokens: 10 });
    cap.trackUsage({ inputTokens: 6, outputTokens: 6 });
    const first = cap.checkCap();
    expect(first.kind).toBe("stop");
    const again = cap.checkCap();
    expect(again.kind).toBe("stop");
  });
});
