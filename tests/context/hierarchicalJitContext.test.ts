import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  hierarchicalJitContext,
  type HierarchicalJitOptions,
  type JitContextResult
} from '../../src/context/hierarchicalJitContext.js';
import {
  ContextImportCycleError,
  ContextImportEscapeError,
  contextImportProcessor,
  type ContextImportProcessorOptions
} from '../../src/context/contextImportProcessor.js';

/**
 * Hierarchical JIT context — TDD suite.
 *
 * Plan reference: IDEA-F99-JIT-CONTEXT-01.
 *
 * Owned path: tests/context/hierarchicalJitContext.test.ts.
 *
 * Exercises two owned modules in this single test file because the plan
 * owns exactly one test path: src/context/{hierarchicalJitContext,
 * contextImportProcessor}.ts and tests/context/hierarchicalJitContext.test.ts.
 *
 * RED -> GREEN: every `it` here is a contract that the implementation must
 * satisfy; the implementation file is built to make these pass.
 */

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories.length = 0;
});

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "f99-jit-"));
  tempDirectories.push(directory);
  return directory;
}

function makeRoots(): { homeRoot: string; projectRoot: string } {
  const homeRoot = makeTempDirectory();
  const projectRoot = makeTempDirectory();
  return { homeRoot, projectRoot };
}

function writeAgentsFile(directory: string, name: string, contents: string): string {
  const path = join(directory, name);
  writeFileSync(path, contents);
  return path;
}

describe("contextImportProcessor", () => {
  const baseOptions: ContextImportProcessorOptions = {
    baseDirectory: "",
    workspaceRoot: "",
    fileSystem: { kind: "fs" }
  };

  it("expands a single relative import with @path", () => {
    const baseDirectory = makeTempDirectory();
    const importedPath = join(baseDirectory, "rules.md");
    writeFileSync(importedPath, "imported content");

    const expanded = contextImportProcessor(
      ["# Top", "@./rules.md", "trailing"].join("\n"),
      { ...baseOptions, baseDirectory, workspaceRoot: baseDirectory }
    );

    expect(expanded.contents).toContain("imported content");
    expect(expanded.contents).toContain("# Top");
    expect(expanded.contents).toContain("trailing");
    expect(expanded.loadedPaths).toContain(importedPath);
  });

  it("rejects absolute import paths that escape the workspace root", () => {
    const workspaceRoot = makeTempDirectory();
    const outside = makeTempDirectory();

    expect(() =>
      contextImportProcessor(`@${outside}/leak.md`, {
        ...baseOptions,
        baseDirectory: workspaceRoot,
        workspaceRoot
      })
    ).toThrow(ContextImportEscapeError);
  });

  it("rejects parent-directory traversal in relative imports", () => {
    const workspaceRoot = makeTempDirectory();
    const nested = join(workspaceRoot, "a", "b");
    mkdirSync(nested, { recursive: true });

    expect(() =>
      contextImportProcessor("@../../escape.md", {
        ...baseOptions,
        baseDirectory: nested,
        workspaceRoot
      })
    ).toThrow(ContextImportEscapeError);
  });

  it("throws on cycles and skips already-loaded files", () => {
    const baseDirectory = makeTempDirectory();
    const aPath = join(baseDirectory, "a.md");
    const bPath = join(baseDirectory, "b.md");
    writeFileSync(aPath, "A imports @./b.md");
    writeFileSync(bPath, "B imports @./a.md");

    expect(() =>
      contextImportProcessor("@./a.md", {
        ...baseOptions,
        baseDirectory,
        workspaceRoot: baseDirectory
      })
    ).toThrow(ContextImportCycleError);
  });

  it("guards import depth and stops expanding past the cap", () => {
    const baseDirectory = makeTempDirectory();
    const chain: string[] = [];
    const depth = 12;
    for (let index = 0; index < depth; index += 1) {
      const next = join(baseDirectory, `level-${index}.md`);
      chain.push(next);
      const child = index < depth - 1 ? `@./level-${index + 1}.md` : "leaf";
      writeFileSync(next, child);
    }
    const entryPath = chain[0]!;

    const expanded = contextImportProcessor("@./level-0.md", {
      ...baseOptions,
      baseDirectory,
      workspaceRoot: baseDirectory,
      maxDepth: 5
    });

    // Imports stop before leaf when depth cap is hit.
    expect(expanded.loadedPaths.length).toBeGreaterThan(0);
    expect(expanded.loadedPaths.length).toBeLessThanOrEqual(5);
    // Entry path always present.
    expect(expanded.loadedPaths).toContain(entryPath);
    // Deepest leaf must NOT be loaded because we stopped before depth 12.
    expect(expanded.loadedPaths).not.toContain(chain[depth - 1]);
  });

  it("expands multiple imports on the same line in order", () => {
    const baseDirectory = makeTempDirectory();
    const first = join(baseDirectory, "first.md");
    const second = join(baseDirectory, "second.md");
    writeFileSync(first, "FIRST");
    writeFileSync(second, "SECOND");

    const expanded = contextImportProcessor("@./first.md and @./second.md", {
      ...baseOptions,
      baseDirectory,
      workspaceRoot: baseDirectory
    });

    expect(expanded.loadedPaths).toContain(first);
    expect(expanded.loadedPaths).toContain(second);
    const firstIndex = expanded.loadedPaths.indexOf(first);
    const secondIndex = expanded.loadedPaths.indexOf(second);
    expect(firstIndex).toBeLessThan(secondIndex);
  });
});

