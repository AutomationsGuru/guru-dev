import { describe, expect, it } from "vitest";

import {
  RoleRuntimeMapSchema,
  resolveRoleRuntime,
  type RuntimeSlot,
  type RoleRuntimeMap
} from '../../src/fleet/roleRuntimeMap.js';

/**
 * Role runtime map (F308 / R-TT-ROLE-RT) — the fleet's role→runtime resolver.
 *
 * Config maps role ids → runtime/provider slots; an agent resolves its role and
 * then applies per-agent overrides. Unknown roles FAIL CLOSED (no silent
 * default-on runtime). This test holds that contract.
 */
function makeSlot(overrides: Partial<RuntimeSlot> = {}): RuntimeSlot {
  return {
    runtime: "session",
    providerId: "openai",
    routeId: "openai/gpt-4o-mini",
    ...overrides
  };
}

function makeMap(entries: Record<string, RuntimeSlot>): RoleRuntimeMap {
  return RoleRuntimeMapSchema.parse({ roles: entries });
}

describe("RoleRuntimeMapSchema — validation", () => {
  it("accepts a map of role id → runtime slot", () => {
    const map = makeMap({ finance: makeSlot() });
    expect(map.roles["finance"]).toEqual(makeSlot());
  });

  it("requires a non-empty runtime per slot", () => {
    expect(() => makeMap({ finance: makeSlot({ runtime: "" }) })).toThrow();
  });
});

describe("resolveRoleRuntime — role maps to a runtime/provider slot", () => {
  it("returns the configured slot for a known role", () => {
    const map = makeMap({
      finance: makeSlot({ runtime: "session", providerId: "anthropic", routeId: "anthropic/claude" })
    });

    const resolved = resolveRoleRuntime(map, "finance");

    expect(resolved.roleId).toBe("finance");
    expect(resolved.runtime).toBe("session");
    expect(resolved.providerId).toBe("anthropic");
    expect(resolved.routeId).toBe("anthropic/claude");
  });

  it("returns a defensive copy (callers cannot mutate the map)", () => {
    const map = makeMap({ finance: makeSlot({ providerId: "openai" }) });

    const resolved = resolveRoleRuntime(map, "finance");
    resolved.providerId = "anthropic";

    expect(map.roles["finance"]?.providerId).toBe("openai");
  });
});

describe("resolveRoleRuntime — unknown role fails closed", () => {
  it("throws when the role id is not in the map", () => {
    const map = makeMap({ finance: makeSlot() });

    expect(() => resolveRoleRuntime(map, "unknown-role")).toThrow(/unknown-role/iu);
  });

  it("never falls back to an implicit default slot", () => {
    const map = makeMap({ finance: makeSlot({ providerId: "openai" }) });

    // An empty overrides object must NOT paper over a missing role.
    expect(() => resolveRoleRuntime(map, "ghost", {})).toThrow();
  });
});

describe("resolveRoleRuntime — per-agent override wins", () => {
  it("a matching override replaces the configured slot entirely", () => {
    const map = makeMap({ finance: makeSlot({ providerId: "openai", routeId: "openai/gpt" }) });

    const resolved = resolveRoleRuntime(map, "finance", {
      finance: makeSlot({ providerId: "anthropic", routeId: "anthropic/claude" })
    });

    expect(resolved.providerId).toBe("anthropic");
    expect(resolved.routeId).toBe("anthropic/claude");
  });

  it("overrides for OTHER roles do not affect the resolved role", () => {
    const map = makeMap({ finance: makeSlot({ providerId: "openai" }) });

    const resolved = resolveRoleRuntime(map, "finance", {
      ops: makeSlot({ providerId: "anthropic" })
    });

    expect(resolved.providerId).toBe("openai");
  });

  it("an override CANNOT promote an unknown role to a known one (still fails closed)", () => {
    const map = makeMap({ finance: makeSlot() });

    expect(() =>
      resolveRoleRuntime(map, "ghost", { ghost: makeSlot({ providerId: "ollama" }) })
    ).toThrow(/ghost/iu);
  });
});
