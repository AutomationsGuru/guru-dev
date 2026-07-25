import { describe, expect, it } from "vitest";

import {
  routeTier,
  TierRouteCatalogSchema,
  TierSchema
} from '../../src/model/modelTierRouteHint.js';

// F601 model tier route hint: known tiers resolve, everything else fails closed.

const catalog = () =>
  TierRouteCatalogSchema.parse({
    light: "fast-small-model",
    standard: "mid-range-model",
    heavy: "frontier-large-model"
  });

describe("TierSchema — the tier vocabulary", () => {
  it("accepts exactly light | standard | heavy", () => {
    expect(TierSchema.parse("light")).toBe("light");
    expect(TierSchema.parse("standard")).toBe("standard");
    expect(TierSchema.parse("heavy")).toBe("heavy");
  });

  it("rejects anything else, including case variants", () => {
    expect(TierSchema.safeParse("Light").success).toBe(false);
    expect(TierSchema.safeParse("HEAVY").success).toBe(false);
    expect(TierSchema.safeParse("medium").success).toBe(false);
    expect(TierSchema.safeParse("").success).toBe(false);
  });
});

describe("routeTier — known tiers resolve to their catalog model id", () => {
  it("resolves each known tier to its mapped model id", () => {
    expect(routeTier("light", catalog())).toEqual({ ok: true, tier: "light", modelId: "fast-small-model" });
    expect(routeTier("standard", catalog())).toEqual({ ok: true, tier: "standard", modelId: "mid-range-model" });
    expect(routeTier("heavy", catalog())).toEqual({ ok: true, tier: "heavy", modelId: "frontier-large-model" });
  });
});

describe("routeTier — unknown tiers FAIL CLOSED", () => {
  it("rejects an arbitrary tier string naming the rejected tier", () => {
    const result = routeTier("medium", catalog());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("medium");
    }
  });

  it("rejects case variants — never silently coerces to a known tier", () => {
    for (const variant of ["Light", "LIGHT", "Standard", "HEAVY", " heavy", "heavy "]) {
      const result = routeTier(variant, catalog());
      expect(result.ok, `tier ${JSON.stringify(variant)}`).toBe(false);
    }
  });

  it("never falls back to another tier for unknown input", () => {
    const result = routeTier("unknown-tier", catalog());
    expect(result.ok).toBe(false);
    expect(result).not.toMatchObject({ modelId: expect.anything() });
  });
});

describe("routeTier — catalog gaps fail closed too", () => {
  it("rejects a known tier MISSING from the catalog", () => {
    const partial = TierRouteCatalogSchema.parse({ light: "fast-small-model" });
    const result = routeTier("heavy", partial);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("heavy");
    }
  });

  it("rejects a catalog mapping a known tier to an empty/whitespace-only model id", () => {
    expect(TierRouteCatalogSchema.safeParse({ light: "", standard: "m", heavy: "h" }).success).toBe(false);
    expect(TierRouteCatalogSchema.safeParse({ light: "   ", standard: "m", heavy: "h" }).success).toBe(false);
    // routeTier itself also fails closed when handed such a catalog (schema bypassed).
    expect(routeTier("light", { light: "", standard: "m", heavy: "h" }).ok).toBe(false);
    expect(routeTier("heavy", { light: "l", standard: "s", heavy: "  " }).ok).toBe(false);
  });

  it("rejects extra/unknown keys in the catalog (strict)", () => {
    expect(TierRouteCatalogSchema.safeParse({ light: "l", standard: "s", heavy: "h", turbo: "x" }).success).toBe(false);
  });
});

describe("routeTier — purity", () => {
  it("does not mutate the input catalog", () => {
    const input = catalog();
    const snapshot = { ...input };
    routeTier("light", input);
    routeTier("heavy", input);
    routeTier("bogus", input);
    expect(input).toEqual(snapshot);
  });
});
