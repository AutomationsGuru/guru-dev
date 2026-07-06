import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseLiteLlmConfigYaml, validateLiteLlmBaseline } from "../../src/router/configParser.js";
import { LITELLM_BASELINE_ALIASES, LITELLM_PROVIDER_GROUPS } from "../../src/router/schemas.js";

const fixturePath = join(process.cwd(), "tests", "fixtures", "litellm.config.yaml");

describe("parseLiteLlmConfigYaml", () => {
  it("should parse the sanitized LiteLLM fixture into the 37 alias / 10 group baseline", () => {
    const manifest = parseLiteLlmConfigYaml(readFileSync(fixturePath, "utf8"));

    expect(manifest.aliases).toHaveLength(37);
    expect(manifest.providerGroups).toHaveLength(10);
    expect(manifest.baseline).toMatchObject({
      expectedAliasCount: 37,
      expectedProviderGroupCount: 10,
      aliasCount: 37,
      providerGroupCount: 10,
      missingAliases: [],
      extraAliases: [],
      missingProviderGroups: [],
      extraProviderGroups: [],
      verdict: "GREEN"
    });
    expect(manifest.aliases.map((alias) => alias.alias).sort()).toEqual([...LITELLM_BASELINE_ALIASES].sort());
    expect(manifest.providerGroups.sort()).toEqual([...LITELLM_PROVIDER_GROUPS].sort());
  });

  it("should extract model, provider group, api_base, and env-var names without values", () => {
    const manifest = parseLiteLlmConfigYaml(readFileSync(fixturePath, "utf8"));
    const openai = manifest.aliases.find((alias) => alias.alias === "router-openai-gpt-5-5");
    const foundry = manifest.aliases.find((alias) => alias.alias === "router-foundry-pro");

    expect(openai).toMatchObject({
      alias: "router-openai-gpt-5-5",
      providerGroup: "openai-platform",
      provider: "openai",
      model: "openai/gpt-5.5",
      apiBase: "https://api.openai.com/v1",
      credentialEnvVarNames: ["OPENAI_API_KEY"],
      metadata: { router_aliases: ["router-openai-gpt-5-5"] }
    });
    expect(foundry).toMatchObject({
      alias: "router-foundry-pro",
      providerGroup: "azure-foundry",
      apiBaseEnvVarNames: ["AZURE_FOUNDRY_API_BASE"],
      credentialEnvVarNames: ["AZURE_FOUNDRY_API_KEY"]
    });
    expect(JSON.stringify(manifest)).not.toContain("sk-");
  });

  it("should preserve aggregate metadata.router_aliases for downstream parity manifests", () => {
    const manifest = parseLiteLlmConfigYaml(readFileSync(fixturePath, "utf8"));

    expect(manifest.metadata.router_aliases).toHaveLength(37);
    expect(manifest.metadata.router_aliases).toContain("router-minimax-codex");
    expect(manifest.metadata.router_aliases).toContain("router-vertex-claude-sonnet-4-6");
  });

  it("should report RED when a baseline alias is missing", () => {
    const fixture = readFileSync(fixturePath, "utf8");
    const manifest = parseLiteLlmConfigYaml(removeFixtureEntry(fixture, "router-opus"));

    expect(manifest.baseline.verdict).toBe("RED");
    expect(manifest.baseline.missingAliases).toContain("router-opus");
  });

  it("should reject duplicate aliases instead of silently overwriting routes", () => {
    const duplicate = `model_list:\n  - model_name: router-openai-api\n    litellm_params:\n      model: openai/gpt-5.5-mini\n      api_key: os.environ/OPENAI_API_KEY\n  - model_name: router-openai-api\n    litellm_params:\n      model: openai/gpt-5.5-mini\n      api_key: os.environ/OPENAI_API_KEY\n`;

    expect(() => parseLiteLlmConfigYaml(duplicate)).toThrow("Duplicate LiteLLM aliases");
  });
});

function removeFixtureEntry(yamlText: string, alias: string): string {
  const retained: string[] = [];
  let skipping = false;

  for (const line of yamlText.split(/\r?\n/u)) {
    if (line.startsWith("  - model_name: ")) {
      skipping = line.trim() === `- model_name: ${alias}`;
      if (skipping) {
        continue;
      }
    }

    if (!skipping) {
      retained.push(line);
    }
  }

  return retained.join("\n");
}

describe("validateLiteLlmBaseline", () => {
  it("should return YELLOW when all expected rows exist but extra aliases are present", () => {
    const manifest = parseLiteLlmConfigYaml(readFileSync(fixturePath, "utf8"));
    const baseline = validateLiteLlmBaseline([
      ...manifest.aliases,
      {
        alias: "router-extra-test",
        providerGroup: "openai-platform",
        provider: "openai",
        model: "openai/example",
        apiBaseEnvVarNames: [],
        credentialEnvVarNames: ["OPENAI_API_KEY"],
        litellmParams: { model: "openai/example", api_key: "os.environ/OPENAI_API_KEY" },
        metadata: { router_aliases: ["router-extra-test"] }
      }
    ]);

    expect(baseline.verdict).toBe("YELLOW");
    expect(baseline.extraAliases).toContain("router-extra-test");
  });
});
