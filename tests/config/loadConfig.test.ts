import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadHarnessConfig } from "../../src/config/loadConfig.js";
import { HarnessConfigSchema } from "../../src/config/schema.js";

describe("HarnessConfigSchema", () => {
  it("should parse a minimal valid config with defaults", () => {
    const config = HarnessConfigSchema.parse({ runtimeName: "GuruHarness" });

    expect(config.runtimeName).toBe("GuruHarness");
    expect(config.referenceRuntime).toBe("a reference agent runtime");
    expect(config.approvalPolicy.autoCommitPushPr).toBe(true);
    expect(config.approvalPolicy.allowLocalMerge).toBe(false);
    expect(config.plannerModel).toBeUndefined();
    expect(config.selfBuild.maxIterations).toBe(1);
  });
});

describe("loadHarnessConfig", () => {
  it("should load a valid config file", () => {
    const directory = makeTempDirectory();
    const configPath = join(directory, "guruharness.config.json");

    writeFileSync(
      configPath,
      JSON.stringify({
        runtimeName: "GuruHarness",
        plannerModel: {
          provider: "openai-compatible",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5.5",
          apiKeyEnvVar: "OPENAI_API_KEY"
        },
        selfBuild: {
          completedTaskIds: ["capture-operating-contract"]
        }
      })
    );

    const result = loadHarnessConfig({ cwd: directory });

    expect(result.status).toBe("loaded");
    expect(result.verdict).toBe("GREEN");
    expect(result.config.selfBuild.completedTaskIds).toEqual(["capture-operating-contract"]);
    expect(result.config.plannerModel).toMatchObject({
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.5",
      apiKeyEnvVar: "OPENAI_API_KEY",
      timeoutMs: 120000,
      temperature: 0
    });

    rmSync(directory, { recursive: true, force: true });
  });

  it("should return a yellow diagnostic for a missing config", () => {
    const directory = makeTempDirectory();
    const result = loadHarnessConfig({ cwd: directory });

    expect(result.status).toBe("missing");
    expect(result.verdict).toBe("YELLOW");
    expect(result.diagnostics[0]).toContain("Config file not found");
    expect(result.config.runtimeName).toBe("GuruHarness");

    rmSync(directory, { recursive: true, force: true });
  });

  it("should return a red diagnostic for malformed config", () => {
    const directory = makeTempDirectory();
    const configPath = join(directory, "guruharness.config.json");

    writeFileSync(configPath, JSON.stringify({ approvalPolicy: { allowLocalMerge: "yes" } }));

    const result = loadHarnessConfig({ cwd: directory });

    expect(result.status).toBe("invalid");
    expect(result.verdict).toBe("RED");
    expect(result.diagnostics.join("\n")).toContain("Invalid config");

    rmSync(directory, { recursive: true, force: true });
  });
});

function makeTempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "guruharness-config-"));
}
