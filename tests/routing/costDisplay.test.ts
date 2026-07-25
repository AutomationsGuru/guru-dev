import { describe, expect, it } from "vitest";

import { formatRatePerMillion, formatTurnCost, formatUsageCost, renderModelCost } from '../../src/routing/costDisplay.js';
import { mapRoutesToProviders, renderProviderPicker } from '../../src/tui/providerPicker.js';
import { ProviderRouteDescriptorSchema } from '../../src/providers/schemas.js';
import type { AnsiTheme } from '../../src/tui/ansi.js';
import type { TuiCost, TuiProviderEntry } from '../../src/tui/schemas.js';

const PLAIN_THEME: AnsiTheme = { reset: "", dim: "", bold: "", fg: {} };

function providerWithCost(cost: TuiCost | undefined): TuiProviderEntry {
  return {
    providerId: "sakana",
    displayName: "Sakana",
    group: "direct",
    status: "active",
    requiredEnvNames: ["SAKANA_API_KEY"],
    presentEnvNames: ["SAKANA_API_KEY"],
    credentialSourceTypes: ["process-env"],
    models: [
      {
        modelId: "fugu-ultra",
        label: "Fugu Ultra",
        aliases: [],
        routeType: "direct-api",
        capabilities: ["text"],
        ...(cost !== undefined ? { cost } : {}),
        status: "active",
        caveats: []
      }
    ],
    docs: [],
    lastCheckedAt: "2026-07-18T00:00:00Z"
  };
}

