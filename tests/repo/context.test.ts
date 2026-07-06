import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findGitRoot, readAgentsChain, resolveRepositoryContext } from "../../src/repo/context.js";
import { expectSamePath } from "../helpers/paths.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

describe("readAgentsChain", () => {
  it("should read AGENTS.md files root-to-leaf", () => {
    const root = makeTempDirectory();
    const nestedDirectory = join(root, "packages", "agent");
    mkdirSync(nestedDirectory, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "root contract");
    writeFileSync(join(root, "packages", "AGENTS.md"), "packages contract");
    writeFileSync(join(nestedDirectory, "target.ts"), "export {};\n");

    const agentsChain = readAgentsChain({ rootPath: root, targetPath: join(nestedDirectory, "target.ts") });

    expect(agentsChain.map((agentsFile) => agentsFile.relativePath)).toEqual(["AGENTS.md", "packages/AGENTS.md"]);
    expect(agentsChain.map((agentsFile) => agentsFile.contents)).toEqual(["root contract", "packages contract"]);
  });

  it("should return an empty chain when no AGENTS.md files exist", () => {
    const root = makeTempDirectory();

    expect(readAgentsChain({ rootPath: root, targetPath: root })).toEqual([]);
  });

  it("should reject target paths outside the repository root", () => {
    const root = makeTempDirectory();
    const outside = makeTempDirectory();

    expect(() => readAgentsChain({ rootPath: root, targetPath: outside })).toThrow("outside repository root");
  });
});

describe("resolveRepositoryContext", () => {
  it("should resolve git status and AGENTS.md context for a repository", () => {
    const root = makeTempDirectory();
    writeFileSync(join(root, "AGENTS.md"), "repo contract");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });

    const context = resolveRepositoryContext({ cwd: root });

    expectSamePath(context.repoRoot, root);
    expect(context.gitStatus).toContain("##");
    expect(context.agentsChain.map((agentsFile) => agentsFile.relativePath)).toEqual(["AGENTS.md"]);
  });
});

describe("findGitRoot", () => {
  it("should return undefined when no git root can be found", () => {
    const root = makeTempDirectory();

    expect(findGitRoot(root)).toBeUndefined();
  });
});

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guruharness-repo-context-"));
  tempDirectories.push(directory);

  return directory;
}
