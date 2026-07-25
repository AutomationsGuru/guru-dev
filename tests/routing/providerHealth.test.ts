import { describe, expect, it } from "vitest";

import {
  ProviderHealthStore,
  getDefaultProviderHealthStore,
  __resetDefaultProviderHealthStoreForTests
} from '../../src/routing/providerHealth.js';

describe("provider health probe cache", () => {
  it("records an ok probe and reports it fresh within TTL", () => {
    let clock = 1_000;
    const store = new ProviderHealthStore({ ttlMs: 60_000, now: () => clock });

    const record = store.recordProbe("openai-codex", { status: "ok", verified: true, costUsd: 0.0002 });

    expect(record).toMatchObject({ providerId: "openai-codex", status: "ok", recordedAt: 1_000, costUsd: 0.0002 });
    expect(store.getStatus("openai-codex")).toMatchObject({ status: "ok", fresh: true });
  });

  it("downgrades to unknown once TTL expires but retains last-known for fail-open", () => {
    let clock = 1_000;
    const store = new ProviderHealthStore({ ttlMs: 60_000, now: () => clock });

    store.recordProbe("anthropic", { status: "ok", verified: true });
    expect(store.getStatus("anthropic").status).toBe("ok");

    clock += 60_001; // cross TTL boundary
    const snapshot = store.getStatus("anthropic");

    // Plan step 2: TTL expiry -> unknown.
    expect(snapshot.status).toBe("unknown");
    expect(snapshot.fresh).toBe(false);
    // Goal: fail open to last-known (ranker may still prefer it rather than crash).
    expect(snapshot.lastKnown).toMatchObject({ providerId: "anthropic", status: "ok", recordedAt: 1_000 });
  });

  it("reports unknown for a provider that has never been probed", () => {
    const store = new ProviderHealthStore({ ttlMs: 60_000, now: () => 1_000 });
    const snapshot = store.getStatus("ollama-local");
    expect(snapshot.status).toBe("unknown");
    expect(snapshot.fresh).toBe(false);
    expect(snapshot.lastKnown).toBeUndefined();
  });

  it("records a degraded probe and reflects it while fresh", () => {
    let clock = 5_000;
    const store = new ProviderHealthStore({ ttlMs: 30_000, now: () => clock });

    store.recordProbe("openrouter", { status: "degraded", note: "5xx band" });
    expect(store.getStatus("openrouter")).toMatchObject({ status: "degraded", fresh: true });
  });

  it("never invents success: ok without verified:true throws", () => {
    const store = new ProviderHealthStore({ ttlMs: 60_000, now: () => 1_000 });
    expect(() => store.recordProbe("openai-codex", { status: "ok" })).toThrow(/never invent success/);
    // Nothing was recorded.
    expect(store.getStatus("openai-codex").status).toBe("unknown");
  });

  it("never invents cost: non-finite or negative cost throws and is not recorded", () => {
    const store = new ProviderHealthStore({ ttlMs: 60_000, now: () => 1_000 });
    expect(() => store.recordProbe("openai-codex", { status: "ok", verified: true, costUsd: Number.NaN })).toThrow();
    expect(() => store.recordProbe("openai-codex", { status: "ok", verified: true, costUsd: -0.01 })).toThrow(/costUsd/);
    // A real, finite, non-negative observed cost is accepted.
    store.recordProbe("openai-codex", { status: "ok", verified: true, costUsd: 0 });
    expect(store.getStatus("openai-codex").lastKnown?.costUsd).toBe(0);
  });

  it("validates provider id and status shape", () => {
    const store = new ProviderHealthStore({ ttlMs: 60_000, now: () => 1_000 });
    expect(() => store.recordProbe("", { status: "ok", verified: true })).toThrow(/providerId/);
    // @ts-expect-error -- runtime guard against an unknown status string
    expect(() => store.recordProbe("p", { status: "unknown", verified: true })).toThrow(/status/);
  });

  it("rejects an invalid TTL at construction", () => {
    expect(() => new ProviderHealthStore({ ttlMs: Number.NaN })).toThrow(/ttlMs/);
    expect(() => new ProviderHealthStore({ ttlMs: -1 })).toThrow(/ttlMs/);
  });

  it("clears records", () => {
    const store = new ProviderHealthStore({ ttlMs: 60_000, now: () => 1_000 });
    store.recordProbe("anthropic", { status: "ok", verified: true });
    store.clear();
    expect(store.getStatus("anthropic").status).toBe("unknown");
  });

  it("returns a shared default store", () => {
    __resetDefaultProviderHealthStoreForTests();
    const a = getDefaultProviderHealthStore();
    const b = getDefaultProviderHealthStore();
    expect(a).toBe(b);
    __resetDefaultProviderHealthStoreForTests();
  });
});
