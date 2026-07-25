import { describe, expect, it } from "vitest";

import {
  listExecutors,
  resolve,
  type Executor
} from '../../src/runtime/sandboxExecutorRegistry.js';

describe("sandboxExecutorRegistry (IDEA-F630-SANDBOX-01)", () => {
  it("lists docker and mock only", () => {
    const listed = listExecutors();
    expect(listed.map((e) => e.id)).toEqual(["docker", "mock"]);
    expect(listed.every((e) => typeof e.label === "string" && e.label.length > 0)).toBe(true);
  });

  it("listExecutors returns a stable readonly snapshot", () => {
    const a = listExecutors();
    const b = listExecutors();
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("resolves known sandbox executors", () => {
    const docker = resolve("docker");
    expect(docker).toEqual({
      ok: true,
      executor: { id: "docker", label: "Docker sandbox" }
    });

    const mock = resolve("mock");
    expect(mock).toEqual({
      ok: true,
      executor: { id: "mock", label: "Mock sandbox" }
    });
  });

  it("normalizes case and surrounding whitespace for known ids", () => {
    const r = resolve("  DoCkEr  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.executor.id).toBe("docker");
  });

  it("fails closed on unrestricted local by default", () => {
    for (const id of ["local", "unrestricted", "local_unrestricted", "LOCAL", "  local  "]) {
      const r = resolve(id);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/fails closed/i);
    }
  });

  it("fails closed when allowUnrestrictedLocal is explicitly false", () => {
    const r = resolve("local", { allowUnrestrictedLocal: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/fails closed/i);
  });

  it("allows unrestricted local only with explicit allowUnrestrictedLocal true", () => {
    for (const id of ["local", "unrestricted", "local_unrestricted"]) {
      const r = resolve(id, { allowUnrestrictedLocal: true });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const executor: Executor = r.executor;
        expect(executor.label).toMatch(/unrestricted local/i);
      }
    }
  });

  it("unknown executor ids fail closed", () => {
    for (const id of ["k8s", "e2b", "host", "wasm", "python"]) {
      const r = resolve(id);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/unknown executor/i);
    }
  });

  it("empty / blank ids fail closed", () => {
    expect(resolve("").ok).toBe(false);
    expect(resolve("   ").ok).toBe(false);
  });

  it("does not treat mock as unrestricted", () => {
    const r = resolve("mock");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.executor.label).toBe("Mock sandbox");
  });
});
