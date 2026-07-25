import { describe, expect, it } from "vitest";

import {
  DEFAULT_HARD_LIMIT_HOOKS,
  PROFILE_HOOKS,
  isHardLimitHook,
  isHookRuntimeProfile,
  resolveActiveHooks
} from "../../src/hooks/hookRuntimeProfileResolve.js";

describe("hookRuntimeProfileResolve — profile tables", () => {
  it("declares exactly the three profiles minimal|standard|strict", () => {
    expect(Object.keys(PROFILE_HOOKS).sort()).toEqual(["minimal", "standard", "strict"]);
  });

  it("is cumulative: strict ⊇ standard ⊇ minimal", () => {
    for (const id of PROFILE_HOOKS.minimal) {
      expect(PROFILE_HOOKS.standard).toContain(id);
    }
    for (const id of PROFILE_HOOKS.standard) {
      expect(PROFILE_HOOKS.strict).toContain(id);
    }
  });

  it("strict adds hooks beyond standard, standard beyond minimal", () => {
    expect(PROFILE_HOOKS.standard.length).toBeGreaterThan(PROFILE_HOOKS.minimal.length);
    expect(PROFILE_HOOKS.strict.length).toBeGreaterThan(PROFILE_HOOKS.standard.length);
  });

  it("isHookRuntimeProfile narrows valid names and rejects others", () => {
    expect(isHookRuntimeProfile("minimal")).toBe(true);
    expect(isHookRuntimeProfile("standard")).toBe(true);
    expect(isHookRuntimeProfile("strict")).toBe(true);
    expect(isHookRuntimeProfile("yolo")).toBe(false);
    expect(isHookRuntimeProfile("")).toBe(false);
    expect(isHookRuntimeProfile(undefined)).toBe(false);
    expect(isHookRuntimeProfile(42)).toBe(false);
  });
});

describe("resolveActiveHooks — profile selection", () => {
  it("returns exactly the profile set for each profile", () => {
    for (const profile of ["minimal", "standard", "strict"] as const) {
      const { activeHooks, appliedProfile } = resolveActiveHooks({ profile, hardLimitIds: [] });
      expect(appliedProfile).toBe(profile);
      expect(activeHooks).toEqual(PROFILE_HOOKS[profile]);
    }
  });

  it("defaults to the standard profile when none is given", () => {
    const { appliedProfile, activeHooks } = resolveActiveHooks({ hardLimitIds: [] });
    expect(appliedProfile).toBe("standard");
    expect(activeHooks).toEqual(PROFILE_HOOKS.standard);
  });

  it("accepts an empty options object", () => {
    const { appliedProfile } = resolveActiveHooks({});
    expect(appliedProfile).toBe("standard");
  });
});

describe("resolveActiveHooks — hard limits always on (constitution §3)", () => {
  const FIRST_HARD_LIMIT = DEFAULT_HARD_LIMIT_HOOKS[0] as string;

  it("keeps every hard-limit hook active in every profile, including minimal", () => {
    for (const profile of ["minimal", "standard", "strict"] as const) {
      const { activeHooks } = resolveActiveHooks({ profile });
      for (const id of DEFAULT_HARD_LIMIT_HOOKS) {
        expect(activeHooks).toContain(id);
      }
    }
  });

  it("a hard-limit id in disabledIds is NOT disabled and is reported as protected", () => {
    const target = FIRST_HARD_LIMIT;
    const result = resolveActiveHooks({ profile: "strict", disabledIds: [target] });
    expect(result.activeHooks).toContain(target);
    expect(result.hardLimitProtected).toEqual([target]);
    expect(result.disabledEffective).toEqual([]);
  });

  it("ALL hard-limit ids in disabledIds stay active — no fail-open path", () => {
    const result = resolveActiveHooks({ profile: "minimal", disabledIds: [...DEFAULT_HARD_LIMIT_HOOKS] });
    for (const id of DEFAULT_HARD_LIMIT_HOOKS) {
      expect(result.activeHooks).toContain(id);
    }
    expect(result.hardLimitProtected).toEqual([...DEFAULT_HARD_LIMIT_HOOKS]);
    expect(result.disabledEffective).toEqual([]);
  });

  it("reports no protection when no hard-limit id was requested disabled", () => {
    const result = resolveActiveHooks({ profile: "standard", disabledIds: ["core.metrics"] });
    expect(result.hardLimitProtected).toEqual([]);
    expect(result.disabledEffective).toEqual(["core.metrics"]);
  });

  it("honors a custom hardLimitIds list over the default", () => {
    const result = resolveActiveHooks({
      profile: "minimal",
      disabledIds: ["custom.guard"],
      hardLimitIds: ["custom.guard"]
    });
    expect(result.activeHooks).toContain("custom.guard");
    expect(result.hardLimitProtected).toEqual(["custom.guard"]);
  });

  it("isHardLimitHook identifies default and custom hard-limit ids", () => {
    expect(isHardLimitHook(DEFAULT_HARD_LIMIT_HOOKS[2] as string)).toBe(true);
    expect(isHardLimitHook("core.metrics")).toBe(false);
    expect(isHardLimitHook("custom.guard", ["custom.guard"])).toBe(true);
  });
});

