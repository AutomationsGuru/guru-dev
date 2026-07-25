import { describe, expect, it } from "vitest";

import { assessTrust, isInsideRoot, isTrusted } from '../../src/mandates/trustFolderAllowlist.js';

const ROOT = "/home/op/project";
const roots = (paths: readonly string[]) => paths.map((path) => ({ path }));

describe("isTrusted — trust-folder allowlist", () => {
  it("trusts a CHILD of a trusted root (deep descendant)", () => {
    expect(isTrusted(`${ROOT}/src/index.ts`, roots([ROOT]))).toBe(true);
    expect(isTrusted(`${ROOT}/docs/a/b/c.md`, roots([ROOT]))).toBe(true);
  });

  it("trusts the root path itself (exact boundary)", () => {
    expect(isTrusted(ROOT, roots([ROOT]))).toBe(true);
  });

  it("DENIES a SIBLING of the trusted root", () => {
    // /home/op/other shares the parent prefix but is not under the root.
    expect(isTrusted("/home/op/other/x.ts", roots([ROOT]))).toBe(false);
  });

  it("DENIES a prefix-adjacent directory — /repo/ap must NOT cover /repo/app", () => {
    // The classic bare-startsWith trap: anchored containment prevents it.
    expect(isTrusted("/repo/app/file.ts", roots(["/repo/ap"]))).toBe(false);
    expect(isTrusted("/repo/ap/file.ts", roots(["/repo/ap"]))).toBe(true);
  });

  it("DENIES everything when there are no trusted roots", () => {
    expect(isTrusted("/anywhere/file.ts", roots([]))).toBe(false);
  });

  it("DENIES an empty/whitespace path — fail closed, never silently trust", () => {
    expect(isTrusted("", roots([ROOT]))).toBe(false);
    expect(isTrusted("   ", roots([ROOT]))).toBe(false);
  });

  it("trusts when the path is inside ANY of several roots", () => {
    const many = roots(["/home/op/project", "/srv/data"]);
    expect(isTrusted("/srv/data/inputs/x.json", many)).toBe(true);
    expect(isTrusted("/home/op/project/x", many)).toBe(true);
    expect(isTrusted("/etc/passwd", many)).toBe(false);
  });

  it("normalizes relative segments and trailing separators before checking", () => {
    // .. collapsing keeps /home/op/project/inside under the root.
    expect(isTrusted(`${ROOT}/sub/../inside.ts`, roots([ROOT]))).toBe(true);
    // A trailing slash on the root does not break containment.
    expect(isTrusted(`${ROOT}/x`, roots([`${ROOT}/`]))).toBe(true);
  });
});

describe("isInsideRoot — containment primitive", () => {
  it("matches exactly and as a separator-anchored prefix", () => {
    expect(isInsideRoot("/a/b", "/a/b")).toBe(true);
    expect(isInsideRoot("/a/b/c", "/a/b")).toBe(true);
  });

  it("rejects empty target or root", () => {
    expect(isInsideRoot("", "/a/b")).toBe(false);
    expect(isInsideRoot("/a/b", "")).toBe(false);
  });
});

describe("assessTrust — verdict helper", () => {
  it("returns a trusted verdict inside a root", () => {
    const v = assessTrust(`${ROOT}/file.ts`, roots([ROOT]));
    expect(v.trusted).toBe(true);
  });

  it("returns an untrusted verdict with an elevated-approval reason outside every root", () => {
    const v = assessTrust("/etc/secrets", roots([ROOT]));
    expect(v.trusted).toBe(false);
    expect(v.reason).toContain("/etc/secrets");
    expect(v.reason.toLowerCase()).toContain("elevated approval");
  });
});
