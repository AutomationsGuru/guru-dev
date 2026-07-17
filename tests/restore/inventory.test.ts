import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createRestoreInventory } from "../../src/restore/inventory.js";
import { ProviderRouteDescriptorSchema } from "../../src/providers/schemas.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `guru-restore-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function makeDirectoryLink(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

describe("createRestoreInventory", () => {
  it("returns deterministic portable categories and environment names without reading values", () => {
    const fixture = makeRoot("deterministic space λ");
    const guruHomeDirectory = join(fixture, "home profile");
    const projectRoot = join(fixture, "project Ω");
    const projectHarness = join(projectRoot, ".guru");

    writeJson(join(guruHomeDirectory, "guruharness.config.json"), {
      plannerModel: {
        provider: "openai-compatible",
        baseUrl: "https://planner.example.test/v1",
        model: "planner",
        apiKeyEnvVar: "PLANNER_API_KEY"
      },
      plannerModelFallbacks: [
        {
          provider: "openai-compatible",
          baseUrl: "https://fallback.example.test/v1",
          model: "fallback",
          apiKeyEnvVar: "FALLBACK_API_KEY"
        }
      ],
      memory: {
        storage: {
          provider: "postgres",
          postgres: { connectionStringEnvVar: "RESTORE_DATABASE_URL" }
        },
        honcho: { enabled: true, apiKeyEnvVar: "RESTORE_HONCHO_KEY" }
      },
      mcpServers: [
        {
          id: "filesystem",
          transport: "stdio",
          command: "mcp-filesystem",
          args: ["--safe"],
          requiredEnvNames: ["MCP_TOKEN", "MCP_TOKEN"],
          category: "filesystem"
        }
      ]
    });
    writeText(join(guruHomeDirectory, "skills", "z-last", "SKILL.md"), "# Z\n");
    writeText(join(guruHomeDirectory, "skills", "a-first", "SKILL.md"), "# A\n");
    writeText(join(guruHomeDirectory, "garage", "idea.md"), "portable idea\n");
    writeText(join(guruHomeDirectory, "tools", "check.ts"), "export const check = true;\n");
    writeText(join(guruHomeDirectory, "roles", "editor.md"), "editor\n");
    writeText(join(guruHomeDirectory, "memory", "facts.md"), "must stay out\n");
    writeText(join(guruHomeDirectory, "sessions", "turn.json"), "must stay out\n");

    writeJson(join(projectHarness, "guruharness.config.json"), {});
    writeJson(join(projectHarness, "harness.json"), { schemaVersion: 1 });
    writeText(join(projectHarness, "skills", "local", "project", "SKILL.md"), "# Project\n");
    writeText(join(projectHarness, "hooks", "pre-turn.sh"), "echo safe\n");
    writeText(join(projectHarness, "agent", "prompts", "system.md"), "portable prompt\n");
    writeText(join(projectHarness, "memory", "facts.md"), "must stay out\n");
    writeText(join(projectHarness, "state", "runtime.json"), "must stay out\n");

    const route = ProviderRouteDescriptorSchema.parse({
      providerId: "test-provider",
      modelId: "alpha",
      routeId: "test-provider/alpha",
      routeType: "direct-api",
      apiFamily: "openai-responses",
      baseUrl: "os.environ/TEST_PROVIDER_ENDPOINT",
      credentialSource: {
        type: "env-var",
        envVarName: "TEST_PROVIDER_KEY",
        envVarNames: ["TEST_PROVIDER_KEY", "TEST_PROVIDER_FALLBACK"]
      },
      status: "ready-unverified",
      directFirstRank: 1,
      allowedRouterFallback: true,
      wire: { headers: [{ header: "x-account", envVar: "TEST_PROVIDER_ACCOUNT" }] }
    });
    vi.stubEnv("TEST_PROVIDER_KEY", "sk-not-serialized-1234567890");

    const options = { guruHomeDirectory, projectRoot, providerRoutes: [route, route] } as const;
    const first = createRestoreInventory(options);
    const second = createRestoreInventory(options);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.configSummary.envNames).toEqual([
      "FALLBACK_API_KEY",
      "MCP_TOKEN",
      "PLANNER_API_KEY",
      "RESTORE_DATABASE_URL",
      "RESTORE_HONCHO_KEY",
      "TEST_PROVIDER_ACCOUNT",
      "TEST_PROVIDER_ENDPOINT",
      "TEST_PROVIDER_FALLBACK",
      "TEST_PROVIDER_KEY"
    ]);
    expect(first.configSummary.sourcePaths).toEqual([
      "guru-home/guruharness.config.json",
      "project/.guru/guruharness.config.json"
    ]);
    expect(first.connections.map((entry) => entry.id)).toEqual(["mcp:filesystem", "provider:test-provider/alpha"]);
    expect(first.connections.find((entry) => entry.id === "mcp:filesystem")?.note).toContain("command=mcp-filesystem");
    expect(first.connections.find((entry) => entry.id === "provider:test-provider/alpha")?.note).toContain(
      "endpoint=os.environ/TEST_PROVIDER_ENDPOINT"
    );
    expect(first.assets.map((asset) => asset.path)).toEqual([...first.assets.map((asset) => asset.path)].sort());
    expect(first.assets.map((asset) => asset.packagePath)).toContain("assets/guru-home/skills/a-first/SKILL.md");
    expect(first.assets.map((asset) => asset.packagePath)).toContain("assets/project/.guru/hooks/pre-turn.sh");
    expect(first.skillsIndex.filter((entry) => entry.status === "present").map((entry) => entry.path)).toEqual([
      "guru-home/skills/a-first/SKILL.md",
      "guru-home/skills/z-last/SKILL.md",
      "project/.guru/skills/local/project/SKILL.md"
    ]);
    expect(first.toolsIndex.filter((entry) => entry.status === "present").map((entry) => entry.path)).toEqual([
      "guru-home/tools/check.ts"
    ]);

    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(fixture);
    expect(serialized).not.toContain("sk-not-serialized");
    expect(serialized).not.toContain("must stay out");
    expect(serialized).not.toContain("\\");
  });

  it("excludes risky, binary, and oversized files without exposing their contents", () => {
    const fixture = makeRoot("exclusions");
    const guruHomeDirectory = join(fixture, "home");
    writeText(join(guruHomeDirectory, "skills", "safe.md"), "safe\n");
    writeText(join(guruHomeDirectory, "skills", ".env.local"), "PASSWORD=do-not-emit\n");
    writeText(join(guruHomeDirectory, "skills", "credentials.json"), "sk-secret-material-1234567890\n");
    writeText(join(guruHomeDirectory, "skills", "private.pem"), "private material\n");
    writeText(join(guruHomeDirectory, "skills", "cache", "ignored.md"), "cache state\n");
    writeText(join(guruHomeDirectory, "skills", "logs", "ignored.log"), "runtime log\n");
    writeText(join(guruHomeDirectory, "skills", ".DS_Store"), "finder metadata\n");
    writeFileSync(join(guruHomeDirectory, "skills", "binary.dat"), Buffer.from([0, 1, 2, 3]));
    writeText(join(guruHomeDirectory, "skills", "large.md"), "x".repeat(32));

    const result = createRestoreInventory({
      guruHomeDirectory,
      providerRoutes: [],
      limits: { maxFileBytes: 16, maxFileCount: 20, maxTotalBytes: 100, maxDepth: 8 }
    });

    expect(result.assets.map((asset) => asset.path)).toEqual(["guru-home/skills/safe.md"]);
    const excludedPaths = [...result.components, ...result.skillsIndex, ...result.toolsIndex]
      .filter((entry) => entry.status === "excluded")
      .map((entry) => entry.path);
    expect(excludedPaths).toEqual([
      "guru-home/skills/.DS_Store",
      "guru-home/skills/.env.local",
      "guru-home/skills/binary.dat",
      "guru-home/skills/cache/ignored.md",
      "guru-home/skills/credentials.json",
      "guru-home/skills/large.md",
      "guru-home/skills/logs/ignored.log",
      "guru-home/skills/private.pem"
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("do-not-emit");
    expect(serialized).not.toContain("sk-secret-material");
  });

  it("stops at the file-count cap and reports one degraded logical entry", () => {
    const fixture = makeRoot("file-cap");
    const guruHomeDirectory = join(fixture, "home");
    writeText(join(guruHomeDirectory, "skills", "a.md"), "a\n");
    writeText(join(guruHomeDirectory, "skills", "b.md"), "b\n");

    const result = createRestoreInventory({
      guruHomeDirectory,
      providerRoutes: [],
      limits: { maxFileBytes: 100, maxFileCount: 1, maxTotalBytes: 100, maxDepth: 8 }
    });

    expect(result.assets).toHaveLength(1);
    expect(result.components).toContainEqual(
      expect.objectContaining({ id: "limit:file-count", status: "degraded", path: "guru-home/skills" })
    );
  });

  it("stops before exceeding the total-byte cap and reports the skipped file", () => {
    const fixture = makeRoot("byte-cap");
    const guruHomeDirectory = join(fixture, "home");
    writeText(join(guruHomeDirectory, "skills", "a.md"), "abc");
    writeText(join(guruHomeDirectory, "skills", "b.md"), "def");

    const result = createRestoreInventory({
      guruHomeDirectory,
      providerRoutes: [],
      limits: { maxFileBytes: 100, maxFileCount: 10, maxTotalBytes: 4, maxDepth: 8 }
    });

    expect(result.assets.map((asset) => asset.path)).toEqual(["guru-home/skills/a.md"]);
    expect(result.skillsIndex).toContainEqual(
      expect.objectContaining({ path: "guru-home/skills/b.md", status: "excluded", note: "total-byte-cap" })
    );
  });

  it("does not descend past the depth cap and reports the skipped directory", () => {
    const fixture = makeRoot("depth-cap");
    const guruHomeDirectory = join(fixture, "home");
    writeText(join(guruHomeDirectory, "skills", "one", "two", "deep.md"), "deep\n");

    const result = createRestoreInventory({
      guruHomeDirectory,
      providerRoutes: [],
      limits: { maxFileBytes: 100, maxFileCount: 10, maxTotalBytes: 100, maxDepth: 1 }
    });

    expect(result.assets).toEqual([]);
    expect(result.skillsIndex).toContainEqual(
      expect.objectContaining({ path: "guru-home/skills/one/two", status: "excluded", note: "depth-cap" })
    );
  });

  it("records contained link metadata without traversing links and excludes escapes", () => {
    const fixture = makeRoot("links");
    const guruHomeDirectory = join(fixture, "home");
    const projectRoot = join(fixture, "project");
    const outside = join(fixture, "outside");
    writeText(join(guruHomeDirectory, "skills", "real", "SKILL.md"), "# real\n");
    writeText(join(outside, "secret.md"), "sk-must-not-be-walked-1234567890\n");
    makeDirectoryLink(join(guruHomeDirectory, "skills", "real"), join(guruHomeDirectory, "skills", "alias"));
    makeDirectoryLink(outside, join(guruHomeDirectory, "skills", "escape"));
    makeDirectoryLink(join(guruHomeDirectory, "skills"), join(projectRoot, ".guru", "skills", "global"));

    const result = createRestoreInventory({ guruHomeDirectory, projectRoot, providerRoutes: [] });

    expect(result.links).toEqual([
      {
        id: "link:guru-home/skills/alias",
        root: "guru-home",
        path: "guru-home/skills/alias",
        target: "guru-home/skills/real"
      },
      {
        id: "link:project/.guru/skills/global",
        root: "project",
        path: "project/.guru/skills/global",
        target: "guru-home/skills"
      }
    ]);
    expect(result.skillsIndex).toContainEqual(
      expect.objectContaining({ path: "guru-home/skills/escape", status: "excluded", note: "symlink-escape" })
    );
    expect(result.assets.map((asset) => asset.path)).toEqual(["guru-home/skills/real/SKILL.md"]);
    expect(JSON.stringify(result)).not.toContain("must-not-be-walked");
    expect(JSON.stringify(result)).not.toContain(fixture);
  });

  it("does not emit a logical path longer than the frozen manifest schema permits", () => {
    const fixture = makeRoot("path-cap");
    const guruHomeDirectory = join(fixture, "home");
    const segment = "x".repeat(220);
    writeText(join(guruHomeDirectory, "skills", segment, segment, segment, segment, segment, "deep.md"), "deep\n");

    const result = createRestoreInventory({
      guruHomeDirectory,
      providerRoutes: [],
      limits: { maxFileBytes: 100, maxFileCount: 10, maxTotalBytes: 100, maxDepth: 16 }
    });

    expect(result.assets).toEqual([]);
    expect(result.components).toContainEqual(
      expect.objectContaining({ id: "limit:path-length", path: "guru-home/skills", status: "degraded" })
    );
    expect(JSON.stringify(result)).not.toContain(segment.repeat(2));
  });

  it("ignores provider environment names longer than the frozen config summary permits", () => {
    const fixture = makeRoot("env-cap");
    const guruHomeDirectory = join(fixture, "home");
    const overlongEnvName = `KEY_${"A".repeat(260)}`;
    const route = ProviderRouteDescriptorSchema.parse({
      providerId: "long-env",
      modelId: "alpha",
      routeId: "long-env/alpha",
      routeType: "direct-api",
      apiFamily: "openai-responses",
      baseUrl: "https://provider.example.test/v1",
      credentialSource: { type: "env-var", envVarName: overlongEnvName },
      status: "ready-unverified",
      directFirstRank: 1,
      allowedRouterFallback: true
    });

    const result = createRestoreInventory({ guruHomeDirectory, providerRoutes: [route] });

    expect(result.configSummary.envNames).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(overlongEnvName);
  });
});
