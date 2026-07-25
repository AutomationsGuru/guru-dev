import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_ROLE_PACK_ID,
  dailyDriverPack,
  parseModelRolePackConfig,
  resolveActivePack,
  resolveRoleModel
} from '../../src/routing/modelRolePack.js';
import { MODEL_ROLE_PACK_ROLES, ModelRolePackConfigSchema } from '../../src/routing/modelRolePackSchema.js';

const DEFAULT_MODEL = "router-claude-sonnet-4-6";

describe("model role pack schema", () => {
  it("should cover the plan's role set", () => {
    expect(MODEL_ROLE_PACK_ROLES).toEqual([
      "planner",
      "architect",
      "coder",
      "builder",
      "wholeFileBuilder",
      "summarizer",
      "critic",
      "adversary",
      "autoContinue",
      "commitMessages"
    ]);
  });

  it("should parse an empty config to the inert default (no packs, no active pack)", () => {
    expect(parseModelRolePackConfig(undefined)).toEqual({ packs: [] });
    expect(parseModelRolePackConfig({})).toEqual({ packs: [] });
  });

  it("should accept a pack with per-role primary and optional fallbacks", () => {
    const parsed = parseModelRolePackConfig({
      activePack: "cost-saver",
      packs: [
        {
          id: "cost-saver",
          roles: {
            planner: { model: "router-openai-gpt-5-5", strongModel: "router-openai-gpt-5-5-pro" },
            summarizer: { model: "router-haiku", largeContextFallback: "router-gemini-3-1-pro" }
          }
        }
      ]
    });
    expect(parsed.activePack).toBe("cost-saver");
    expect(parsed.packs).toHaveLength(1);
    expect(parsed.packs[0]?.roles.planner?.model).toBe("router-openai-gpt-5-5");
    expect(parsed.packs[0]?.roles.summarizer?.largeContextFallback).toBe("router-gemini-3-1-pro");
  });

  it("should reject an unknown role key at the config boundary", () => {
    expect(() =>
      ModelRolePackConfigSchema.parse({
        packs: [{ id: "bad", roles: { notARealRole: { model: "router-x" } } }]
      })
    ).toThrow();
  });

  it("should reject a binding without a primary model", () => {
    expect(() => ModelRolePackConfigSchema.parse({ packs: [{ id: "bad", roles: { coder: {} } }] })).toThrow();
  });

  it("should reject unknown top-level config keys (strict)", () => {
    expect(() => ModelRolePackConfigSchema.parse({ packs: [], surprise: true })).toThrow();
  });
});

describe("resolveActivePack", () => {
  it("should return the built-in daily-driver identity pack when no config is given", () => {
    expect(resolveActivePack(undefined)).toEqual(dailyDriverPack());
    expect(resolveActivePack(undefined).id).toBe(DEFAULT_MODEL_ROLE_PACK_ID);
  });

  it("should select the configured active pack by id", () => {
    const pack = resolveActivePack({
      activePack: "power",
      packs: [{ id: "power", roles: { coder: { model: "router-opus" } } }]
    });
    expect(pack.id).toBe("power");
    expect(pack.roles.coder?.model).toBe("router-opus");
  });

  it("should fall back to the identity pack when activePack names an unknown id", () => {
    const pack = resolveActivePack({
      activePack: "missing",
      packs: [{ id: "power", roles: { coder: { model: "router-opus" } } }]
    });
    expect(pack).toEqual(dailyDriverPack());
  });
});

describe("resolveRoleModel — default identity (no behavior change)", () => {
  it("should resolve every role to the session default when no config is given", () => {
    for (const role of MODEL_ROLE_PACK_ROLES) {
      const resolved = resolveRoleModel(role, DEFAULT_MODEL);
      expect(resolved).toEqual({ role, model: DEFAULT_MODEL, source: "default", packId: DEFAULT_MODEL_ROLE_PACK_ID });
    }
  });

  it("should resolve every role to the session default under the built-in daily-driver pack", () => {
    const config = { activePack: DEFAULT_MODEL_ROLE_PACK_ID, packs: [dailyDriverPack()] };
    for (const role of MODEL_ROLE_PACK_ROLES) {
      expect(resolveRoleModel(role, DEFAULT_MODEL, config).model).toBe(DEFAULT_MODEL);
    }
  });

  it("should resolve roles a custom pack does not bind to the session default", () => {
    const config = { activePack: "power", packs: [{ id: "power", roles: { coder: { model: "router-opus" } } }] };
    const resolved = resolveRoleModel("summarizer", DEFAULT_MODEL, config);
    expect(resolved).toEqual({ role: "summarizer", model: DEFAULT_MODEL, source: "default", packId: "power" });
  });
});

describe("resolveRoleModel — pack routing", () => {
  const config = {
    activePack: "mixed",
    packs: [
      {
        id: "mixed",
        roles: {
          planner: { model: "router-openai-gpt-5-5", strongModel: "router-openai-gpt-5-5-pro" },
          coder: { model: "router-deepseek" },
          summarizer: { model: "router-haiku", largeContextFallback: "router-gemini-3-1-pro" }
        }
      }
    ]
  };

  it("should route a bound role to its primary model", () => {
    const resolved = resolveRoleModel("coder", DEFAULT_MODEL, config);
    expect(resolved).toEqual({ role: "coder", model: "router-deepseek", source: "primary", packId: "mixed" });
  });

  it("should use the large-context fallback only when context exceeds the threshold", () => {
    const under = resolveRoleModel("summarizer", DEFAULT_MODEL, config, {
      contextTokens: 100_000,
      largeContextThresholdTokens: 120_000
    });
    expect(under).toMatchObject({ model: "router-haiku", source: "primary" });

    const over = resolveRoleModel("summarizer", DEFAULT_MODEL, config, {
      contextTokens: 150_000,
      largeContextThresholdTokens: 120_000
    });
    expect(over).toMatchObject({ model: "router-gemini-3-1-pro", source: "largeContextFallback" });
  });

  it("should not apply the fallback when context size is unknown", () => {
    const resolved = resolveRoleModel("summarizer", DEFAULT_MODEL, config, { largeContextThresholdTokens: 120_000 });
    expect(resolved).toMatchObject({ model: "router-haiku", source: "primary" });
  });

  it("should never fall back when the binding declares no large-context fallback", () => {
    const resolved = resolveRoleModel("coder", DEFAULT_MODEL, config, {
      contextTokens: 900_000,
      largeContextThresholdTokens: 1
    });
    expect(resolved).toMatchObject({ model: "router-deepseek", source: "primary" });
  });

  it("should switch routing when the active pack changes (same role, different pack)", () => {
    const multi = {
      activePack: "b",
      packs: [
        { id: "a", roles: { critic: { model: "router-haiku" } } },
        { id: "b", roles: { critic: { model: "router-opus" } } }
      ]
    };
    expect(resolveRoleModel("critic", DEFAULT_MODEL, multi)).toMatchObject({ model: "router-opus", packId: "b" });
    expect(resolveRoleModel("critic", DEFAULT_MODEL, { ...multi, activePack: "a" })).toMatchObject({
      model: "router-haiku",
      packId: "a"
    });
  });

  it("should expose the strong model in the parsed binding without hijacking resolution", () => {
    const parsed = parseModelRolePackConfig(config);
    expect(parsed.packs[0]?.roles.planner?.strongModel).toBe("router-openai-gpt-5-5-pro");
    expect(resolveRoleModel("planner", DEFAULT_MODEL, config)).toMatchObject({
      model: "router-openai-gpt-5-5",
      source: "primary"
    });
  });
});
