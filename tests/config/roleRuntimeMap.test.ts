import { describe, it, expect } from "vitest";
import { resolveRoleRuntime } from '../../src/config/roleRuntimeMap.js';

describe("roleRuntimeMap", () => {
  it("resolves a known role to its declared runtime", () => {
    expect(resolveRoleRuntime("builder")).toBe("cli");
    expect(resolveRoleRuntime("coordinator")).toBe("cli");
  });

  it("throws on unknown role (fails closed)", () => {
    expect(() => resolveRoleRuntime("unknown-role-xyz-123")).toThrow(
      /Unknown role "unknown-role-xyz-123"/
    );
  });

  it("rejects empty or malformed role ids gracefully via throw", () => {
    expect(() => resolveRoleRuntime("")).toThrow(/Unknown role/);
    expect(() => resolveRoleRuntime("   ")).toThrow(/Unknown role/);
  });
});
