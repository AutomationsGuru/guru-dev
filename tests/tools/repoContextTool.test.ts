import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRepoContextTool } from "../../src/tools/builtins/repoContextTool.js";
import { createToolRegistry, executeRegisteredTool } from "../../src/tools/registry.js";
import { expectSamePath } from "../helpers/paths.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

describe("createRepoContextTool", () => {
  it("should resolve repository context through the tool registry", async () => {
    const root = makeTempDirectory();
    writeFileSync(join(root, "AGENTS.md"), "repo contract");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const registry = createToolRegistry([createRepoContextTool()]);

    const observation = await executeRegisteredTool(registry, "repo.context.resolve", { cwd: root });

    expect(observation.status).toBe("succeeded");
    expectSamePath((observation.output as { repoRoot: string }).repoRoot, root);
    expect(observation.output).toMatchObject({
      agentsChain: [{ relativePath: "AGENTS.md", contents: "repo contract" }]
    });
  });
});

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guruharness-repo-tool-"));
  tempDirectories.push(directory);

  return directory;
}
