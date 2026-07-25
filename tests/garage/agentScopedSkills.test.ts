import { afterEach, describe, expect, it } from "vitest";

import {
  attach,
  detach,
  listFor,
  __resetForTests
} from '../../src/garage/agentScopedSkills.js';

describe("agentScopedSkills", () => {
  afterEach(() => {
    __resetForTests();
  });

  it("lists global + project + agent layers with agent override/add", () => {
    const global = ["read", "write"];
    const project = ["deploy"];
    attach("agent-42", "agent-only");
    attach("agent-42", "deploy"); // override/add

    const result = listFor("agent-42", global, project);

    expect(result).toEqual(["read", "write", "deploy", "agent-only"]);
  });

  it("detach removes agent binding and updates listFor", () => {
    attach("agent-99", "temp-skill");
    attach("agent-99", "permanent");

    detach("agent-99", "temp-skill");

    const result = listFor("agent-99", ["base"], []);
    expect(result).toEqual(["base", "permanent"]);
    expect(result).not.toContain("temp-skill");
  });

  it("unknown agent yields only global+project (no error)", () => {
    const result = listFor("nonexistent", ["g1"], ["p1"]);
    expect(result).toEqual(["g1", "p1"]);
  });
});
