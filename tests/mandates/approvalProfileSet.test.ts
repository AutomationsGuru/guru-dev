import { describe, expect, it } from "vitest";

import {
  APPROVAL_PROFILE_SCHEMA,
  type ApprovalProfile,
  type ApprovalProfileMode,
  resolve
} from '../../src/mandates/approvalProfileSet.js';

function profile(
  overrides: Partial<ApprovalProfile> & { name: string }
): ApprovalProfile {
  return APPROVAL_PROFILE_SCHEMA.parse({
    rules: {},
    ...overrides
  });
}

describe("resolve — approval profile lookup", () => {
  it("returns the explicit rule for a listed tool class", () => {
    const p = profile({
      name: "test",
      rules: { bash: "ask", read: "auto", write: "deny" }
    });
    expect(resolve(p, "bash")).toBe("ask");
    expect(resolve(p, "read")).toBe("auto");
    expect(resolve(p, "write")).toBe("deny");
  });

  it("defaults to 'deny' for an unknown tool class (deny wins over auto)", () => {
    const p = profile({ name: "safe" });
    expect(resolve(p, "unknown-tool")).toBe("deny");
  });

  it("defaults to 'deny' for an unknown class even when other classes are auto", () => {
    const p = profile({
      name: "auto-heavy",
      rules: { bash: "auto", read: "auto", write: "auto" }
    });
    // The profile has no deny rules — but deny STILL wins for the unknown class.
    expect(resolve(p, "unknown-tool")).toBe("deny");
  });

  it("respects an explicit non-deny defaultMode when the caller opts in", () => {
    const p = profile({
      name: "loose",
      defaultMode: "ask"
    });
    // "ask" was deliberate — the default is still fail-closed construction,
    // but the caller can loosen it explicitly.
    expect(resolve(p, "some-class")).toBe("ask");
  });

  it("an explicit 'auto' defaultMode resolves unknown classes to auto", () => {
    const p = profile({
      name: "yolo-ish",
      defaultMode: "auto"
    });
    expect(resolve(p, "any-tool")).toBe("auto");
  });

  it("explicit rule beats defaultMode for a listed class", () => {
    const p = profile({
      name: "mixed",
      rules: { bash: "deny" },
      defaultMode: "auto"
    });
    expect(resolve(p, "bash")).toBe("deny"); // explicit wins
    expect(resolve(p, "unlisted")).toBe("auto"); // default kicks in
  });

  it("empty profile (no rules, no explicit default) resolves everything to deny", () => {
    const p = profile({ name: "empty" });
    const classes = ["bash", "write", "edit", "web_fetch", "unknown"];
    for (const tc of classes) {
      expect(resolve(p, tc)).toBe("deny");
    }
  });

  it("schema defaultMode is 'deny' when omitted", () => {
    const p = APPROVAL_PROFILE_SCHEMA.parse({ name: "x" });
    expect(p.defaultMode).toBe("deny");
  });

  it("schema enforces strict mode values (auto|ask|deny only)", () => {
    expect(() =>
      APPROVAL_PROFILE_SCHEMA.parse({ name: "x", rules: { bash: "nope" } })
    ).toThrow();
  });

  it("schema rejects empty name", () => {
    expect(() => APPROVAL_PROFILE_SCHEMA.parse({ name: "" })).toThrow();
  });
});
