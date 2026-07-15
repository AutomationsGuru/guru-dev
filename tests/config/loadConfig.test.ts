import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    expect(config.memory.storage.provider).toBe("markdown");
    expect(config.memory.honcho.enabled).toBe(false);
  });

  it("accepts a PostgreSQL fact-memory backend and an explicit Honcho integration without secrets in config", () => {
    const config = HarnessConfigSchema.parse({
      runtimeName: "GuruHarness",
      memory: {
        storage: {
          provider: "postgres",
          postgres: { connectionStringEnvVar: "TEAM_MEMORY_DATABASE_URL", schema: "agent_memory", table: "facts", ssl: "require" }
        },
        honcho: {
          enabled: true,
          apiKeyEnvVar: "TEAM_HONCHO_API_KEY",
          workspaceId: "team-memory",
          sessionId: "guru",
          userPeerId: "matthew",
          agentPeerId: "guru"
        }
      }
    });

    expect(config.memory.storage).toMatchObject({ provider: "postgres", postgres: { connectionStringEnvVar: "TEAM_MEMORY_DATABASE_URL", schema: "agent_memory" } });
    expect(config.memory.honcho).toMatchObject({ enabled: true, apiKeyEnvVar: "TEAM_HONCHO_API_KEY", workspaceId: "team-memory" });
  });

  it("P0: reviewGate defaults to the native critic panel (no external tool assumed)", () => {
    const config = HarnessConfigSchema.parse({ runtimeName: "GuruHarness" });
    expect(config.reviewGate.provider).toBe("native-critic-panel");
    expect(config.reviewGate.required).toBe(true);
    expect(config.reviewGate.command).toBeUndefined();
  });

  it("P0: provider command REQUIRES a command argv; native does not", () => {
    expect(() => HarnessConfigSchema.parse({ runtimeName: "G", reviewGate: { provider: "command", required: true } })).toThrow();
    expect(() =>
      HarnessConfigSchema.parse({
        runtimeName: "G",
        reviewGate: { provider: "command", required: true, command: ["echo", "review-ok"] }
      })
    ).not.toThrow();
    expect(() => HarnessConfigSchema.parse({ runtimeName: "G", reviewGate: { provider: "native-critic-panel", required: true } })).not.toThrow();
  });

  it("P0: coderabbit provider is rejected (removed from the project)", () => {
    expect(() =>
      HarnessConfigSchema.parse({
        runtimeName: "G",
        reviewGate: { provider: "coderabbit", required: true, command: ["coderabbit", "review"] }
      })
    ).toThrow();
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
    const result = loadHarnessConfig({ cwd: directory, homeDirectory: join(directory, "missing-home") });

    expect(result.status).toBe("missing");
    expect(result.verdict).toBe("YELLOW");
    expect(result.diagnostics[0]).toContain("Config file not found");
    expect(result.config.runtimeName).toBe("GuruHarness");

    rmSync(directory, { recursive: true, force: true });
  });

  it("loads a generated project overlay before the reusable home default", () => {
    const directory = makeTempDirectory();
    const homeDirectory = join(directory, "home");
    const projectConfigDirectory = join(directory, ".guru");
    mkdirSync(projectConfigDirectory, { recursive: true });
    mkdirSync(homeDirectory, { recursive: true });
    writeFileSync(join(homeDirectory, "guruharness.config.json"), JSON.stringify({ runtimeName: "Home Guru" }));
    writeFileSync(join(projectConfigDirectory, "guruharness.config.json"), JSON.stringify({ runtimeName: "Project Guru" }));

    const result = loadHarnessConfig({ cwd: directory, homeDirectory });

    expect(result.status).toBe("loaded");
    expect(result.source).toBe("project");
    expect(result.config.runtimeName).toBe("Project Guru");

    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps an explicit workspace config ahead of a generated project overlay", () => {
    const directory = makeTempDirectory();
    const homeDirectory = join(directory, "home");
    const projectConfigDirectory = join(directory, ".guru");
    mkdirSync(projectConfigDirectory, { recursive: true });
    writeFileSync(join(directory, "guruharness.config.json"), JSON.stringify({ runtimeName: "Workspace Guru" }));
    writeFileSync(join(projectConfigDirectory, "guruharness.config.json"), JSON.stringify({ runtimeName: "Project Guru" }));

    const result = loadHarnessConfig({ cwd: directory, homeDirectory });

    expect(result.status).toBe("loaded");
    expect(result.source).toBe("workspace");
    expect(result.config.runtimeName).toBe("Workspace Guru");

    rmSync(directory, { recursive: true, force: true });
  });

  it("does not hide a missing explicit config behind the project or home defaults", () => {
    const directory = makeTempDirectory();
    const homeDirectory = join(directory, "home");
    const explicitPath = join(directory, "does-not-exist.json");
    mkdirSync(homeDirectory, { recursive: true });
    writeFileSync(join(homeDirectory, "guruharness.config.json"), JSON.stringify({ runtimeName: "Home Guru" }));

    const result = loadHarnessConfig({ cwd: directory, configPath: explicitPath, homeDirectory });

    expect(result.status).toBe("missing");
    expect(result.source).toBe("defaults");
    expect(result.path).toBe(explicitPath);

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
