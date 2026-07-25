import { describe, expect, it } from "vitest";

import { rankProviders } from '../../src/providers/localFirstPreference.js';
import { defineProviderRoute } from '../../src/providers/registry.js';

describe("local-first provider preference", () => {
  it("ranks a ready local Ollama-compatible route above a ready cloud route", () => {
    const cloud = defineProviderRoute({
      providerId: "cloud",
      modelId: "cloud-model",
      routeId: "cloud/cloud-model",
      routeType: "direct-api",
      apiFamily: "openai-chat-completions",
      credentialSource: { type: "none", envVarNames: [] },
      status: "active",
      directFirstRank: 1,
      allowedRouterFallback: false
    });
    const local = defineProviderRoute({
      providerId: "ollama-local",
      modelId: "local-model",
      routeId: "ollama-local/local-model",
      routeType: "direct-api",
      apiFamily: "ollama-openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      credentialSource: { type: "none", envVarNames: [] },
      status: "active",
      directFirstRank: 100,
      allowedRouterFallback: false
    });

    const ranked = rankProviders([cloud, local]);

    expect(ranked).toEqual([local, cloud]);
  });
});
