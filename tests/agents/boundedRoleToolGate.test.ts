import { describe, expect, it } from "vitest";

import {
  BOUNDED_ROLES,
  BOUNDED_ROLE_DEFINITIONS,
  BoundedRoleSchema,
  getBoundedRoleDefinition
} from '../../src/agents/boundedRoleAgents.js';
import { assertToolAllowed, isPlanWritePath } from '../../src/agents/boundedRoleToolGate.js';

describe("bounded role definitions", () => {
  it("ships exactly the three built-in roles", () => {
    expect(BOUNDED_ROLES).toEqual(["implement", "research", "plan"]);
    expect(BoundedRoleSchema.parse("plan")).toBe("plan");
  });

  it("freezes role definitions against mutation", () => {
    expect(Object.isFrozen(BOUNDED_ROLE_DEFINITIONS)).toBe(true);
    expect(Object.isFrozen(getBoundedRoleDefinition("research"))).toBe(true);
    expect(Object.isFrozen(getBoundedRoleDefinition("plan").toolAllowlist)).toBe(true);
  });
});

describe("assertToolAllowed — implement role", () => {
  it("allows edit on arbitrary code paths", () => {
    const result = assertToolAllowed("implement", { toolName: "edit", targetPath: "src/cli.ts" });
    expect(result.decision).toBe("ok");
  });

  it("allows shell-risk tools", () => {
    expect(assertToolAllowed("implement", { toolName: "bash" }).decision).toBe("ok");
    expect(assertToolAllowed("implement", { toolName: "shell.command.run" }).decision).toBe("ok");
  });

  it("allows unknown tools (wildcard boundary)", () => {
    expect(assertToolAllowed("implement", { toolName: "some.future.tool" }).decision).toBe("ok");
  });
});

describe("assertToolAllowed — research role", () => {
  it("allows read-only tools", () => {
    for (const toolName of ["read", "glob", "grep", "ls", "web_fetch", "web_search"]) {
      expect(assertToolAllowed("research", { toolName }).decision).toBe("ok");
    }
  });

  it("denies edit regardless of target", () => {
    const result = assertToolAllowed("research", { toolName: "edit", targetPath: "plans/x.md" });
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("research");
  });

  it("denies write and shell-risk tools", () => {
    for (const toolName of ["write", "bash", "shell.command.run", "fs.edit.apply", "todo_write"]) {
      expect(assertToolAllowed("research", { toolName }).decision).toBe("deny");
    }
  });
});

describe("assertToolAllowed — plan role", () => {
  it("allows read-only tools", () => {
    expect(assertToolAllowed("plan", { toolName: "read" }).decision).toBe("ok");
    expect(assertToolAllowed("plan", { toolName: "grep" }).decision).toBe("ok");
  });

  it("allows write under plans/*", () => {
    const result = assertToolAllowed("plan", { toolName: "write", targetPath: "plans/auth-redesign.md" });
    expect(result.decision).toBe("ok");
  });

  it("allows edit under planning/* and nested plans paths", () => {
    expect(
      assertToolAllowed("plan", { toolName: "edit", targetPath: "planning/PAIRED.md" }).decision
    ).toBe("ok");
    expect(
      assertToolAllowed("plan", { toolName: "write", targetPath: "plans/deep/nested/spec.md" }).decision
    ).toBe("ok");
  });

  it("allows PLAN*.md artifacts at any depth", () => {
    expect(
      assertToolAllowed("plan", { toolName: "write", targetPath: "docs/PLAN-roles.md" }).decision
    ).toBe("ok");
  });

  it("normalizes windows separators and ./ prefixes before the path rule", () => {
    expect(
      assertToolAllowed("plan", { toolName: "write", targetPath: ".\\plans\\win.md" }).decision
    ).toBe("ok");
  });

  it("denies writes to arbitrary code paths", () => {
    const result = assertToolAllowed("plan", { toolName: "edit", targetPath: "src/cli.ts" });
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("plan artifacts");
  });

  it("denies write without a target path (fail-closed)", () => {
    expect(assertToolAllowed("plan", { toolName: "write" }).decision).toBe("deny");
    expect(assertToolAllowed("plan", { toolName: "edit", targetPath: "  " }).decision).toBe("deny");
  });

  it("denies shell-risk tools", () => {
    for (const toolName of ["bash", "shell.command.run", "fs.edit.apply"]) {
      expect(assertToolAllowed("plan", { toolName }).decision).toBe("deny");
    }
  });
});

describe("isPlanWritePath", () => {
  it("classifies plan-artifact paths", () => {
    expect(isPlanWritePath("plans/a.md")).toBe(true);
    expect(isPlanWritePath("planning/b.md")).toBe(true);
    expect(isPlanWritePath("PLAN.md")).toBe(true);
    expect(isPlanWritePath("docs/PLAN-x.md")).toBe(true);
  });

  it("rejects non-plan paths", () => {
    expect(isPlanWritePath("src/index.ts")).toBe(false);
    expect(isPlanWritePath("plans.md")).toBe(false);
    expect(isPlanWritePath("my-plans/a.md")).toBe(false);
    expect(isPlanWritePath("notes/plan.md")).toBe(false);
  });
});
