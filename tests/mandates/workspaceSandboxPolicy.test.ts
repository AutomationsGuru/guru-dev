import { describe, expect, it } from "vitest";

import { classifyPath, evaluateWorkspaceSandbox } from '../../src/mandates/workspaceSandboxPolicy.js';

const root = process.platform === "win32" ? "C:\\work\\repo" : "/work/repo";
const outside = process.platform === "win32" ? "C:\\work\\outside.txt" : "/work/outside.txt";

const defaultPolicy = { writeRoot: root };

describe("workspace sandbox policy", () => {
  it("classifies normalized descendants as inside and siblings as outside", () => {
    expect(classifyPath("src/feature.ts", root)).toBe("inside");
    expect(classifyPath("src/../README.md", root)).toBe("inside");
    expect(classifyPath("../outside.txt", root)).toBe("outside");
    expect(classifyPath(`${root}-copy/file.ts`, root)).toBe("outside");
  });

  it("allows writes inside the project/worktree root", () => {
    expect(evaluateWorkspaceSandbox({ kind: "write", path: "src/feature.ts" }, defaultPolicy)).toEqual({
      outcome: "allow",
      reason: "write target is within the workspace root",
      pathClass: "inside"
    });
  });

  it("denies writes outside the project/worktree root by default", () => {
    expect(evaluateWorkspaceSandbox({ kind: "write", path: outside }, defaultPolicy)).toEqual({
      outcome: "deny",
      reason: "write target is outside the workspace root",
      pathClass: "outside"
    });
  });

  it("allows an explicit outside-root policy exception but continues to classify the path", () => {
    expect(evaluateWorkspaceSandbox({ kind: "write", path: outside }, { ...defaultPolicy, allowOutsideRoot: true })).toEqual({
      outcome: "allow",
      reason: "outside-root write is explicitly allowed by workspace policy",
      pathClass: "outside"
    });
  });

  it("escalates network and shell elevation until their policy/class owner approves them", () => {
    expect(evaluateWorkspaceSandbox({ kind: "network", approvalClass: "network" }, defaultPolicy)).toEqual({
      outcome: "escalate",
      reason: "network access requires an explicit approval class"
    });
    expect(evaluateWorkspaceSandbox({ kind: "shell", approvalClass: "shell-risk" }, defaultPolicy)).toEqual({
      outcome: "escalate",
      reason: "shell elevation requires an explicit approval class"
    });
  });

  it("permits network only when the policy explicitly opts in", () => {
    expect(evaluateWorkspaceSandbox({ kind: "network", approvalClass: "network" }, { ...defaultPolicy, allowNetwork: true })).toEqual({
      outcome: "allow",
      reason: "network access is explicitly allowed by workspace policy"
    });
  });

  it.each(["destructive", "spend", "secret-edge", "auth-edge"])("denies the hard-limit class %s before F61 can auto-approve", (approvalClass) => {
    expect(evaluateWorkspaceSandbox({ kind: "write", path: "src/feature.ts", approvalClass }, defaultPolicy)).toEqual({
      outcome: "deny",
      reason: `hard-limit approval class (${approvalClass}) is never auto-approved`
    });
  });

  it("fails closed for malformed policies and unclassified writes", () => {
    expect(evaluateWorkspaceSandbox({ kind: "write" }, defaultPolicy)).toEqual({ outcome: "deny", reason: "invalid workspace sandbox input" });
    expect(evaluateWorkspaceSandbox({ kind: "write", path: "src/feature.ts" }, { writeRoot: "relative" })).toEqual({
      outcome: "deny",
      reason: "invalid workspace sandbox input"
    });
  });
});
