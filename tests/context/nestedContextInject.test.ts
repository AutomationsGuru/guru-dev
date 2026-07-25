import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNestedContextCache } from '../../src/context/nestedContextCache.js';
import { createNestedContextInjector } from '../../src/context/nestedContextInject.js';
import { expectSamePath } from '../helpers/paths.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guru-nested-context-"));
  tempDirectories.push(directory);
  return directory;
}

/** Monorepo fixture: root + packages + packages/agent, AGENTS.md at each level. */
function makeMonorepoFixture(): { readonly root: string; readonly target: string } {
  const root = makeTempDirectory();
  const packagesDirectory = join(root, "packages");
  const agentDirectory = join(packagesDirectory, "agent");
  mkdirSync(agentDirectory, { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "root contract");
  writeFileSync(join(packagesDirectory, "AGENTS.md"), "packages contract");
  writeFileSync(join(agentDirectory, "AGENTS.md"), "agent contract");
  writeFileSync(join(agentDirectory, "target.ts"), "export {};\n");
  return { root, target: join(agentDirectory, "target.ts") };
}

describe("createNestedContextInjector", () => {
  it("should load the root-to-leaf context chain on first access (monorepo fixture)", () => {
    const { root, target } = makeMonorepoFixture();
    const injector = createNestedContextInjector({ rootPath: root });

    const delta = injector.collect(target);

    expect(delta.chunks.map((chunk) => chunk.relativePath)).toEqual([
      "AGENTS.md",
      "packages/AGENTS.md",
      "packages/agent/AGENTS.md"
    ]);
    expect(delta.chunks.map((chunk) => chunk.contents)).toEqual(["root contract", "packages contract", "agent contract"]);
    expect(delta.alreadyCached).toEqual([]);
    expect(delta.skipped).toEqual([]);
  });

  it("should inject only the delta on subsequent accesses — never re-paste the chain", () => {
    const { root, target } = makeMonorepoFixture();
    const injector = createNestedContextInjector({ rootPath: root });

    injector.collect(target);
    const second = injector.collect(target);

    expect(second.chunks).toEqual([]);
    expect(second.alreadyCached).toHaveLength(3);
  });

  it("should inject only newly discovered nested files when the target moves deeper", () => {
    const root = makeTempDirectory();
    mkdirSync(join(root, "packages"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "root contract");
    const injector = createNestedContextInjector({ rootPath: root });

    const first = injector.collect(join(root, "packages"));
    expect(first.chunks.map((chunk) => chunk.relativePath)).toEqual(["AGENTS.md"]);

    // A nested AGENTS.md appears later (new package scaffolded mid-session).
    mkdirSync(join(root, "packages", "agent"), { recursive: true });
    writeFileSync(join(root, "packages", "agent", "AGENTS.md"), "agent contract");
    const second = injector.collect(join(root, "packages", "agent"));

    expect(second.chunks.map((chunk) => chunk.relativePath)).toEqual(["packages/agent/AGENTS.md"]);
    expect(second.alreadyCached).toHaveLength(1);
  });

  it("should reload a chunk after mtime invalidation", () => {
    const { root, target } = makeMonorepoFixture();
    const injector = createNestedContextInjector({ rootPath: root });

    injector.collect(target);
    const nestedAgentsPath = join(root, "packages", "agent", "AGENTS.md");
    writeFileSync(nestedAgentsPath, "agent contract v2");
    // Distinct, newer mtime regardless of filesystem timestamp granularity.
    utimesSync(nestedAgentsPath, new Date("2026-07-18T00:00:00Z"), new Date("2026-07-18T00:00:00Z"));

    const delta = injector.collect(target);

    expect(delta.chunks).toHaveLength(1);
    expect(delta.chunks[0]?.contents).toBe("agent contract v2");
    expect(delta.chunks[0]?.relativePath).toBe("packages/agent/AGENTS.md");
    expect(delta.alreadyCached).toHaveLength(2);
  });

  it("should never open risky-path files (no secret file load)", () => {
    const root = makeTempDirectory();
    const secretsDirectory = join(root, "secrets");
    mkdirSync(secretsDirectory, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "root contract");
    writeFileSync(join(secretsDirectory, "AGENTS.md"), "must never be read");
    const injector = createNestedContextInjector({ rootPath: root });

    const delta = injector.collect(secretsDirectory);

    expect(delta.chunks.map((chunk) => chunk.relativePath)).toEqual(["AGENTS.md"]);
    expect(delta.chunks.every((chunk) => !chunk.contents.includes("must never be read"))).toBe(true);
    expect(delta.skipped).toHaveLength(1);
    expect(delta.skipped[0]?.reason).toBe("risky-path");
  });

  it("should discover additional configured context filenames", () => {
    const root = makeTempDirectory();
    writeFileSync(join(root, "AGENTS.md"), "dox contract");
    writeFileSync(join(root, "CONTEXT.md"), "extra context");
    const injector = createNestedContextInjector({ rootPath: root, contextFilenames: ["AGENTS.md", "CONTEXT.md"] });

    const delta = injector.collect(root);

    expect(delta.chunks.map((chunk) => chunk.relativePath)).toEqual(["AGENTS.md", "CONTEXT.md"]);
  });

  it("should resolve file targets to their containing directory", () => {
    const { root, target } = makeMonorepoFixture();
    const injector = createNestedContextInjector({ rootPath: root });

    expectSamePath(injector.discover(target)[2] ?? "", join(root, "packages", "agent", "AGENTS.md"));
  });

  it("should skip oversized files without loading them", () => {
    const root = makeTempDirectory();
    writeFileSync(join(root, "AGENTS.md"), "x".repeat(64));
    const injector = createNestedContextInjector({ rootPath: root, maxFileBytes: 16 });

    const delta = injector.collect(root);

    expect(delta.chunks).toEqual([]);
    expect(delta.skipped[0]?.reason).toContain("too-large");
    expect(injector.cache.size).toBe(0);
  });

  it("should return an empty delta when no context files exist", () => {
    const root = makeTempDirectory();
    const injector = createNestedContextInjector({ rootPath: root });

    expect(injector.collect(root)).toEqual({ chunks: [], alreadyCached: [], skipped: [] });
  });

  it("should share a provided cache across injectors (one session cache)", () => {
    const { root, target } = makeMonorepoFixture();
    const cache = createNestedContextCache();
    const first = createNestedContextInjector({ rootPath: root, cache });
    const second = createNestedContextInjector({ rootPath: root, cache });

    first.collect(target);
    const delta = second.collect(target);

    expect(delta.chunks).toEqual([]);
    expect(delta.alreadyCached).toHaveLength(3);
  });
});

describe("createNestedContextCache", () => {
  it("should serve fresh entries and report size", () => {
    const root = makeTempDirectory();
    const filePath = join(root, "AGENTS.md");
    writeFileSync(filePath, "contract");
    const cache = createNestedContextCache();

    cache.record({ path: filePath, contents: "contract" });

    expect(cache.size).toBe(1);
    expect(cache.getFresh(filePath)?.contents).toBe("contract");
    expect(cache.keys()).toHaveLength(1);
  });

  it("should invalidate on mtime or size change", () => {
    const root = makeTempDirectory();
    const filePath = join(root, "AGENTS.md");
    writeFileSync(filePath, "v1");
    const cache = createNestedContextCache();
    cache.record({ path: filePath, contents: "v1" });

    writeFileSync(filePath, "v2-longer");
    utimesSync(filePath, new Date("2026-07-18T00:00:00Z"), new Date("2026-07-18T00:00:00Z"));

    expect(cache.getFresh(filePath)).toBeUndefined();
    expect(cache.peek(filePath)?.contents).toBe("v1");
  });

  it("should remember errored loads without serving them as fresh", () => {
    const root = makeTempDirectory();
    const missingPath = join(root, "AGENTS.md");
    const cache = createNestedContextCache();

    cache.record({ path: missingPath, error: "ENOENT" });

    expect(cache.size).toBe(1);
    expect(cache.getFresh(missingPath)).toBeUndefined();
    expect(cache.peek(missingPath)?.error).toBe("ENOENT");
  });

  it("should support invalidate and clear", () => {
    const root = makeTempDirectory();
    const filePath = join(root, "AGENTS.md");
    writeFileSync(filePath, "contract");
    const cache = createNestedContextCache();
    cache.record({ path: filePath, contents: "contract" });

    expect(cache.invalidate(filePath)).toBe(true);
    expect(cache.invalidate(filePath)).toBe(false);

    cache.record({ path: filePath, contents: "contract" });
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
