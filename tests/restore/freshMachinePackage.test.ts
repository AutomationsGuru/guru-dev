import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RestoreManifestSchema, type RestoreManifest } from "../../src/restore/manifests.js";
import { createRestorePackageWriter, verifyRestorePackage } from "../../src/restore/packageWriter.js";
import { ProviderRouteDescriptorSchema } from "../../src/providers/schemas.js";

const temporaryRoots: string[] = [];
const FIXED_NOW = new Date("2026-07-15T15:00:00.000Z");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface PackageFixture {
  readonly sourceRoot: string;
  readonly guruHomeDirectory: string;
  readonly projectRoot: string;
  readonly packageDirectory: string;
  readonly secretValue: string;
}

async function createPackage(label: string): Promise<PackageFixture> {
  const sourceRoot = makeTemporaryRoot(`guru-restore-source-${label}-`);
  const guruHomeDirectory = join(sourceRoot, "home profile");
  const projectRoot = join(sourceRoot, "project");
  const packageDirectory = join(sourceRoot, "restore-package");
  const secretValue = "sk-source-only-secret-1234567890";

  writeJson(join(guruHomeDirectory, "guruharness.config.json"), {
    mcpServers: [
      {
        id: "portable",
        transport: "stdio",
        command: "portable-mcp",
        requiredEnvNames: ["MCP_TOKEN"],
        category: "test"
      }
    ]
  });
  writeText(join(guruHomeDirectory, "skills", "alpha", "SKILL.md"), "# Alpha\nPortable skill.\n");
  writeText(join(guruHomeDirectory, "roles", "builder.md"), "Builder role.\n");
  writeJson(join(projectRoot, ".guru", "guruharness.config.json"), {});
  writeJson(join(projectRoot, ".guru", "harness.json"), { schemaVersion: 1, mode: "portable" });
  writeText(join(projectRoot, ".guru", "agent", "prompts", "system.md"), "Portable project prompt.\n");

  const providerRoute = ProviderRouteDescriptorSchema.parse({
    providerId: "portable-provider",
    modelId: "alpha",
    routeId: "portable-provider/alpha",
    routeType: "direct-api",
    apiFamily: "openai-responses",
    baseUrl: "https://provider.example.test/v1",
    credentialSource: { type: "env-var", envVarName: "PROVIDER_KEY" },
    status: "ready-unverified",
    directFirstRank: 1,
    allowedRouterFallback: true
  });

  vi.stubEnv("PROVIDER_KEY", secretValue);
  const writer = createRestorePackageWriter({
    guruHomeDirectory,
    projectRoot,
    providerRoutes: [providerRoute],
    now: () => FIXED_NOW
  });
  await writer.write(packageDirectory);
  return { sourceRoot, guruHomeDirectory, projectRoot, packageDirectory, secretValue };
}

function makeTemporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
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

function snapshotDirectory(root: string): Readonly<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const logicalPath = relative(root, path).split(sep).join("/");
      expect(logicalPath).not.toMatch(/(?:^|\/)\.\.(?:\/|$)/u);
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
      if (entry.isDirectory()) visit(path);
      else snapshot[logicalPath] = readFileSync(path).toString("base64");
    }
  };
  visit(root);
  return snapshot;
}

function listedAssetPaths(manifest: RestoreManifest): string[] {
  return [...manifest.components, ...manifest.skillsIndex, ...manifest.toolsIndex]
    .filter((entry) => entry.id.startsWith("asset:") && entry.path)
    .map((entry) => `assets/${entry.path as string}`)
    .sort();
}

async function captureFailure(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    return error as Error;
  }
  throw new Error("Expected restore-package verification to fail.");
}

describe("fresh-machine restore package", () => {
  it("verifies a relocated package without its source machine or any mutation", async () => {
    const fixture = await createPackage("relocated");
    const sourceManifest = RestoreManifestSchema.parse(
      JSON.parse(readFileSync(join(fixture.packageDirectory, "restore-manifest.json"), "utf8")) as unknown
    );
    const freshRoot = makeTemporaryRoot("guru-restore-fresh-");
    const relocatedPackage = join(freshRoot, "portable-package");
    cpSync(fixture.packageDirectory, relocatedPackage, { recursive: true });
    rmSync(fixture.sourceRoot, { recursive: true, force: true });

    const network = vi.fn(() => {
      throw new Error("Restore verification attempted a network call.");
    });
    vi.stubGlobal("fetch", network);
    const before = snapshotDirectory(freshRoot);

    const verified = await verifyRestorePackage(relocatedPackage);

    expect(verified).toEqual(sourceManifest);
    expect(snapshotDirectory(freshRoot)).toEqual(before);
    expect(network).not.toHaveBeenCalled();
    expect(readFileSync(join(relocatedPackage, ".env.example"), "utf8")).toBe("MCP_TOKEN=\nPROVIDER_KEY=\n");
    for (const path of listedAssetPaths(verified)) expect(existsSync(join(relocatedPackage, ...path.split("/")))).toBe(true);

    const packageText = Object.values(snapshotDirectory(relocatedPackage))
      .map((content) => Buffer.from(content, "base64").toString("utf8"))
      .join("\n");
    expect(packageText).not.toContain(fixture.guruHomeDirectory);
    expect(packageText).not.toContain(fixture.projectRoot);
    expect(packageText).not.toContain(fixture.secretValue);
  });

  it("rejects non-empty environment values and traversal payload metadata", async () => {
    const fixture = await createPackage("tampered");
    const nonEmptyEnvironment = join(fixture.sourceRoot, "non-empty-environment");
    cpSync(fixture.packageDirectory, nonEmptyEnvironment, { recursive: true });
    const leakedValue = "not-safe-for-a-restore-package";
    writeText(join(nonEmptyEnvironment, ".env.example"), `PROVIDER_KEY=${leakedValue}\n`);

    const environmentError = await captureFailure(() => verifyRestorePackage(nonEmptyEnvironment));
    expect(environmentError.message).not.toContain(leakedValue);

    const traversalPackage = join(fixture.sourceRoot, "traversal-package");
    cpSync(fixture.packageDirectory, traversalPackage, { recursive: true });
    const manifestPath = join(traversalPackage, "restore-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      components: Array<{ id: string; path?: string }>;
    };
    const listedAsset = manifest.components.find((entry) => entry.id.startsWith("asset:"));
    expect(listedAsset).toBeDefined();
    if (!listedAsset) return;
    listedAsset.id = "asset:../outside";
    listedAsset.path = "../outside";
    writeJson(manifestPath, manifest);

    const traversalError = await captureFailure(() => verifyRestorePackage(traversalPackage));
    expect(traversalError.message).not.toContain(fixture.sourceRoot);
  });

  it("re-scans relocated payloads and returns value-free secret failures", async () => {
    const fixture = await createPackage("secret-rescan");
    const tamperedPackage = join(fixture.sourceRoot, "secret-package");
    cpSync(fixture.packageDirectory, tamperedPackage, { recursive: true });
    const token = "sk-tampered-payload-1234567890";
    writeText(join(tamperedPackage, "assets", "guru-home", "skills", "alpha", "SKILL.md"), `${token}\n`);
    const before = snapshotDirectory(tamperedPackage);

    const error = await captureFailure(() => verifyRestorePackage(tamperedPackage));

    expect(error.message).not.toContain(token);
    expect(snapshotDirectory(tamperedPackage)).toEqual(before);
  });
});
