import { describe, expect, it } from "vitest";

import {
  DEFAULT_APPLY_MODEL_REF,
  resolveSurfaceModelRef
} from '../../src/routing/surfaceModelRoles.js';
import {
  ModelRefSchema,
  SurfaceModelRolesConfigSchema,
  SurfaceRoleSchema
} from '../../src/routing/surfaceModelRolesSchema.js';

describe("SurfaceRoleSchema", () => {
  it("should accept exactly the four surface roles", () => {
    expect(SurfaceRoleSchema.parse("chat")).toBe("chat");
    expect(SurfaceRoleSchema.parse("edit")).toBe("edit");
    expect(SurfaceRoleSchema.parse("apply")).toBe("apply");
    expect(SurfaceRoleSchema.parse("agent")).toBe("agent");
  });

  it("should reject unknown surface roles", () => {
    expect(SurfaceRoleSchema.safeParse("planner").success).toBe(false);
    expect(SurfaceRoleSchema.safeParse("coder").success).toBe(false);
  });
});

describe("ModelRefSchema", () => {
  it("should trim surrounding whitespace from a model ref", () => {
    expect(ModelRefSchema.parse("  router-gemini-flash  ")).toBe("router-gemini-flash");
  });

  it("should reject empty and whitespace-only model refs", () => {
    expect(ModelRefSchema.safeParse("").success).toBe(false);
    expect(ModelRefSchema.safeParse("   ").success).toBe(false);
  });
});

describe("SurfaceModelRolesConfigSchema", () => {
  it("should parse a full config with per-role refs and a default", () => {
    const parsed = SurfaceModelRolesConfigSchema.parse({
      chat: "router-gemini-flash",
      edit: "router-claude-sonnet-4-6",
      apply: "router-foundry-fast",
      agent: "router-claude-opus-4-8",
      default: "router-gemini-flash"
    });

    expect(parsed).toEqual({
      chat: "router-gemini-flash",
      edit: "router-claude-sonnet-4-6",
      apply: "router-foundry-fast",
      agent: "router-claude-opus-4-8",
      default: "router-gemini-flash"
    });
  });

  it("should parse an empty config with all roles unset", () => {
    expect(SurfaceModelRolesConfigSchema.parse({})).toEqual({});
  });

  it("should reject empty-string model refs", () => {
    expect(SurfaceModelRolesConfigSchema.safeParse({ chat: "" }).success).toBe(false);
    expect(SurfaceModelRolesConfigSchema.safeParse({ default: "   " }).success).toBe(false);
  });

  it("should reject unknown keys under strict parsing", () => {
    const result = SurfaceModelRolesConfigSchema.safeParse({ planner: "router-kimi" });

    expect(result.success).toBe(false);
  });
});

describe("resolveSurfaceModelRef", () => {
  it("should resolve the explicit per-role ref for all four roles", () => {
    const config = SurfaceModelRolesConfigSchema.parse({
      chat: "router-gemini-flash",
      edit: "router-claude-sonnet-4-6",
      apply: "router-foundry-fast",
      agent: "router-claude-opus-4-8"
    });

    expect(resolveSurfaceModelRef(config, "chat")).toBe("router-gemini-flash");
    expect(resolveSurfaceModelRef(config, "edit")).toBe("router-claude-sonnet-4-6");
    expect(resolveSurfaceModelRef(config, "apply")).toBe("router-foundry-fast");
    expect(resolveSurfaceModelRef(config, "agent")).toBe("router-claude-opus-4-8");
  });

  it("should fall back to config.default when the role is unset", () => {
    const config = SurfaceModelRolesConfigSchema.parse({ default: "router-gemini-flash" });

    expect(resolveSurfaceModelRef(config, "chat")).toBe("router-gemini-flash");
    expect(resolveSurfaceModelRef(config, "edit")).toBe("router-gemini-flash");
    expect(resolveSurfaceModelRef(config, "apply")).toBe("router-gemini-flash");
    expect(resolveSurfaceModelRef(config, "agent")).toBe("router-gemini-flash");
  });

  it("should fall back to DEFAULT_APPLY_MODEL_REF for apply when neither apply nor default is set", () => {
    const config = SurfaceModelRolesConfigSchema.parse({ chat: "router-gemini-flash" });

    expect(resolveSurfaceModelRef(config, "apply")).toBe(DEFAULT_APPLY_MODEL_REF);
    expect(resolveSurfaceModelRef(undefined, "apply")).toBe(DEFAULT_APPLY_MODEL_REF);
  });

  it("should throw a descriptive error when the role is missing and no default is configured", () => {
    const config = SurfaceModelRolesConfigSchema.parse({});

    expect(() => resolveSurfaceModelRef(config, "chat")).toThrow(/chat/u);
    expect(() => resolveSurfaceModelRef(config, "chat")).toThrow(/default/u);
    expect(() => resolveSurfaceModelRef(undefined, "agent")).toThrow(/agent/u);
  });
});
