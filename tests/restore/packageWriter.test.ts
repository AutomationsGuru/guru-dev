import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RestoreManifestSchema } from "../../src/restore/manifests.js";
import { createRestorePackageWriter } from "../../src/restore/packageWriter.js";
import { ProviderRouteDescriptorSchema, type ProviderRouteDescriptor } from "../../src/providers/schemas.js";

const temporaryRoots: string[] = [];
const FIXED_NOW = new Date("2026-07-15T14:00:00.000Z");

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly root: string;
  readonly guruHomeDirectory: string;
  readonly projectRoot: string;
  readonly providerRoute: ProviderRouteDescriptor;
}

function makeFixture(label: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `guru-package-${label}-`));
  temporaryRoots.push(root);
  const guruHomeDirectory = join(root, "home profile");
  const projectRoot = join(root, "project");

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
  writeText(join(guruHomeDirectory, "skills", ".env.local"), "SHOULD_NOT_COPY=value\n");
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

  return { root, guruHomeDirectory, projectRoot, providerRoute };
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
      if (entry.isDirectory()) {
        visit(path);
      } else {
        snapshot[relative(root, path).split(sep).join("/")] = readFileSync(path).toString("base64");
      }
    }
  };
  visit(root);
  return snapshot;
}

function temporaryPackageNames(parent: string): string[] {
  return readdirSync(parent).filter((name) => name.includes(".restore-")).sort();
}

function entryIdentity(path: string): Readonly<Record<string, number>> {
  const stats = lstatSync(path);
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    mtimeMs: stats.mtimeMs
  };
}

