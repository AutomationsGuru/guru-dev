import { describe, expect, it } from "vitest";

import {
  EffortTierSchema,
  RoleEffortTierMapSchema,
  defineRoleEffortTierMap,
  resolveTier
} from '../../src/providers/roleEffortTierMap.js';

describe("role effort tier map schema", () => {
  it("constrains effort to tiers 0-4 and defaults unknown roles to mid (2)", () => {
    const empty = RoleEffortTierMapSchema.parse({});
    expect(empty.default).toBe(2);
    expect(empty.tiers).toEqual({});
    expect(empty.inherit).toEqual({});
  });

  it("rejects out-of-range tiers", () => {
    const result = EffortTierSchema.safeParse(5);
    expect(result.success).toBe(false);
  });
});

describe("resolveTier", () => {
  it("returns a known role's tier", () => {
    const map = defineRoleEffortTierMap({
      default: 2,
      tiers: { coder: 4, reviewer: 1 }
    });

    expect(resolveTier("coder", map)).toBe(4);
    expect(resolveTier("reviewer", map)).toBe(1);
  });

  it("returns the mid default for an unknown role", () => {
    const map = defineRoleEffortTierMap({ tiers: { coder: 4 } });

    expect(resolveTier("planetary-architect", map)).toBe(2);
  });

  it("inherits a tier from an explicit parent role", () => {
    const map = defineRoleEffortTierMap({
      default: 2,
      tiers: { coder: 4 },
      inherit: { "junior-coder": "coder" }
    });

    expect(resolveTier("junior-coder", map)).toBe(4);
  });

  it("normalizes role names (trim + lowercase)", () => {
    const map = defineRoleEffortTierMap({ tiers: { coder: 3 } });

    expect(resolveTier("  CODER ", map)).toBe(3);
  });

  it("treats tier 0 as a real value, not a missing entry", () => {
    const map = defineRoleEffortTierMap({ tiers: { observer: 0 } });

    expect(resolveTier("observer", map)).toBe(0);
  });

  it("falls back to the default when inheritance forms a cycle", () => {
    const map = defineRoleEffortTierMap({
      default: 2,
      inherit: { alpha: "beta", beta: "alpha" }
    });

    expect(resolveTier("alpha", map)).toBe(2);
  });

  it("honors an explicit override of the default tier", () => {
    const map = defineRoleEffortTierMap({ default: 1 });

    expect(resolveTier("unknown", map)).toBe(1);
  });
});
