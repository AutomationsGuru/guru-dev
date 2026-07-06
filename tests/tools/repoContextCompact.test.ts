import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRepoContextTool } from "../../src/tools/builtins/repoContextTool.js";
import { createToolRegistry, executeRegisteredTool } from "../../src/tools/registry.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "guru-repo-compact-"));
  dirs.push(root);
  writeFileSync(join(root, "AGENTS.md"), "x".repeat(5000));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  return root;
}

describe("repo.context.resolve includeContents", () => {
  it("includes full contents by default (backward compatible)", async () => {
    const registry = createToolRegistry([createRepoContextTool()]);
    const obs = await executeRegisteredTool(registry, "repo.context.resolve", { cwd: repo() });
    const chain = (obs.output as { agentsChain: Array<{ contents?: string; bytes?: number }> }).agentsChain;

    expect(obs.status).toBe("succeeded");
    expect(chain[0]?.contents).toHaveLength(5000);
    expect(chain[0]?.bytes).toBeUndefined();
  });

  it("omits contents and reports bytes when includeContents=false (token-efficient)", async () => {
    const registry = createToolRegistry([createRepoContextTool()]);
    const root = repo();
    const full = await executeRegisteredTool(registry, "repo.context.resolve", { cwd: root, includeContents: true });
    const compact = await executeRegisteredTool(registry, "repo.context.resolve", { cwd: root, includeContents: false });
    const chain = (compact.output as { agentsChain: Array<{ contents?: string; bytes?: number; relativePath: string }> }).agentsChain;

    expect(chain[0]?.contents).toBeUndefined();
    expect(chain[0]?.bytes).toBe(5000);
    expect(chain[0]?.relativePath).toBe("AGENTS.md");
    // Compact payload must be dramatically smaller than the full one.
    expect(JSON.stringify(compact.output).length).toBeLessThan(JSON.stringify(full.output).length / 5);
  });
});