describe("createRestorePackageWriter", () => {
  it("writes deterministic schema-valid package files with empty environment values", async () => {
    const fixture = makeFixture("clean");
    vi.stubEnv("PROVIDER_KEY", "sk-never-read-by-writer-1234567890");
    const publications: Array<{ readonly source: string; readonly target: string }> = [];
    const writer = createRestorePackageWriter({
      guruHomeDirectory: fixture.guruHomeDirectory,
      projectRoot: fixture.projectRoot,
      providerRoutes: [fixture.providerRoute],
      now: () => FIXED_NOW,
      fileSystem: {
        beforePublish: (source, target) => publications.push({ source, target })
      }
    });

    const firstGenerated = await writer.generate();
    const secondGenerated = await writer.generate();
    expect(secondGenerated).toEqual(firstGenerated);
    expect(RestoreManifestSchema.parse(firstGenerated)).toEqual(firstGenerated);
    expect(firstGenerated.secretScan).toEqual({
      scannedAt: FIXED_NOW.toISOString(),
      scanner: "guruharness-secret-scan",
      leakedSecretCount: 0,
      findings: []
    });

    const targetA = join(fixture.root, "package-a");
    const targetB = join(fixture.root, "package-b");
    await writer.write(targetA);
    await writer.write(targetB);

    expect(snapshotDirectory(targetB)).toEqual(snapshotDirectory(targetA));
    const manifest = RestoreManifestSchema.parse(JSON.parse(readFileSync(join(targetA, "restore-manifest.json"), "utf8")) as unknown);
    expect(manifest).toEqual(firstGenerated);
    expect(readFileSync(join(targetA, ".env.example"), "utf8")).toBe("MCP_TOKEN=\nPROVIDER_KEY=\n");
    expect(readFileSync(join(targetA, "assets", "guru-home", "skills", "alpha", "SKILL.md"), "utf8")).toContain("Portable skill");
    expect(readFileSync(join(targetA, "assets", "project", ".guru", "agent", "prompts", "system.md"), "utf8")).toContain(
      "Portable project prompt"
    );
    expect(existsSync(join(targetA, "assets", "guru-home", "skills", ".env.local"))).toBe(false);
    expect(JSON.stringify(snapshotDirectory(targetA))).not.toContain("never-read-by-writer");
    expect(publications).toHaveLength(2);
    for (const publication of publications) {
      expect(dirname(publication.source)).toBe(dirname(publication.target));
      expect(basename(publication.source)).toMatch(/^\.package-[ab]\.restore-/u);
    }
    expect(temporaryPackageNames(fixture.root)).toEqual([]);
  });

  it("preserves a pre-existing non-empty target byte for byte", async () => {
    const fixture = makeFixture("target");
    const target = join(fixture.root, "existing-package");
    writeText(join(target, "keep.txt"), "keep exactly\n");
    const before = snapshotDirectory(target);
    const writer = createRestorePackageWriter({
      guruHomeDirectory: fixture.guruHomeDirectory,
      projectRoot: fixture.projectRoot,
      providerRoutes: [],
      now: () => FIXED_NOW
    });

    await expect(writer.write(target)).rejects.toThrow("Restore package target already exists");

    expect(snapshotDirectory(target)).toEqual(before);
    expect(temporaryPackageNames(fixture.root)).toEqual([]);
  });

  it("preserves a target created immediately before publication", async () => {
    const fixture = makeFixture("target-race");
    const target = join(fixture.root, "raced-package");
    let createdIdentity: ReturnType<typeof lstatSync> | undefined;
    const createRacedTarget = (): void => {
      mkdirSync(target, { mode: 0o750 });
      createdIdentity = lstatSync(target);
    };
    const writer = createRestorePackageWriter({
      guruHomeDirectory: fixture.guruHomeDirectory,
      providerRoutes: [],
      now: () => FIXED_NOW,
      fileSystem: { beforePublish: () => createRacedTarget() }
    });

    await expect(writer.write(target)).rejects.toMatchObject({ code: "target-exists" });

    const preservedIdentity = lstatSync(target);
    expect(createdIdentity).toBeDefined();
    expect({
      dev: preservedIdentity.dev,
      ino: preservedIdentity.ino,
      mode: preservedIdentity.mode,
      uid: preservedIdentity.uid,
      gid: preservedIdentity.gid,
      mtimeMs: preservedIdentity.mtimeMs
    }).toEqual({
      dev: createdIdentity?.dev,
      ino: createdIdentity?.ino,
      mode: createdIdentity?.mode,
      uid: createdIdentity?.uid,
      gid: createdIdentity?.gid,
      mtimeMs: createdIdentity?.mtimeMs
    });
    expect(readdirSync(target)).toEqual([]);
    expect(temporaryPackageNames(fixture.root)).toEqual([]);
  });

  it("preserves a same-named file created after the target claim", async () => {
    const fixture = makeFixture("entry-file-race");
    const target = join(fixture.root, "raced-package");
    const externalEntry = join(target, "restore-manifest.json");
    const externalContent = "external manifest must survive\n";
    let createdIdentity: Readonly<Record<string, number>> | undefined;
    const writer = createRestorePackageWriter({
      guruHomeDirectory: fixture.guruHomeDirectory,
      providerRoutes: [],
      now: () => FIXED_NOW,
      fileSystem: {
        afterTargetClaim: (_source: string, claimedTarget: string) => {
          expect(claimedTarget).toBe(target);
          writeFileSync(externalEntry, externalContent, { encoding: "utf8", mode: 0o640 });
          createdIdentity = entryIdentity(externalEntry);
        }
      }
    });

    await expect(writer.write(target)).rejects.toMatchObject({ code: "publish-failed" });

    expect(createdIdentity).toBeDefined();
    expect(entryIdentity(externalEntry)).toEqual(createdIdentity);
    expect(readFileSync(externalEntry, "utf8")).toBe(externalContent);
    expect(temporaryPackageNames(fixture.root)).toEqual([]);
  });

  it("preserves a same-named directory created after the target claim", async () => {
    const fixture = makeFixture("entry-directory-race");
    const target = join(fixture.root, "raced-package");
    const externalEntry = join(target, "assets");
    let createdIdentity: Readonly<Record<string, number>> | undefined;
    const writer = createRestorePackageWriter({
      guruHomeDirectory: fixture.guruHomeDirectory,
      providerRoutes: [],
      now: () => FIXED_NOW,
      fileSystem: {
        afterTargetClaim: (_source: string, claimedTarget: string) => {
          expect(claimedTarget).toBe(target);
          mkdirSync(externalEntry, { mode: 0o750 });
          createdIdentity = entryIdentity(externalEntry);
        }
      }
    });

    await expect(writer.write(target)).rejects.toMatchObject({ code: "publish-failed" });

    expect(createdIdentity).toBeDefined();
    expect(entryIdentity(externalEntry)).toEqual(createdIdentity);
    expect(readdirSync(externalEntry)).toEqual([]);
    expect(temporaryPackageNames(fixture.root)).toEqual([]);
  });

  it("rejects a fresh directory that replaces the claimed target root", async () => {
    const fixture = makeFixture("root-directory-swap");
    const target = join(fixture.root, "raced-package");
    const displacedClaim = join(fixture.root, "displaced-claimed-root");
    const externalContent = "external root must survive\n";
    let externalIdentity: Readonly<Record<string, number>> | undefined;
    const writer = createRestorePackageWriter({
      guruHomeDirectory: fixture.guruHomeDirectory,
      providerRoutes: [],
      now: () => FIXED_NOW,
      fileSystem: {
        afterTargetClaim: (_source: string, claimedTarget: string) => {
          renameSync(claimedTarget, displacedClaim);
          writeText(join(claimedTarget, "external.txt"), externalContent);
          externalIdentity = entryIdentity(claimedTarget);
        }
      }
    });

    await expect(writer.write(target)).rejects.toMatchObject({ code: "publish-failed" });

    expect(externalIdentity).toBeDefined();
    expect(entryIdentity(target)).toEqual(externalIdentity);
    expect(snapshotDirectory(target)).toEqual({ "external.txt": Buffer.from(externalContent).toString("base64") });
    expect(readdirSync(displacedClaim)).toEqual([]);
    expect(temporaryPackageNames(fixture.root)).toEqual([]);
  });

  it("rejects a directory symlink that replaces the claimed target root", async () => {
    const fixture = makeFixture("root-symlink-swap");
    const target = join(fixture.root, "raced-package");
    const displacedClaim = join(fixture.root, "displaced-claimed-root");
    const externalDirectory = join(fixture.root, "external-root");
    const externalContent = "external symlink root must survive\n";
    writeText(join(externalDirectory, "external.txt"), externalContent);
    const before = snapshotDirectory(externalDirectory);
    const writer = createRestorePackageWriter({
      guruHomeDirectory: fixture.guruHomeDirectory,
      providerRoutes: [],
      now: () => FIXED_NOW,
      fileSystem: {
        afterTargetClaim: (_source: string, claimedTarget: string) => {
          renameSync(claimedTarget, displacedClaim);
          symlinkSync(externalDirectory, claimedTarget, "dir");
        }
      }
    });

    await expect(writer.write(target)).rejects.toMatchObject({ code: "publish-failed" });

    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(snapshotDirectory(externalDirectory)).toEqual(before);
    expect(readdirSync(displacedClaim)).toEqual([]);
    expect(temporaryPackageNames(fixture.root)).toEqual([]);
  });

  it("preserves a same-named file symlink created after the target claim", async () => {
    const fixture = makeFixture("entry-file-symlink-race");
    const target = join(fixture.root, "raced-package");
    const externalFile = join(fixture.root, "external-file");
    const externalContent = "external file must survive\n";
    writeText(externalFile, externalContent);
    const externalIdentity = entryIdentity(externalFile);
    const writer = createRestorePackageWriter({
      guruHomeDirectory: fixture.guruHomeDirectory,
      providerRoutes: [],
      now: () => FIXED_NOW,
      fileSystem: {
        afterTargetClaim: (_source: string, claimedTarget: string) => {
          symlinkSync(externalFile, join(claimedTarget, "restore-manifest.json"));
        }
      }
    });

    await expect(writer.write(target)).rejects.toMatchObject({ code: "publish-failed" });

    expect(lstatSync(join(target, "restore-manifest.json")).isSymbolicLink()).toBe(true);
    expect(entryIdentity(externalFile)).toEqual(externalIdentity);
    expect(readFileSync(externalFile, "utf8")).toBe(externalContent);
    expect(temporaryPackageNames(fixture.root)).toEqual([]);
  });

  it("preserves a same-named directory symlink created after the target claim", async () => {
    const fixture = makeFixture("entry-directory-symlink-race");
    const target = join(fixture.root, "raced-package");
    const externalDirectory = join(fixture.root, "external-directory");
    writeText(join(externalDirectory, "external.txt"), "external directory must survive\n");
    const before = snapshotDirectory(externalDirectory);
    const writer = createRestorePackageWriter({
      guruHomeDirectory: fixture.guruHomeDirectory,
      providerRoutes: [],
      now: () => FIXED_NOW,
      fileSystem: {
        afterTargetClaim: (_source: string, claimedTarget: string) => {
          symlinkSync(externalDirectory, join(claimedTarget, "assets"), "dir");
        }
      }
    });

    await expect(writer.write(target)).rejects.toMatchObject({ code: "publish-failed" });

    expect(lstatSync(join(target, "assets")).isSymbolicLink()).toBe(true);
    expect(snapshotDirectory(externalDirectory)).toEqual(before);
    expect(temporaryPackageNames(fixture.root)).toEqual([]);
  });

  it("rejects a fresh directory that replaces a recursively claimed directory", async () => {
    const fixture = makeFixture("nested-directory-swap");
    const target = join(fixture.root, "raced-package");
    const displacedClaim = join(fixture.root, "displaced-assets");
    const externalContent = "external nested directory must survive\n";
    let externalIdentity: Readonly<Record<string, number>> | undefined;
    const writer = createRestorePackageWriter({
      guruHomeDirectory: fixture.guruHomeDirectory,
      providerRoutes: [],
      now: () => FIXED_NOW,
      fileSystem: {
        afterDirectoryClaim: (_source: string, claimedTarget: string) => {
          if (claimedTarget !== join(target, "assets")) return;
          renameSync(claimedTarget, displacedClaim);
          writeText(join(claimedTarget, "external.txt"), externalContent);
          externalIdentity = entryIdentity(claimedTarget);
        }
      }
    });

    await expect(writer.write(target)).rejects.toMatchObject({ code: "publish-failed" });

    expect(externalIdentity).toBeDefined();
    expect(entryIdentity(join(target, "assets"))).toEqual(externalIdentity);
    expect(snapshotDirectory(join(target, "assets"))).toEqual({
      "external.txt": Buffer.from(externalContent).toString("base64")
    });
    expect(readdirSync(displacedClaim)).toEqual([]);
    expect(temporaryPackageNames(fixture.root)).toEqual([]);
  });

  it("rejects a directory symlink that replaces a recursively claimed directory", async () => {
    const fixture = makeFixture("nested-symlink-swap");
    const target = join(fixture.root, "raced-package");
    const displacedClaim = join(fixture.root, "displaced-assets");
    const externalDirectory = join(fixture.root, "external-directory");
    writeText(join(externalDirectory, "external.txt"), "external nested symlink must survive\n");
    const before = snapshotDirectory(externalDirectory);
    const writer = createRestorePackageWriter({
      guruHomeDirectory: fixture.guruHomeDirectory,
      providerRoutes: [],
      now: () => FIXED_NOW,
      fileSystem: {
        afterDirectoryClaim: (_source: string, claimedTarget: string) => {
          if (claimedTarget !== join(target, "assets")) return;
          renameSync(claimedTarget, displacedClaim);
          symlinkSync(externalDirectory, claimedTarget, "dir");
        }
      }
    });

    await expect(writer.write(target)).rejects.toMatchObject({ code: "publish-failed" });

    expect(lstatSync(join(target, "assets")).isSymbolicLink()).toBe(true);
    expect(snapshotDirectory(externalDirectory)).toEqual(before);
    expect(readdirSync(displacedClaim)).toEqual([]);
    expect(temporaryPackageNames(fixture.root)).toEqual([]);
  });

  it("reports token and assignment patterns without returning secret text and refuses publication", async () => {
    const fixture = makeFixture("secret");
    const token = "sk-example-secret-1234567890";
    const password = "correct-horse-battery-staple";
    writeText(join(fixture.guruHomeDirectory, "skills", "leak.md"), `${token}\nPASSWORD=${password}\n`);
    const writer = createRestorePackageWriter({
      guruHomeDirectory: fixture.guruHomeDirectory,
      providerRoutes: [],
      now: () => FIXED_NOW
    });

    const manifest = await writer.generate();
    expect(manifest.secretScan.leakedSecretCount).toBeGreaterThanOrEqual(2);
    expect(manifest.secretScan.findings.some((finding) => finding.includes("openai-key"))).toBe(true);
    expect(manifest.secretScan.findings.some((finding) => finding.includes("secret-assignment"))).toBe(true);
    expect(JSON.stringify(manifest.secretScan)).not.toContain(token);
    expect(JSON.stringify(manifest.secretScan)).not.toContain(password);

    const target = join(fixture.root, "refused-package");
    let caught: unknown;
    try {
      await writer.write(target);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("unsafe finding");
    expect((caught as Error).message).not.toContain(token);
    expect((caught as Error).message).not.toContain(password);
    expect(existsSync(target)).toBe(false);
    expect(temporaryPackageNames(fixture.root)).toEqual([]);
  });

  it("treats an embedded source root as a value-free source-path finding", async () => {
    const fixture = makeFixture("source-path");
    writeText(join(fixture.guruHomeDirectory, "skills", "path.md"), `Source profile: ${fixture.guruHomeDirectory}\n`);
    const writer = createRestorePackageWriter({
      guruHomeDirectory: fixture.guruHomeDirectory,
      providerRoutes: [],
      now: () => FIXED_NOW
    });

    const manifest = await writer.generate();
    expect(manifest.secretScan.findings.some((finding) => finding.endsWith(":source-path"))).toBe(true);
    expect(JSON.stringify(manifest.secretScan)).not.toContain(fixture.guruHomeDirectory);

    const target = join(fixture.root, "source-path-package");
    await expect(writer.write(target)).rejects.toThrow("unsafe finding");
    expect(existsSync(target)).toBe(false);
  });

  it("removes its sibling temporary directory when atomic publication fails", async () => {
    const fixture = makeFixture("rename-failure");
    const rawFailure = `rename failed at ${fixture.root} with sk-never-echo-1234567890`;
    const writer = createRestorePackageWriter({
      guruHomeDirectory: fixture.guruHomeDirectory,
      providerRoutes: [],
      now: () => FIXED_NOW,
      fileSystem: {
        beforePublish: () => {
          throw new Error(rawFailure);
        }
      }
    });
    const target = join(fixture.root, "failed-package");

    let caught: unknown;
    try {
      await writer.write(target);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Restore package could not be published.");
    expect((caught as Error).message).not.toContain(fixture.root);
    expect((caught as Error).message).not.toContain("never-echo");
    expect(existsSync(target)).toBe(false);
    expect(temporaryPackageNames(fixture.root)).toEqual([]);
  });
});
