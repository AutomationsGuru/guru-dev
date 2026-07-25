import { describe, expect, it, vi } from "vitest";

import {
  switchProtocol,
  type ModelRoute,
  type Protocol,
  type SwitchDeps,
} from '../../src/routing/protocolSwitch.js';

const route: ModelRoute = {
  id: "logical-model",
  provider: "multi-protocol-provider",
  model: "logical-model-v1",
  protocol: "openai-compat",
};

function makeDeps(overrides: Partial<SwitchDeps> = {}): SwitchDeps {
  return {
    getRoute: (routeId) => (routeId === route.id ? route : undefined),
    getSupportedProtocols: () => ["openai-compat", "anthropic", "gemini-shape"],
    ...overrides,
  };
}

describe("switchProtocol", () => {
  it("switches a logical route to a supported protocol and records it", () => {
    const setRouteProtocol = vi.fn();

    const result = switchProtocol(
      route.id,
      "anthropic",
      makeDeps({ setRouteProtocol }),
    );

    expect(result).toMatchObject({
      success: true,
      routeId: route.id,
      fromProtocol: "openai-compat",
      toProtocol: "anthropic",
      protocol: "anthropic",
    });
    expect(result.timestamp).toEqual(expect.any(String));
    expect(setRouteProtocol).toHaveBeenCalledWith(route.id, "anthropic");
  });

  it("rejects an unsupported protocol before mutating the route", () => {
    const setRouteProtocol = vi.fn();
    const result = switchProtocol(
      route.id,
      "gemini-shape",
      makeDeps({
        getSupportedProtocols: () => ["openai-compat", "anthropic"],
        setRouteProtocol,
      }),
    );

    expect(result).toMatchObject({
      success: false,
      routeId: route.id,
      fromProtocol: "openai-compat",
      toProtocol: "gemini-shape",
      protocol: "gemini-shape",
    });
    expect(result.error).toMatch(/not supported/i);
    expect(setRouteProtocol).not.toHaveBeenCalled();
  });

  it("preserves the active session id for transcript continuity", () => {
    const result = switchProtocol(
      route.id,
      "anthropic",
      makeDeps({ sessionId: "session-70" }),
    );

    expect(result.sessionId).toBe("session-70");
    expect(result.protocol).toBe("anthropic");
  });

  it("supports the F70 preserveSessionId composition name", () => {
    const result = switchProtocol(
      route.id,
      "gemini-shape",
      makeDeps({ preserveSessionId: "session-70-legacy" }),
    );

    expect(result.sessionId).toBe("session-70-legacy");
  });

  it("returns a failure receipt for an unknown route without mutation", () => {
    const setRouteProtocol = vi.fn();
    const result = switchProtocol(
      "missing-route",
      "anthropic",
      makeDeps({ setRouteProtocol }),
    );

    expect(result).toMatchObject({
      success: false,
      routeId: "missing-route",
      protocol: "anthropic",
    });
    expect(result.error).toContain("Route not found");
    expect(setRouteProtocol).not.toHaveBeenCalled();
  });

  it("returns a failure receipt when the registry mutation fails", () => {
    const result = switchProtocol(
      route.id,
      "anthropic",
      makeDeps({
        setRouteProtocol: () => {
          throw new Error("route is locked");
        },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("route is locked");
  });

  it("does not allocate a new session when switching protocols", () => {
    const result = switchProtocol(
      route.id,
      "openai-compat" as Protocol,
      makeDeps({ sessionId: "existing-session" }),
    );

    expect(result.sessionId).toBe("existing-session");
    expect(result.fromProtocol).toBe("openai-compat");
    expect(result.toProtocol).toBe("openai-compat");
  });
});
