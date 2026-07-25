import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { applyOneShotExpansion, detectNeed, type SandboxSessionLike } from '../../src/sandbox/sandboxExpansion.js';
import { ExpansionNeedSchema } from '../../src/sandbox/sandboxExpansionSchema.js';

function createSession(): SandboxSessionLike {
  return {
    sandbox: {
      mode: "read-only",
      allowPaths: [resolve("/repo")],
      network: false
    }
  };
}

describe("ExpansionNeedSchema", () => {
  it("requires at least one path or network access", () => {
    expect(() => ExpansionNeedSchema.parse({ paths: [], network: false, reason: "missing" })).toThrow(
      /at least one path or network access/i
    );
  });
});

describe("detectNeed", () => {
  it("extracts a need from a denial signal with requested paths", () => {
    const need = detectNeed({
      denial: {
        stderr: "sandbox denied: /tmp/cache requires additional path access",
        requestedPaths: ["/tmp/cache"]
      }
    });

    expect(need).toEqual({
      paths: [resolve("/tmp/cache")],
      network: false,
      reason: "sandbox denied: /tmp/cache requires additional path access",
      source: "denial-signal"
    });
  });

  it("extracts a need from the proactive classifier stub", () => {
    const need = detectNeed({
      hint: {
        paths: ["/opt/tool-cache"],
        network: true,
        reason: "tool declares extra mounts"
      }
    });

    expect(need).toEqual({
      paths: [resolve("/opt/tool-cache")],
      network: true,
      reason: "tool declares extra mounts",
      source: "proactive-classifier"
    });
  });

  it("detects network-only denial signals without inventing path scope", () => {
    const need = detectNeed({
      denial: {
        error: "network is disabled for this sandboxed call"
      }
    });

    expect(need).toEqual({
      paths: [],
      network: true,
      reason: "network is disabled for this sandboxed call",
      source: "denial-signal"
    });
  });

  it("returns undefined for ambiguous denial signals", () => {
    expect(
      detectNeed({
        denial: {
          stderr: "tool failed for an unrelated reason"
        }
      })
    ).toBeUndefined();
  });
});

describe("applyOneShotExpansion", () => {
  it("deny keeps the original sandbox", () => {
    const session = createSession();
    const runtime = applyOneShotExpansion(session, { paths: ["/tmp/out"], network: false, reason: "need temp output" }, "deny");

    expect(runtime.approved).toBe(false);
    expect(runtime.sessionForCall()).toBe(session);
    expect(runtime.isConsumed()).toBe(true);
  });

  it("approve grants one-shot path access without mutating the original session", () => {
    const session = createSession();
    const runtime = applyOneShotExpansion(session, { paths: ["/tmp/out"], network: false, reason: "need temp output" }, "approve");

    const expanded = runtime.sessionForCall();
    expect(expanded).not.toBe(session);
    expect(expanded.sandbox.mode).toBe("read-only");
    expect(expanded.sandbox.allowPaths).toEqual([resolve("/repo"), resolve("/tmp/out")]);
    expect(expanded.sandbox.network).toBe(false);
    expect(session.sandbox.allowPaths).toEqual([resolve("/repo")]);
  });

  it("requires a new approval for a second call", () => {
    const session = createSession();
    const runtime = applyOneShotExpansion(session, { paths: ["/tmp/out"], network: false, reason: "need temp output" }, "approve");

    const first = runtime.sessionForCall();
    const second = runtime.sessionForCall();

    expect(first.sandbox.allowPaths).toContain(resolve("/tmp/out"));
    expect(second).toBe(session);
    expect(second.sandbox.allowPaths).not.toContain(resolve("/tmp/out"));
  });

  it("still denies illegal expansion when policy vetoes the approval", () => {
    const session = createSession();
    const runtime = applyOneShotExpansion(
      session,
      { paths: ["/root/forbidden"], network: true, reason: "attempted illegal elevate" },
      "approve",
      {
        policy: () => ({ allowed: false, reason: "blocked by F81 policy" })
      }
    );

    expect(runtime.approved).toBe(false);
    expect(runtime.sessionForCall()).toBe(session);
  });

  it("deduplicates approved paths and preserves pre-existing network access", () => {
    const session: SandboxSessionLike = {
      sandbox: {
        mode: "workspace-write",
        allowPaths: [resolve("/repo"), resolve("/tmp/out")],
        network: true
      }
    };
    const runtime = applyOneShotExpansion(
      session,
      { paths: ["/tmp/out", "/tmp/out", "/var/log"], network: false, reason: "reuse existing mount" },
      "approve"
    );

    const expanded = runtime.sessionForCall();
    expect(expanded.sandbox.mode).toBe("workspace-write");
    expect(expanded.sandbox.allowPaths).toEqual([resolve("/repo"), resolve("/tmp/out"), resolve("/var/log")]);
    expect(expanded.sandbox.network).toBe(true);
  });
});
