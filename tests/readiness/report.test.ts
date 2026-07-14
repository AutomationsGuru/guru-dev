import { buildReadinessReport } from "../../src/readiness/report.js";
import { createInMemoryHonchoClient } from "../../src/honcho/client.js";
import { HonchoConfigSchema } from "../../src/honcho/schemas.js";
import { ProviderCliConfigSchema } from "../../src/provider-cli/schemas.js";
import type { ProviderCliStatusExecutor } from "../../src/provider-cli/status.js";

const providerConfig = ProviderCliConfigSchema.parse({ id: "codex", commandName: "codex.cmd" });
const readyExecutor: ProviderCliStatusExecutor = {
  commandExists: () => true,
  version: async () => ({ exitCode: 0, stdout: "codex 1.2.3", stderr: "" })
};

describe("buildReadinessReport", () => {
  it("includes runtime, honcho, and provider-CLI rows and derives a verdict", async () => {
    const honchoClient = createInMemoryHonchoClient({
      config: HonchoConfigSchema.parse({ workspaceId: "guruharness", enabled: true, writeEnabled: true, requiredEnvNames: ["HONCHO_API_KEY"] }),
      env: { HONCHO_API_KEY: "present" }
    });

    const report = await buildReadinessReport({
      honchoClient,
      providerCli: { configs: [providerConfig], env: {}, executor: readyExecutor }
    });

    expect(report.runtimeName).toBe("GuruHarness");
    expect(["GREEN", "YELLOW", "RED"]).toContain(report.verdict);

    const ids = report.rows.map((entry) => entry.id);
    expect(ids).toContain("runtime:guruharness");
    expect(ids).toContain("honcho");
    expect(ids).toContain("provider-cli:codex");

    expect(report.rows.find((entry) => entry.id === "honcho")?.status).toBe("ready");
    expect(report.rows.find((entry) => entry.id === "provider-cli:codex")?.status).toBe("ready");
  });

  it("marks honcho not-implemented when no client is provided", async () => {
    const report = await buildReadinessReport({ providerCli: { configs: [], executor: readyExecutor } });

    expect(report.rows.find((entry) => entry.id === "honcho")?.status).toBe("not-implemented");
  });
});
