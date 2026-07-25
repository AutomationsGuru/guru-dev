import { describe, expect, it } from "vitest";

import { resolveSlot } from '../../src/routing/workflowModelSlots.js';
import {
  ModelBindingSchema,
  WorkflowModelSlotsConfigSchema,
  type WorkflowModelSlotsConfig
} from '../../src/routing/workflowModelSlotsSchema.js';

const NORMAL_BINDING = { provider: "anthropic", model: "claude-sonnet-4-6" } as const;
const THINKING_BINDING = { provider: "anthropic", model: "claude-opus-4-8" } as const;
const CRITIQUE_BINDING = { model: "router-claude-opus-4-8" } as const;

function makeConfig(overrides: Partial<WorkflowModelSlotsConfig> = {}): WorkflowModelSlotsConfig {
  return WorkflowModelSlotsConfigSchema.parse(overrides);
}

describe("resolveSlot", () => {
  it("falls back to normal when the phase slot is unset (default chain)", () => {
    const config = makeConfig({ normal: NORMAL_BINDING });

    const resolved = resolveSlot(config, "thinking");

    expect(resolved.slot).toBe("normal");
    expect(resolved.binding).toEqual(NORMAL_BINDING);
  });

  it("walks an explicit chain critique -> thinking -> normal and returns thinking when critique is unset", () => {
    const config = makeConfig({
      normal: NORMAL_BINDING,
      thinking: THINKING_BINDING,
      fallbacks: { critique: ["thinking", "normal"] }
    });

    const resolved = resolveSlot(config, "critique");

    expect(resolved.slot).toBe("thinking");
    expect(resolved.binding).toEqual(THINKING_BINDING);
  });

  it("returns the explicit critique binding without falling back when critique is set", () => {
    const config = makeConfig({
      normal: NORMAL_BINDING,
      thinking: THINKING_BINDING,
      critique: CRITIQUE_BINDING,
      fallbacks: { critique: ["thinking", "normal"] }
    });

    const resolved = resolveSlot(config, "critique");

    expect(resolved.slot).toBe("critique");
    expect(resolved.binding).toEqual(CRITIQUE_BINDING);
  });

  it("throws when the chain terminates at an unbound normal slot", () => {
    const config = makeConfig({ thinking: THINKING_BINDING });

    expect(() => resolveSlot(config, "critique")).toThrow(/no model binding for phase "critique"/);
    expect(() => resolveSlot(config, "normal")).toThrow(/"normal"/);
  });

  it("throws on a cycle in explicit fallback chains", () => {
    const config = makeConfig({
      normal: NORMAL_BINDING,
      fallbacks: { critique: ["thinking"], thinking: ["critique"] }
    });

    expect(() => resolveSlot(config, "critique")).toThrow(/cycle/i);
  });

  it("does not fail on a cycle in an unwalked branch when an earlier hop is bound", () => {
    const config = makeConfig({
      normal: NORMAL_BINDING,
      thinking: THINKING_BINDING,
      fallbacks: { critique: ["thinking", "normal"], thinking: ["critique"] }
    });

    // critique -> thinking (bound) stops the walk; thinking's own cyclic
    // fallback back to critique is never traversed.
    const resolved = resolveSlot(config, "critique");

    expect(resolved.slot).toBe("thinking");
    expect(resolved.binding).toEqual(THINKING_BINDING);
  });
});

describe("WorkflowModelSlotsConfigSchema", () => {
  it("parses a valid config with bindings and explicit fallbacks", () => {
    const parsed = WorkflowModelSlotsConfigSchema.parse({
      normal: NORMAL_BINDING,
      thinking: THINKING_BINDING,
      fallbacks: { critique: ["thinking", "normal"] }
    });

    expect(parsed.normal?.model).toBe(NORMAL_BINDING.model);
    expect(parsed.fallbacks.critique).toEqual(["thinking", "normal"]);
  });

  it("parses an empty config to the default shape", () => {
    const parsed = WorkflowModelSlotsConfigSchema.parse({});

    expect(parsed.normal).toBeUndefined();
    expect(parsed.fallbacks).toEqual({});
  });

  it("rejects a binding missing its model", () => {
    const result = WorkflowModelSlotsConfigSchema.safeParse({
      normal: { provider: "anthropic" }
    });

    expect(result.success).toBe(false);
  });

  it("rejects an unknown slot key (strict object)", () => {
    const result = WorkflowModelSlotsConfigSchema.safeParse({
      normal: NORMAL_BINDING,
      dreaming: { model: "some-model" }
    });

    expect(result.success).toBe(false);
  });

  it("rejects a fallback chain referencing an unknown slot", () => {
    const result = WorkflowModelSlotsConfigSchema.safeParse({
      fallbacks: { critique: ["thinking", "dreaming"] }
    });

    expect(result.success).toBe(false);
  });

  it("rejects a binding with extra keys (strict object)", () => {
    const result = ModelBindingSchema.safeParse({
      model: "some-model",
      temperature: 0
    });

    expect(result.success).toBe(false);
  });
});
