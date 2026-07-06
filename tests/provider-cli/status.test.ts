import {
  DEFAULT_PROVIDER_CLI_CONFIGS,
  getProviderCliStatus,
  getProviderCliStatusMatrix,
  type ProviderCliStatusExecutor
} from "../../src/provider-cli/status.js";
import { ProviderCliConfigSchema } from "../../src/provider-cli/schemas.js";

const config = ProviderCliConfigSchema.parse({ id: "codex", commandName: "codex.cmd", statusArgs: ["--version"], policy: "explicit-run-allowed" });
const configNeedingEnv = ProviderCliConfigSchema.parse({ id: "codex", commandName: "codex.cmd", requiredEnvNames: ["CODEX_TEST_ENV"] });

const readyExecutor: ProviderCliStatusExecutor = {
  commandExists: () => true,
  version: async () => ({ exitCode: 0, stdout: "codex 1.2.3\n", stderr: "" })
};
const missingCommandExecutor: ProviderCliStatusExecutor = {
  commandExists: () => false,
  version: async () => ({ exitCode: 0, stdout: "", stderr: "" })
};
const errorExecutor: ProviderCliStatusExecutor = {
  commandExists: () => true,
  version: async () => ({ exitCode: 1, stdout: "", stderr: "boom" })
};

describe("getProviderCliStatus", () => {
  it("reports missing-env when a required env NAME is absent", async () => {
    const report = await getProviderCliStatus("codex", { configs: [configNeedingEnv], env: {}, executor: readyExecutor });

    expect(report.status).toBe("missing-env");
    expect(report.missingEnvNames).toContain("CODEX_TEST_ENV");
  });

  it("reports missing-command when the command is not found", async () => {
    const report = await getProviderCliStatus("codex", { configs: [config], env: {}, executor: missingCommandExecutor });

    expect(report.status).toBe("missing-command");
  });

  it("reports ready with a version line when the probe succeeds", async () => {
    const report = await getProviderCliStatus("codex", { configs: [config], env: {}, executor: readyExecutor });

    expect(report.status).toBe("ready");
    expect(report.version).toBe("codex 1.2.3");
  });

  it("reports error when the version probe exits non-zero", async () => {
    const report = await getProviderCliStatus("codex", { configs: [config], env: {}, executor: errorExecutor });

    expect(report.status).toBe("error");
    expect(report.summary).toContain("boom");
  });

  it("reports error for an unconfigured id", async () => {
    const report = await getProviderCliStatus("claude", { configs: [config], env: {}, executor: readyExecutor });

    expect(report.status).toBe("error");
  });
});

describe("getProviderCliStatusMatrix + defaults", () => {
  it("returns one report per configured CLI", async () => {
    const matrix = await getProviderCliStatusMatrix({ configs: [config], env: {}, executor: readyExecutor });

    expect(matrix).toHaveLength(1);
    expect(matrix[0]?.status).toBe("ready");
  });

  it("ships a non-empty default provider-CLI inventory", () => {
    expect(DEFAULT_PROVIDER_CLI_CONFIGS.length).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_PROVIDER_CLI_CONFIGS.map((entry) => entry.id)).toContain("codex");
  });
});
