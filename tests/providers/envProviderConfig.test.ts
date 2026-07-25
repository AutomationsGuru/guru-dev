import { describe, expect, it } from "vitest";

import { parseEnvProviders } from '../../src/providers/envProviderConfig.js';

describe("environment provider config", () => {
  it("parses comma-separated provider:model pairs", () => {
    expect(parseEnvProviders("openai:gpt-5.6, ollama-local:qwen3.5")).toEqual([
      { providerId: "openai", modelId: "gpt-5.6" },
      { providerId: "ollama-local", modelId: "qwen3.5" }
    ]);
  });

  it("ignores malformed tokens without reading configuration files", () => {
    expect(parseEnvProviders("openai:gpt-5.6, garbage, :missing-provider, missing-model:, invalid provider:model, too:many:parts, ollama-local:qwen3.5")).toEqual([
      { providerId: "openai", modelId: "gpt-5.6" },
      { providerId: "ollama-local", modelId: "qwen3.5" }
    ]);
  });
});
