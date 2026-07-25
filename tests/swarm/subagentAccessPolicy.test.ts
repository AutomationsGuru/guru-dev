import { describe, expect, it } from "vitest";

import {
  SubagentAccessPolicySchema,
  isSpawnAllowed,
  spawnDenialReason
} from '../../src/swarm/subagentAccessPolicy.js';

describe("subagent access policy — schema", () => {
  it("defaults to empty allow-lists", () => {
    const policy = SubagentAccessPolicySchema.parse({});
    expect(policy.allowedTools).toEqual([]);
    expect(policy.allowedModels).toEqual([]);
  });

  it("is strict: unknown keys are rejected", () => {
    expect(() => SubagentAccessPolicySchema.parse({ allowedTools: [], extra: true })).toThrow();
  });
});

describe("subagent access policy — spawn checks", () => {
  it("empty policy allows any tool and model", () => {
    const policy = SubagentAccessPolicySchema.parse({});
    expect(isSpawnAllowed(policy, {})).toBe(true);
    expect(isSpawnAllowed(policy, { tool: "anything" })).toBe(true);
    expect(isSpawnAllowed(policy, { model: "any-model" })).toBe(true);
    expect(isSpawnAllowed(policy, { tool: "x", model: "y" })).toBe(true);
  });

  it("allow-list permits a listed tool", () => {
    const policy = SubagentAccessPolicySchema.parse({ allowedTools: ["read", "grep"] });
    expect(isSpawnAllowed(policy, { tool: "read" })).toBe(true);
    expect(isSpawnAllowed(policy, { tool: "grep" })).toBe(true);
  });

  it("allow-list permits a listed model", () => {
    const policy = SubagentAccessPolicySchema.parse({ allowedModels: ["fast", "deep"] });
    expect(isSpawnAllowed(policy, { model: "fast" })).toBe(true);
    expect(isSpawnAllowed(policy, { model: "deep" })).toBe(true);
  });

  it("unlisted tool is denied when the tool list is non-empty", () => {
    const policy = SubagentAccessPolicySchema.parse({ allowedTools: ["read"] });
    expect(isSpawnAllowed(policy, { tool: "bash" })).toBe(false);
    expect(spawnDenialReason(policy, { tool: "bash" })).toContain("bash");
    expect(spawnDenialReason(policy, { tool: "bash" })).toContain("tool");
  });

  it("unlisted model is denied when the model list is non-empty", () => {
    const policy = SubagentAccessPolicySchema.parse({ allowedModels: ["fast"] });
    expect(isSpawnAllowed(policy, { model: "slow" })).toBe(false);
    expect(spawnDenialReason(policy, { model: "slow" })).toContain("slow");
    expect(spawnDenialReason(policy, { model: "slow" })).toContain("model");
  });

  it("combined request is denied when any one dimension fails", () => {
    const policy = SubagentAccessPolicySchema.parse({ allowedTools: ["read"], allowedModels: ["fast"] });
    expect(isSpawnAllowed(policy, { tool: "read", model: "fast" })).toBe(true);
    expect(isSpawnAllowed(policy, { tool: "bash", model: "fast" })).toBe(false);
    expect(isSpawnAllowed(policy, { tool: "read", model: "slow" })).toBe(false);
    expect(spawnDenialReason(policy, { tool: "read", model: "slow" })).toContain("model");
  });

  it("dimensions not named in the request are unchecked; empty dimensions are unrestricted", () => {
    const policy = SubagentAccessPolicySchema.parse({ allowedTools: ["read"] });
    expect(isSpawnAllowed(policy, {})).toBe(true);
    expect(isSpawnAllowed(policy, { model: "whatever" })).toBe(true);
  });

  it("allowed spawns return a null denial reason", () => {
    const policy = SubagentAccessPolicySchema.parse({ allowedTools: ["read"] });
    expect(spawnDenialReason(policy, { tool: "read" })).toBeNull();
    expect(spawnDenialReason(policy, {})).toBeNull();
  });
});
