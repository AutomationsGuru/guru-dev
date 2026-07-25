import { describe, it, expect } from "vitest";
import { resolveSessionConfigLayers, clearSessionLayer } from '../../src/config/sessionConfigLayers.js';
import { DEFAULT_HARNESS_CONFIG, type HarnessConfig } from '../../src/config/schema.js';

describe("sessionConfigLayers", () => {
  it("returns global unchanged when no session override", () => {
    const effective = resolveSessionConfigLayers(DEFAULT_HARNESS_CONFIG);
    expect(effective).toBe(DEFAULT_HARNESS_CONFIG); // identity for perf
  });

  it("overrides top-level keys (e.g. runtimeName) without mutating global", () => {
    const globalCopy: HarnessConfig = { ...DEFAULT_HARNESS_CONFIG };
    const originalRuntimeName = globalCopy.runtimeName;

    const effective = resolveSessionConfigLayers(globalCopy, {
      runtimeName: "SessionOverrideHarness"
    });

    expect(effective.runtimeName).toBe("SessionOverrideHarness");
    expect(globalCopy.runtimeName).toBe(originalRuntimeName); // never mutates
    expect(effective).not.toBe(globalCopy);
  });

  it("reload / clear semantics: empty override restores global view", () => {
    const effectiveWithOverride = resolveSessionConfigLayers(DEFAULT_HARNESS_CONFIG, {
      runtimeName: "TempSession"
    });
    expect(effectiveWithOverride.runtimeName).toBe("TempSession");

    const effectiveAfterReload = resolveSessionConfigLayers(DEFAULT_HARNESS_CONFIG, {});
    expect(effectiveAfterReload.runtimeName).toBe(DEFAULT_HARNESS_CONFIG.runtimeName);
    expect(effectiveAfterReload).toBe(DEFAULT_HARNESS_CONFIG);
  });

  it("supports plannerModel override (example of model-layer key)", () => {
    const effective = resolveSessionConfigLayers(DEFAULT_HARNESS_CONFIG, {
      // plannerModel is optional in schema; override with a minimal valid shape
      plannerModel: { provider: "openai", model: "gpt-4o-mini" } as any
    });
    expect(effective.plannerModel).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });

  it("clearSessionLayer + resolve semantics: reload clears session layer, no mutation of global", () => {
    clearSessionLayer(); // explicit clear for reload/new-session
    const effective = resolveSessionConfigLayers(DEFAULT_HARNESS_CONFIG, {
      plannerModel: { provider: "anthropic", model: "claude-3-5-sonnet" } as any
    });
    expect(effective.plannerModel).toEqual({ provider: "anthropic", model: "claude-3-5-sonnet" });

    // reload clears by using empty (stateless clear achieved via resolve with {})
    const cleared = resolveSessionConfigLayers(DEFAULT_HARNESS_CONFIG, {});
    expect(cleared.plannerModel).toBeUndefined();
    expect(cleared).toBe(DEFAULT_HARNESS_CONFIG); // identity, no mutation
  });
});