describe("resolveActiveHooks — disabled ids", () => {
  it("removes a non-hard-limit profile hook when disabled", () => {
    const { activeHooks, disabledEffective } = resolveActiveHooks({
      profile: "standard",
      disabledIds: ["core.metrics"],
      hardLimitIds: []
    });
    expect(activeHooks).not.toContain("core.metrics");
    expect(activeHooks).toContain("core.lifecycle");
    expect(disabledEffective).toEqual(["core.metrics"]);
  });

  it("disabling an id absent from the profile set is a recorded no-op", () => {
    const { activeHooks, disabledEffective } = resolveActiveHooks({
      profile: "minimal",
      disabledIds: ["core.security"],
      hardLimitIds: []
    });
    expect(activeHooks).toEqual(PROFILE_HOOKS.minimal);
    expect(disabledEffective).toEqual(["core.security"]);
  });

  it("mixed disable list: non-hard removed, hard kept, both reported", () => {
    const hard = DEFAULT_HARD_LIMIT_HOOKS[DEFAULT_HARD_LIMIT_HOOKS.length - 1] as string;
    const result = resolveActiveHooks({ profile: "strict", disabledIds: ["core.audit", hard] });
    expect(result.activeHooks).not.toContain("core.audit");
    expect(result.activeHooks).toContain(hard);
    expect(result.disabledEffective).toEqual(["core.audit"]);
    expect(result.hardLimitProtected).toEqual([hard]);
  });

  it("duplicate disable requests are de-duplicated in the reports", () => {
    const result = resolveActiveHooks({
      profile: "standard",
      disabledIds: ["core.metrics", "core.metrics"],
      hardLimitIds: []
    });
    expect(result.disabledEffective).toEqual(["core.metrics"]);
  });
});

describe("resolveActiveHooks — edge cases", () => {
  it("undefined disabledIds behaves as an empty list", () => {
    const { activeHooks, disabledEffective } = resolveActiveHooks({ profile: "minimal", hardLimitIds: [] });
    expect(activeHooks).toEqual(PROFILE_HOOKS.minimal);
    expect(disabledEffective).toEqual([]);
  });

  it("empty disabledIds and empty hardLimitIds return the bare profile set", () => {
    const { activeHooks, hardLimitProtected } = resolveActiveHooks({
      profile: "strict",
      disabledIds: [],
      hardLimitIds: []
    });
    expect(activeHooks).toEqual(PROFILE_HOOKS.strict);
    expect(hardLimitProtected).toEqual([]);
  });

  it("result activeHooks contain no duplicates even when hard limits overlap the profile set", () => {
    const { activeHooks } = resolveActiveHooks({
      profile: "standard",
      hardLimitIds: ["core.audit", ...DEFAULT_HARD_LIMIT_HOOKS]
    });
    expect(new Set(activeHooks).size).toBe(activeHooks.length);
  });

  it("does not mutate the inputs", () => {
    const disabledIds = ["core.metrics"];
    const hardLimitIds = ["custom.guard"];
    resolveActiveHooks({ profile: "strict", disabledIds, hardLimitIds });
    expect(disabledIds).toEqual(["core.metrics"]);
    expect(hardLimitIds).toEqual(["custom.guard"]);
  });
});
