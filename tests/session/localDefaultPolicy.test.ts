import { describe, expect, it } from "vitest";

import {
  LocalDefaultPolicySchema,
  canUseRemoteTool,
  resolveModelCandidate,
  type ModelCandidate
} from '../../src/session/localDefaultPolicy.js';

const local: ModelCandidate = { modelId: "local-model", origin: "local" };
const remote: ModelCandidate = { modelId: "remote-model", origin: "remote" };

describe("LocalDefaultPolicySchema", () => {
  it("defaults both flags to false when the object is empty", () => {
    expect(LocalDefaultPolicySchema.parse({})).toEqual({
      preferLocalModels: false,
      allowRemoteElevate: false
    });
  });

  it("round-trips an explicit local-default policy", () => {
    expect(LocalDefaultPolicySchema.parse({ preferLocalModels: true, allowRemoteElevate: true })).toEqual({
      preferLocalModels: true,
      allowRemoteElevate: true
    });
  });

  it("rejects non-boolean flags and unknown keys (strict)", () => {
    expect(LocalDefaultPolicySchema.safeParse({ preferLocalModels: "yes" }).success).toBe(false);
    expect(LocalDefaultPolicySchema.safeParse({ allowRemoteElevate: 1 }).success).toBe(false);
    expect(LocalDefaultPolicySchema.safeParse({ preferLocalModels: true, surprise: true }).success).toBe(false);
  });
});

describe("resolveModelCandidate — prefer-local model selection", () => {
  it("prefers the local candidate when the flag is set", () => {
    const result = resolveModelCandidate(local, remote, { preferLocalModels: true, allowRemoteElevate: false });
    expect(result).toEqual({ candidate: local, degraded: false });
  });

  it("prefers the remote candidate when the flag is not set (legacy direct-first behavior)", () => {
    const result = resolveModelCandidate(local, remote, { preferLocalModels: false, allowRemoteElevate: false });
    expect(result).toEqual({ candidate: remote, degraded: false });
  });

  it("degrades to remote when no local candidate exists — without stalling", () => {
    const result = resolveModelCandidate(null, remote, { preferLocalModels: true, allowRemoteElevate: false });
    expect(result).toEqual({ candidate: remote, degraded: true });
  });

  it("degrades to local when no remote candidate exists even without the flag", () => {
    const result = resolveModelCandidate(local, null, { preferLocalModels: false, allowRemoteElevate: false });
    expect(result).toEqual({ candidate: local, degraded: true });
  });

  it("returns no candidate when neither lane offers one", () => {
    const result = resolveModelCandidate(null, null, { preferLocalModels: true, allowRemoteElevate: false });
    expect(result).toEqual({ candidate: null, degraded: false });
  });
});

describe("canUseRemoteTool — workspace tools stay local, remote elevate is opt-in", () => {
  it("always allows workspace-scoped (local) tools regardless of policy", () => {
    expect(canUseRemoteTool({ scope: "workspace" }, { preferLocalModels: true, allowRemoteElevate: false })).toBe(true);
    expect(canUseRemoteTool({ scope: "workspace" }, { preferLocalModels: false, allowRemoteElevate: false })).toBe(true);
  });

  it("denies remote/cloud tools without operator opt-in", () => {
    expect(canUseRemoteTool({ scope: "remote" }, { preferLocalModels: true, allowRemoteElevate: false })).toBe(false);
    expect(canUseRemoteTool({ scope: "remote" }, { preferLocalModels: false, allowRemoteElevate: false })).toBe(false);
  });

  it("allows remote/cloud tools when allowRemoteElevate is set", () => {
    expect(canUseRemoteTool({ scope: "remote" }, { preferLocalModels: true, allowRemoteElevate: true })).toBe(true);
    expect(canUseRemoteTool({ scope: "remote" }, { preferLocalModels: false, allowRemoteElevate: true })).toBe(true);
  });
});
