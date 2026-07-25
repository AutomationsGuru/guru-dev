import { describe, expect, it } from "vitest";

import { mayUseTool, roleAllowedTools } from '../../src/agents/boundedRoleCapability.js';
import { RoleProfileSchema, type RoleProfile } from '../../src/roles/schema.js';

function makeRole(overrides: Partial<RoleProfile> = {}): RoleProfile {
  return RoleProfileSchema.parse({
    slug: "finance",
    label: "finances",
    capabilityMode: "all",
    tools: [],
    skills: [],
    extensions: [],
    mcpServers: [],
    modelPreference: { requires: ["chat", "tools"] },
    verifiedTools: [],
    wornCount: 1,
    notes: "",
    ...overrides
  });
}

describe("boundedRoleCapability / mayUseTool", () => {
  it("denies a tool that is outside the role's allowed set", () => {
    const role = makeRole({ tools: ["web-search"] });
    expect(mayUseTool(role, "shell-exec")).toBe(false);
    expect(mayUseTool(role, "github-pr")).toBe(false);
  });

  it("permits a tool that the role explicitly selected", () => {
    const role = makeRole({ tools: ["web-search", "github-pr"] });
    expect(mayUseTool(role, "web-search")).toBe(true);
    expect(mayUseTool(role, "github-pr")).toBe(true);
  });

  it("permits core-floor tools for an `all` role even when not listed", () => {
    const role = makeRole({ capabilityMode: "all", tools: [] });
    expect(mayUseTool(role, "read")).toBe(true);
    expect(mayUseTool(role, "bash")).toBe(true);
    expect(mayUseTool(role, "edit")).toBe(true);
    expect(mayUseTool(role, "write")).toBe(true);
  });

  it("permits verified tools the suit has earned", () => {
    const role = makeRole({ tools: [], verifiedTools: ["repo-context"] });
    expect(mayUseTool(role, "repo-context")).toBe(true);
  });

  it("restricts a read-only role to the read floor and denies mutating tools even if listed", () => {
    // A read-only role must NOT gain write/edit/bash by listing them — the
    // capability bound is structural, not advisory, so the gate never weakens
    // a hard limit by trusting the loadout.
    const role = makeRole({
      capabilityMode: "read-only",
      tools: ["web-search", "edit", "write", "bash"]
    });
    expect(mayUseTool(role, "read")).toBe(true);
    expect(mayUseTool(role, "web-search")).toBe(true);
    expect(mayUseTool(role, "edit")).toBe(false);
    expect(mayUseTool(role, "write")).toBe(false);
    expect(mayUseTool(role, "bash")).toBe(false);
  });

  it("treats the allowed-tools set as a frozen, deny-by-default surface", () => {
    const role = makeRole({ tools: ["web-search"] });
    const allowed = roleAllowedTools(role);
    expect(allowed.has("web-search")).toBe(true);
    // unknown tool is not in the set
    expect(allowed.has("definitely-not-a-tool")).toBe(false);
    // outside-set deny is the same answer mayUseTool returns
    expect(mayUseTool(role, "definitely-not-a-tool")).toBe(false);
  });
});
