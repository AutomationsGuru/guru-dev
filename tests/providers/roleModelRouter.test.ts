import { describe, expect, it } from "vitest";

import {
  ROLE_MODEL_ROLES,
  RoleModelRoleSchema,
  RoleModelTableSchema,
  resolve
} from '../../src/providers/roleModelRouter.js';
import type { RoleModelTable } from '../../src/providers/roleModelRouter.js';

const fixtureTable: RoleModelTable = {
  default: "anthropic/claude-sonnet-5",
  smol: "anthropic/claude-haiku-5",
  slow: "anthropic/claude-opus-5",
  plan: "openai/gpt-6-plan",
  commit: "openai/gpt-6-mini"
};

describe("role model router roles", () => {
  it("should define exactly the five known roles", () => {
    expect(ROLE_MODEL_ROLES).toEqual(["default", "smol", "slow", "plan", "commit"]);
  });

  it("should accept each of the five known roles", () => {
    for (const role of ROLE_MODEL_ROLES) {
      expect(RoleModelRoleSchema.safeParse(role).success).toBe(true);
    }
  });

  it("should reject unknown roles", () => {
    for (const role of ["fast", "banana", "", "DEFAULT", "smoll"]) {
      expect(RoleModelRoleSchema.safeParse(role).success).toBe(false);
    }
  });
});

describe("role model table schema", () => {
  it("should accept a well-formed table", () => {
    expect(RoleModelTableSchema.safeParse(fixtureTable).success).toBe(true);
  });

  it("should reject empty-string model ids", () => {
    expect(RoleModelTableSchema.safeParse({ ...fixtureTable, smol: "" }).success).toBe(false);
  });

  it("should reject a table missing the default role", () => {
    const { default: _omitted, ...withoutDefault } = fixtureTable;
    expect(RoleModelTableSchema.safeParse(withoutDefault).success).toBe(false);
  });

  it("should reject a table with extra keys", () => {
    expect(RoleModelTableSchema.safeParse({ ...fixtureTable, fast: "openai/gpt-6" }).success).toBe(false);
  });
});

describe("role model router resolve", () => {
  it("should return the mapped model id for the default role", () => {
    expect(resolve("default", fixtureTable)).toBe("anthropic/claude-sonnet-5");
  });

  it("should return the mapped model id for the smol role", () => {
    expect(resolve("smol", fixtureTable)).toBe("anthropic/claude-haiku-5");
  });

  it("should return the mapped model id for the slow role", () => {
    expect(resolve("slow", fixtureTable)).toBe("anthropic/claude-opus-5");
  });

  it("should return the mapped model id for the plan role", () => {
    expect(resolve("plan", fixtureTable)).toBe("openai/gpt-6-plan");
  });

  it("should return the mapped model id for the commit role", () => {
    expect(resolve("commit", fixtureTable)).toBe("openai/gpt-6-mini");
  });

  it("should fall back to the default model id for unknown roles", () => {
    expect(resolve("fast", fixtureTable)).toBe(fixtureTable.default);
    expect(resolve("banana", fixtureTable)).toBe(fixtureTable.default);
    expect(resolve("", fixtureTable)).toBe(fixtureTable.default);
  });

  it("should throw a clear error when the table is invalid", () => {
    const invalidTable = { ...fixtureTable, default: "" };
    expect(() => resolve("smol", invalidTable as RoleModelTable)).toThrow(/roleModelRouter/);
    expect(() => resolve("smol", invalidTable as RoleModelTable)).toThrow(/default/);
  });
});
