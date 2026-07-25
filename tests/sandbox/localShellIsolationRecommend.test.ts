import { describe, it, expect } from "vitest";
import {
  mayRunLocalShell,
  type LocalShellIsolationRecommendation,
} from '../../src/sandbox/localShellIsolationRecommend.js';

describe("localShellIsolationRecommend", () => {
  it("allows under sandbox profile (no warn)", () => {
    const r: LocalShellIsolationRecommendation = mayRunLocalShell("sandbox", false);
    expect(r.allowed).toBe(true);
    expect(r.warn).toBe(false);
    expect(r.reason).toMatch(/sandbox/i);
  });

  it("allows under Sandbox-Profile variant", () => {
    const r = mayRunLocalShell("isolated-sandbox-profile", undefined);
    expect(r.allowed).toBe(true);
    expect(r.warn).toBe(false);
  });

  it("denies bare host without override (warn + block)", () => {
    const r = mayRunLocalShell(undefined, undefined);
    expect(r.allowed).toBe(false);
    expect(r.warn).toBe(true);
    expect(r.reason).toMatch(/bare host|blocked for isolation/i);
  });

  it("denies bare host even with falsy override", () => {
    const r = mayRunLocalShell("", false);
    expect(r.allowed).toBe(false);
    expect(r.warn).toBe(true);
  });

  it("allows with explicit override on bare host", () => {
    const r = mayRunLocalShell(undefined, true);
    expect(r.allowed).toBe(true);
    expect(r.warn).toBe(false);
    expect(r.reason).toMatch(/override/i);
  });
});
