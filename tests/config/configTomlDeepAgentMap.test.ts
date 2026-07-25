import {
  mapDeepAgentConfigToml,
  safeMapDeepAgentConfigToml,
} from '../../src/config/configTomlDeepAgentMap.js';

describe("mapDeepAgentConfigToml", () => {
  // -----------------------------------------------------------------------
  // model
  // -----------------------------------------------------------------------

  it("maps model → plannerModel.model with safe provider defaults", () => {
    const result = mapDeepAgentConfigToml({ model: "claude-sonnet-5" });

    expect(result.parsed.model).toBe("claude-sonnet-5");
    expect(result.overlay.plannerModel).toMatchObject({
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "claude-sonnet-5",
      apiKeyEnvVar: "OPENAI_API_KEY",
      timeoutMs: 120_000,
      temperature: 0,
    });
    expect(result.mapped).toContain("model");
    expect(result.unrecognized).toEqual([]);
  });

  it("trims whitespace from model", () => {
    const result = mapDeepAgentConfigToml({ model: "  gpt-5.5  " });
    expect(result.parsed.model).toBe("gpt-5.5");
    expect(result.overlay.plannerModel!.model).toBe("gpt-5.5");
  });

  it("leaves plannerModel undefined when model is absent", () => {
    const result = mapDeepAgentConfigToml({});
    expect(result.parsed.model).toBeUndefined();
    expect(result.overlay.plannerModel).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // sandbox
  // -----------------------------------------------------------------------

  it("maps sandbox.enabled=true → swarm.ultraSwarm=true with raised concurrency", () => {
    const result = mapDeepAgentConfigToml({
      sandbox: { enabled: true },
    });

    expect(result.parsed.sandbox).toEqual({ enabled: true });
    expect(result.overlay.swarm).toMatchObject({
      ultraSwarm: true,
      maxConcurrentWorkers: 8,
    });
    expect(result.mapped).toContain("sandbox");
  });

  it("maps sandbox.enabled=false → swarm.ultraSwarm=false, no concurrency bump", () => {
    const result = mapDeepAgentConfigToml({
      sandbox: { enabled: false },
    });

    expect(result.overlay.swarm).toMatchObject({
      ultraSwarm: false,
    });
    // maxConcurrentWorkers should not be present (stays at default)
    expect((result.overlay.swarm as any)?.maxConcurrentWorkers).toBeUndefined();
  });

  it("records sandbox provider in parsed; swarm overlay is a no-op without enabled", () => {
    const result = mapDeepAgentConfigToml({
      sandbox: { provider: "daytona" },
    });

    expect(result.parsed.sandbox).toEqual({ provider: "daytona" });
    // Provider-only (no enabled): ultraSwarm defaults to false — a no-op.
    // Provider is informational only — overlay.swarm has no provider field.
    expect(result.overlay.swarm).toEqual({ ultraSwarm: false });
  });

  it("maps sandbox with both enabled and provider", () => {
    const result = mapDeepAgentConfigToml({
      sandbox: { enabled: true, provider: "modal" },
    });

    expect(result.parsed.sandbox).toEqual({ enabled: true, provider: "modal" });
    expect(result.overlay.swarm).toMatchObject({
      ultraSwarm: true,
      maxConcurrentWorkers: 8,
    });
  });

  // -----------------------------------------------------------------------
  // combined model + sandbox
  // -----------------------------------------------------------------------

  it("maps both model and sandbox together", () => {
    const result = mapDeepAgentConfigToml({
      model: "claude-opus-4-8",
      sandbox: { enabled: true, provider: "daytona" },
    });

    expect(result.mapped).toEqual(["model", "sandbox"]);
    expect(result.overlay.plannerModel!.model).toBe("claude-opus-4-8");
    expect(result.overlay.swarm!.ultraSwarm).toBe(true);
  });

  // -----------------------------------------------------------------------
  // unrecognized keys
  // -----------------------------------------------------------------------

  it("reports unrecognized keys without rejecting them", () => {
    const result = mapDeepAgentConfigToml({
      model: "gpt-5.5",
      unknown_key: "value",
      another: 42,
    });

    expect(result.unrecognized).toEqual(["unknown_key", "another"]);
    expect(result.mapped).toEqual(["model"]);
    expect(result.parsed.model).toBe("gpt-5.5");
  });

  it("returns empty unrecognized when all keys are known", () => {
    const result = mapDeepAgentConfigToml({
      model: "claude-sonnet-5",
      sandbox: { enabled: false },
    });

    expect(result.unrecognized).toEqual([]);
    expect(result.mapped).toEqual(["model", "sandbox"]);
  });

  // -----------------------------------------------------------------------
  // edge cases / empty
  // -----------------------------------------------------------------------

  it("accepts an empty object — nothing mapped", () => {
    const result = mapDeepAgentConfigToml({});

    expect(result.parsed).toEqual({});
    expect(result.overlay).toEqual({});
    expect(result.mapped).toEqual([]);
    expect(result.unrecognized).toEqual([]);
  });

  it("accepts sandbox with no inner fields (present but empty)", () => {
    const result = mapDeepAgentConfigToml({ sandbox: {} });

    expect(result.parsed.sandbox).toBeUndefined();
    expect(result.overlay).toEqual({});
    expect(result.mapped).toContain("sandbox");
  });
});

// ===========================================================================
// Error cases — mapDeepAgentConfigToml throws
// ===========================================================================

describe("mapDeepAgentConfigToml errors", () => {
  it("throws on null input", () => {
    expect(() => mapDeepAgentConfigToml(null)).toThrow("non-null object");
  });

  it("throws on undefined input", () => {
    expect(() => mapDeepAgentConfigToml(undefined)).toThrow("non-null object");
  });

  it("throws on non-object input", () => {
    expect(() => mapDeepAgentConfigToml("a string")).toThrow("Expected an object");
    expect(() => mapDeepAgentConfigToml(42)).toThrow("Expected an object");
    expect(() => mapDeepAgentConfigToml(true)).toThrow("Expected an object");
  });

  it("throws on non-string model", () => {
    expect(() => mapDeepAgentConfigToml({ model: 123 })).toThrow(
      "model must be a non-empty string"
    );
  });

  it("throws on empty-string model", () => {
    expect(() => mapDeepAgentConfigToml({ model: "" })).toThrow(
      "model must be a non-empty string"
    );
    expect(() => mapDeepAgentConfigToml({ model: "   " })).toThrow(
      "model must be a non-empty string"
    );
  });

  it("throws on non-object sandbox", () => {
    expect(() => mapDeepAgentConfigToml({ sandbox: "daytona" })).toThrow(
      "sandbox must be an object"
    );
    expect(() => mapDeepAgentConfigToml({ sandbox: null })).toThrow(
      "sandbox must be an object"
    );
  });

  it("throws on non-boolean sandbox.enabled", () => {
    expect(() =>
      mapDeepAgentConfigToml({ sandbox: { enabled: "yes" } })
    ).toThrow("sandbox.enabled must be a boolean");
  });

  it("throws on non-string sandbox.provider", () => {
    expect(() =>
      mapDeepAgentConfigToml({ sandbox: { provider: 42 } })
    ).toThrow("sandbox.provider must be a non-empty string");
  });

  it("throws on empty-string sandbox.provider", () => {
    expect(() =>
      mapDeepAgentConfigToml({ sandbox: { provider: "  " } })
    ).toThrow("sandbox.provider must be a non-empty string");
  });
});

// ===========================================================================
// safeMapDeepAgentConfigToml — never-throw wrapper
// ===========================================================================

describe("safeMapDeepAgentConfigToml", () => {
  it("returns ok with result on valid input", () => {
    const outcome = safeMapDeepAgentConfigToml({ model: "claude-sonnet-5" });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.parsed.model).toBe("claude-sonnet-5");
    }
  });

  it("returns ok=false with error message on invalid input (never throws)", () => {
    const outcome = safeMapDeepAgentConfigToml(null);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("Invalid deepagent config.toml");
      expect(outcome.error).toContain("non-null object");
    }
  });

  it("returns ok=false on bad model type", () => {
    const outcome = safeMapDeepAgentConfigToml({ model: 99 });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("model must be a non-empty string");
    }
  });

  it("returns ok=false on bad sandbox type", () => {
    const outcome = safeMapDeepAgentConfigToml({ sandbox: "not-an-object" });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("sandbox must be an object");
    }
  });
});