describe("costDisplay — honest cost model (IDEA-C4 / R-CW-COST)", () => {
  describe("formatRatePerMillion", () => {
    it("renders a known rate with a $ prefix and sane precision", () => {
      expect(formatRatePerMillion(3)).toBe("$3.00");
      expect(formatRatePerMillion(15)).toBe("$15.00");
      expect(formatRatePerMillion(0.35)).toBe("$0.35");
    });

    it("renders unknown rate as 'unknown' — never a fabricated $0", () => {
      expect(formatRatePerMillion(undefined)).toBe("unknown");
      expect(formatRatePerMillion(Number.NaN)).toBe("unknown");
    });

    it("refuses negative rates (invalid data, not free)", () => {
      expect(formatRatePerMillion(-1)).toBe("unknown");
    });
  });

  describe("formatTurnCost", () => {
    it("computes a token-weighted USD estimate from known rates", () => {
      // 1_000_000 input @ $3/M + 1_000_000 output @ $15/M = $18
      expect(formatTurnCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, { inputPerMillionUsd: 3, outputPerMillionUsd: 15 })).toBe("$18.0000");
    });

    it("returns null when the input rate is unknown — unknown cost is never free", () => {
      expect(formatTurnCost({ inputTokens: 500, outputTokens: 500 }, { outputPerMillionUsd: 15 })).toBeNull();
    });

    it("returns null when the output rate is unknown — unknown cost is never free", () => {
      expect(formatTurnCost({ inputTokens: 500, outputTokens: 500 }, { inputPerMillionUsd: 3 })).toBeNull();
    });

    it("returns null when both rates are unknown", () => {
      expect(formatTurnCost({ inputTokens: 500, outputTokens: 500 }, {})).toBeNull();
    });

    it("returns null for a missing cost block entirely", () => {
      expect(formatTurnCost({ inputTokens: 500, outputTokens: 500 }, undefined)).toBeNull();
    });

    it("renders a genuinely $0.00 turn as $0.00 (plan-included zero is real, not unknown)", () => {
      expect(formatTurnCost({ inputTokens: 0, outputTokens: 0 }, { inputPerMillionUsd: 3, outputPerMillionUsd: 15 })).toBe("$0.0000");
    });
  });

  describe("formatUsageCost", () => {
    it("renders a tracked accumulated cost", () => {
      expect(formatUsageCost(1.234567)).toBe("$1.2346");
    });

    it("renders untracked usage as 'unknown', never $0", () => {
      expect(formatUsageCost(undefined)).toBe("unknown");
    });
  });

  describe("renderModelCost", () => {
    it("renders both known rates", () => {
      const cost: TuiCost = { lane: "USD", inputPerMillionUsd: 3, outputPerMillionUsd: 15 };
      expect(renderModelCost(cost)).toBe(" · $3.00/$15.00 per 1M tok");
    });

    it("renders an unknown side explicitly — never silently omitted or zeroed", () => {
      const cost: TuiCost = { lane: "USD", inputPerMillionUsd: 3 };
      expect(renderModelCost(cost)).toBe(" · $3.00/unknown per 1M tok");
    });

    it("renders fully unknown pricing explicitly", () => {
      const cost: TuiCost = { lane: "USD" };
      expect(renderModelCost(cost)).toBe(" · cost unknown");
    });

    it("returns an empty string for a missing cost block", () => {
      expect(renderModelCost(undefined)).toBe("");
    });

    it("never emits a bare '$0.00' for unknown pricing", () => {
      expect(renderModelCost({ lane: "USD" })).not.toContain("$0.00");
      expect(renderModelCost({ lane: "USD", outputPerMillionUsd: 15 })).not.toContain("$0.00");
    });
  });

  describe("renderProviderPicker cost surfacing", () => {
    it("shows known rates on the model row", () => {
      const lines = renderProviderPicker([providerWithCost({ lane: "USD", inputPerMillionUsd: 3, outputPerMillionUsd: 15 })], PLAIN_THEME);
      const row = lines.find((line) => line.includes("Fugu Ultra"));
      expect(row).toBeDefined();
      expect(row).toContain("$3.00/$15.00 per 1M tok");
    });

    it("shows 'unknown' for a route without pricing — never $0, never hidden", () => {
      const lines = renderProviderPicker([providerWithCost(undefined)], PLAIN_THEME);
      const row = lines.find((line) => line.includes("Fugu Ultra"));
      expect(row).toBeDefined();
      expect(row).not.toContain("$0");
    });

    it("shows 'cost unknown' when a cost lane exists without rates", () => {
      const lines = renderProviderPicker([providerWithCost({ lane: "USD" })], PLAIN_THEME);
      const row = lines.find((line) => line.includes("Fugu Ultra"));
      expect(row).toContain("cost unknown");
      expect(row).not.toContain("$0.00");
    });
  });

  describe("mapRoutesToProviders cost honesty", () => {
    function routeWithCost(cost: Record<string, unknown>) {
      return ProviderRouteDescriptorSchema.parse({
        providerId: "sakana",
        modelId: "fugu-ultra",
        routeId: "sakana/fugu-ultra",
        displayName: "Fugu Ultra",
        routeType: "direct-api",
        apiFamily: "openai-responses",
        baseUrl: "https://api.sakana.ai/v1",
        capabilities: {
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportsTools: true,
          supportsStreaming: true,
          supportsReasoning: true,
          supportsWebSearch: false,
          supportsVision: false,
          supportsJsonMode: true,
          supportsImages: false,
          notes: []
        },
        context: { contextWindowTokens: 262144, maxOutputTokens: 65536 },
        cost,
        credentialSource: { type: "env-var", envVarName: "SAKANA_API_KEY", envVarNames: [] },
        status: "ready-unverified",
        caveats: [],
        directFirstRank: 10,
        allowedRouterFallback: true
      });
    }

    it("maps known rates through to the model row", () => {
      const route = routeWithCost({ currency: "USD", inputPerMillionTokens: 3, outputPerMillionTokens: 15 });
      const providers = mapRoutesToProviders([route], { lastCheckedAt: "2026-07-18T00:00:00Z" });
      expect(providers[0]?.models[0]?.cost).toMatchObject({ inputPerMillionUsd: 3, outputPerMillionUsd: 15 });
    });

    it("preserves a rate-less cost lane as an explicit unknown, never silently dropped", () => {
      const route = routeWithCost({ currency: "USD", notes: ["plan-included, metering not published"] });
      const providers = mapRoutesToProviders([route], { lastCheckedAt: "2026-07-18T00:00:00Z" });
      const provider = providers[0];
      expect(provider).toBeDefined();
      const cost = provider?.models[0]?.cost;
      expect(cost).toBeDefined();
      expect(cost?.inputPerMillionUsd).toBeUndefined();
      expect(cost?.outputPerMillionUsd).toBeUndefined();
      // …and the picker must say "unknown", not render $0 or omit the signal.
      const lines = renderProviderPicker(providers, PLAIN_THEME);
      const row = lines.find((line) => line.includes("- Fugu Ultra"));
      expect(row).toContain("cost unknown");
    });
  });
});
