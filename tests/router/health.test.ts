import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRouterStatusReport, DEFAULT_LITELLM_HEALTH_ENDPOINT, checkRouterHealth } from "../../src/router/health.js";

const fixturePath = join(process.cwd(), "tests", "fixtures", "litellm.config.yaml");

describe("router health/status manager", () => {
  it("should report online health from the default LiteLLM liveliness endpoint", async () => {
    const calls: string[] = [];
    const report = await checkRouterHealth({
      fetchImpl: (async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }) as typeof fetch
    });

    expect(calls).toEqual([DEFAULT_LITELLM_HEALTH_ENDPOINT]);
    expect(report).toMatchObject({ endpoint: DEFAULT_LITELLM_HEALTH_ENDPOINT, status: "online", httpStatus: 200 });
  });

  it("should build a secret-safe router status report with alias counts, process guess, and missing env names only", async () => {
    const report = await createRouterStatusReport({
      configPath: "C:/Users/user/.config/ai-router/litellm.config.yaml",
      configText: readFileSync(fixturePath, "utf8"),
      env: { OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "x" },
      fetchImpl: (async () => new Response("ok", { status: 200 })) as typeof fetch,
      processProbe: {
        listProcesses: () => [
          { pid: 123, command: "python -m litellm --config C:/Users/user/.config/ai-router/litellm.config.yaml", source: "process-list" },
          { pid: 456, command: "node unrelated.js", source: "process-list" }
        ]
      }
    });

    expect(report.aliasCount).toBe(39);
    expect(report.providerGroupCount).toBe(11);
    expect(report.processGuess).toEqual([{ pid: 123, command: "python -m litellm --config C:/Users/user/.config/ai-router/litellm.config.yaml", source: "process-list" }]);
    expect(report.missingEnvVarNames).toContain("GEMINI_API_KEY");
    expect(JSON.stringify(report)).not.toContain("\"x\"");
  });
});