describe("hierarchicalJitContext", () => {
  it("orders home baseline before ancestor chain", () => {
    const { homeRoot, projectRoot } = makeRoots();
    writeAgentsFile(homeRoot, "AGENTS.md", "# HOME");
    const projectAgents = writeAgentsFile(projectRoot, "AGENTS.md", "# PROJECT");
    const targetPath = join(projectRoot, "src", "thing.ts");
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(targetPath, "export {};\n");

    const result: JitContextResult = hierarchicalJitContext({
      accessPath: targetPath,
      projectRoot,
      options: {
        homeBaselineFiles: [{ path: join(homeRoot, "AGENTS.md"), contents: "# HOME" }],
        fileNames: ["AGENTS.md"]
      }
    });

    expect(result.mergedContents).toContain("# HOME");
    expect(result.mergedContents).toContain("# PROJECT");
    expect(result.loadedPaths[0]).toBe(join(homeRoot, "AGENTS.md"));
    expect(result.loadedPaths).toContain(projectAgents);
  });

  it("walks ancestors from target up to project root", () => {
    const { homeRoot, projectRoot } = makeRoots();
    const nested = join(projectRoot, "packages", "agent");
    mkdirSync(nested, { recursive: true });
    writeAgentsFile(projectRoot, "AGENTS.md", "ROOT");
    writeAgentsFile(join(projectRoot, "packages"), "AGENTS.md", "PACKAGES");
    const targetPath = join(nested, "thing.ts");
    writeFileSync(targetPath, "export {};\n");

    const result = hierarchicalJitContext({
      accessPath: targetPath,
      projectRoot,
      options: { fileNames: ["AGENTS.md"] }
    });

    expect(result.loadedPaths.map((p) => p.replace(projectRoot, "<root>"))).toEqual([
      join("<root>", "AGENTS.md"),
      join("<root>", "packages", "AGENTS.md")
    ]);
    expect(result.mergedContents).toContain("ROOT");
    expect(result.mergedContents).toContain("PACKAGES");
  });

  it("supports configurable file names", () => {
    const { projectRoot } = makeRoots();
    const nested = join(projectRoot, "docs");
    mkdirSync(nested, { recursive: true });
    writeAgentsFile(projectRoot, "GEMINI.md", "GEMINI ROOT");
    writeAgentsFile(nested, "CLAUDE.md", "CLAUDE INNER");
    const targetPath = join(nested, "notes.md");
    writeFileSync(targetPath, "notes");

    const result = hierarchicalJitContext({
      accessPath: targetPath,
      projectRoot,
      options: { fileNames: ["GEMINI.md", "CLAUDE.md"] }
    });

    expect(result.mergedContents).toContain("GEMINI ROOT");
    expect(result.mergedContents).toContain("CLAUDE INNER");
  });

  it("skips project files when workspace is marked untrusted", () => {
    const { projectRoot } = makeRoots();
    writeAgentsFile(projectRoot, "AGENTS.md", "SHOULD NOT LOAD");
    const targetPath = join(projectRoot, "thing.ts");
    writeFileSync(targetPath, "export {};\n");

    const homeFile = writeAgentsFile(makeTempDirectory(), "AGENTS.md", "HOME OK");

    const result = hierarchicalJitContext({
      accessPath: targetPath,
      projectRoot,
      options: {
        fileNames: ["AGENTS.md"],
        trust: "untrusted",
        homeBaselineFiles: [{ path: homeFile, contents: "HOME OK" }]
      }
    });

    expect(result.mergedContents).toContain("HOME OK");
    expect(result.mergedContents).not.toContain("SHOULD NOT LOAD");
    expect(result.skipped).toContain("workspace-untrusted");
  });

  it("returns empty chain when access path is outside any known root", () => {
    const { projectRoot } = makeRoots();
    const elsewhere = makeTempDirectory();
    writeFileSync(join(elsewhere, "thing.ts"), "export {};\n");

    const result = hierarchicalJitContext({
      accessPath: join(elsewhere, "thing.ts"),
      projectRoot,
      options: { fileNames: ["AGENTS.md"] }
    });

    expect(result.loadedPaths).toEqual([]);
    expect(result.mergedContents).toBe("");
  });

  it("JIT resolution only runs on access — does not eagerly scan the project", () => {
    const { projectRoot } = makeRoots();
    // Write a sibling AGENTS.md the resolver must NOT pick up because it sits
    // outside the path from accessPath to projectRoot.
    writeAgentsFile(projectRoot, "AGENTS.md", "ROOT");
    const unrelatedDir = join(projectRoot, "unrelated");
    mkdirSync(unrelatedDir, { recursive: true });
    writeAgentsFile(unrelatedDir, "AGENTS.md", "UNRELATED");
    const targetPath = join(projectRoot, "src", "thing.ts");
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(targetPath, "export {};\n");

    const result = hierarchicalJitContext({
      accessPath: targetPath,
      projectRoot,
      options: { fileNames: ["AGENTS.md"] }
    });

    expect(result.mergedContents).not.toContain("UNRELATED");
    expect(result.mergedContents).toContain("ROOT");
  });
});
