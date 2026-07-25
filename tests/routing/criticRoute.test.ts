import { describe, expect, it } from "vitest";

import {
  CRITIC_ROLES,
  CriticRouteConfigSchema,
  RouteRefSchema,
  isCriticRole,
  isSameRoute,
  resolveCriticRoute
} from "../../src/routing/criticRoute.js";

describe("critic roles", () => {
  it("review and verifier are critic roles; author-side roles are not", () => {
    expect(CRITIC_ROLES).toEqual(["review", "verifier"]);
    expect(isCriticRole("review")).toBe(true);
    expect(isCriticRole("verifier")).toBe(true);
    expect(isCriticRole("author")).toBe(false);
    expect(isCriticRole("scout")).toBe(false);
    expect(isCriticRole("")).toBe(false);
  });
});

describe("RouteRefSchema", () => {
  it("accepts a routeId alone", () => {
    expect(RouteRefSchema.parse({ routeId: "router-claude-opus-4-8" })).toEqual({ routeId: "router-claude-opus-4-8" });
  });

  it("accepts a provider/model pair alone", () => {
    expect(RouteRefSchema.parse({ provider: "anthropic", model: "claude-opus-4-8" })).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8"
    });
  });

  it("rejects a bare provider without a model", () => {
    expect(() => RouteRefSchema.parse({ provider: "anthropic" })).toThrow();
  });

  it("rejects an empty ref", () => {
    expect(() => RouteRefSchema.parse({})).toThrow();
  });
});

describe("isSameRoute", () => {
  it("same routeId is the same route", () => {
    expect(isSameRoute({ routeId: "router-kimi" }, { routeId: "router-kimi" })).toBe(true);
  });

  it("same provider+model is the same route", () => {
    expect(isSameRoute({ provider: "anthropic", model: "opus" }, { provider: "anthropic", model: "opus" })).toBe(true);
  });

  it("same provider but different model is NOT the same route", () => {
    expect(isSameRoute({ provider: "anthropic", model: "opus" }, { provider: "anthropic", model: "sonnet" })).toBe(false);
  });

  it("mixed forms (routeId vs provider/model) are not provably same", () => {
    expect(isSameRoute({ routeId: "router-kimi" }, { provider: "moonshot", model: "kimi" })).toBe(false);
  });

  it("matching routeId wins even when provider/model detail differs", () => {
    expect(
      isSameRoute(
        { routeId: "router-kimi", provider: "a", model: "x" },
        { routeId: "router-kimi", provider: "b", model: "y" }
      )
    ).toBe(true);
  });
});

describe("resolveCriticRoute — fail closed when missing", () => {
  it("denies with critic_route_missing when no route is configured", () => {
    const decision = resolveCriticRoute({
      config: {},
      authorRoute: { routeId: "router-kimi" }
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.code).toBe("critic_route_missing");
      expect(decision.escalateToOperator).toBe(true);
    }
  });

  it("denies with critic_route_invalid on a malformed config instead of throwing", () => {
    const decision = resolveCriticRoute({
      config: { route: { provider: "anthropic" }, policy: "require_distinct" },
      authorRoute: { routeId: "router-kimi" }
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.code).toBe("critic_route_invalid");
      expect(decision.escalateToOperator).toBe(true);
    }
  });
});

describe("resolveCriticRoute — same-route rejection", () => {
  it("require_distinct rejects critic_route == author_route (routeId form)", () => {
    const decision = resolveCriticRoute({
      config: { route: { routeId: "router-kimi" }, policy: "require_distinct" },
      authorRoute: { routeId: "router-kimi" }
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.code).toBe("critic_route_same_as_author");
      expect(decision.escalateToOperator).toBe(true);
    }
  });

  it("require_distinct rejects critic_route == author_route (provider/model form)", () => {
    const decision = resolveCriticRoute({
      config: { route: { provider: "anthropic", model: "claude-opus-4-8" }, policy: "require_distinct" },
      authorRoute: { provider: "anthropic", model: "claude-opus-4-8" }
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.code).toBe("critic_route_same_as_author");
    }
  });

  it("prefer_distinct accepts a same-route config but warns about weakened independence", () => {
    const decision = resolveCriticRoute({
      config: { route: { routeId: "router-kimi" }, policy: "prefer_distinct" },
      authorRoute: { routeId: "router-kimi" }
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.route).toEqual({ routeId: "router-kimi" });
      expect(decision.warnings.length).toBe(1);
      expect(decision.warnings[0]).toContain("prefer_distinct");
    }
  });
});

describe("resolveCriticRoute — distinct acceptance", () => {
  it("require_distinct accepts a distinct routeId", () => {
    const decision = resolveCriticRoute({
      config: { route: { routeId: "router-claude-opus-4-8" }, policy: "require_distinct" },
      authorRoute: { routeId: "router-kimi" }
    });
    expect(decision).toEqual({ ok: true, route: { routeId: "router-claude-opus-4-8" }, warnings: [] });
  });

  it("require_distinct accepts a distinct provider/model pair", () => {
    const decision = resolveCriticRoute({
      config: { route: { provider: "anthropic", model: "claude-opus-4-8" }, policy: "require_distinct" },
      authorRoute: { provider: "moonshot", model: "kimi-k3" }
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.route).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
      expect(decision.warnings).toEqual([]);
    }
  });

  it("require_distinct accepts same provider with a different model", () => {
    const decision = resolveCriticRoute({
      config: { route: { provider: "anthropic", model: "claude-sonnet-4-6" }, policy: "require_distinct" },
      authorRoute: { provider: "anthropic", model: "claude-opus-4-8" }
    });
    expect(decision.ok).toBe(true);
  });

  it("defaults to prefer_distinct when policy is omitted", () => {
    const decision = resolveCriticRoute({
      config: { route: { routeId: "router-kimi" } },
      authorRoute: { routeId: "router-kimi" }
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.warnings.length).toBe(1);
    }
  });
});

describe("CriticRouteConfigSchema", () => {
  it("round-trips a full config", () => {
    const config = CriticRouteConfigSchema.parse({
      route: { routeId: "router-glm-5-2" },
      policy: "require_distinct"
    });
    expect(config.route?.routeId).toBe("router-glm-5-2");
    expect(config.policy).toBe("require_distinct");
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => CriticRouteConfigSchema.parse({ route: { routeId: "x" }, bogus: true })).toThrow();
  });
});
