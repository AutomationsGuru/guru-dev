import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileEditTool } from "../../src/tools/builtins/fileEditTool.js";
import { createToolRegistry, executeRegisteredTool } from "../../src/tools/registry.js";

const tempDirectories: string[] = [];
const riskyPathPatterns = [".git", ".env", "secrets", "credentials", "id_rsa"];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

describe("createFileEditTool", () => {
  it("returns a dry-run preview without writing", async () => {
    const repoRoot = makeTempDirectory();
    const registry = createRegistry();

    const observation = await executeRegisteredTool(registry, "fs.edit.apply", {
      repoRoot,
      path: "notes/result.txt",
      mode: "createOnly",
      contents: "hello",
      dryRun: true
    });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({ applied: false, dryRun: true, blockers: [] });
    expect(JSON.stringify(observation.output)).toContain("redacted proposed content");
    expect(existsSync(join(repoRoot, "notes", "result.txt"))).toBe(false);
  });

  it("applies a createOnly write when the target is absent", async () => {
    const repoRoot = makeTempDirectory();
    const registry = createRegistry();

    const observation = await executeRegisteredTool(registry, "fs.edit.apply", {
      repoRoot,
      path: "result.txt",
      mode: "createOnly",
      contents: "created",
      dryRun: false
    });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({ applied: true, dryRun: false, path: "result.txt" });
    expect(readFileSync(join(repoRoot, "result.txt"), "utf8")).toBe("created");
  });

  it("refuses createOnly when the target exists", async () => {
    const repoRoot = makeTempDirectory();
    writeFileSync(join(repoRoot, "result.txt"), "existing");
    const registry = createRegistry();

    const observation = await executeRegisteredTool(registry, "fs.edit.apply", {
      repoRoot,
      path: "result.txt",
      mode: "createOnly",
      contents: "new",
      dryRun: false
    });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({ applied: false });
    expect(JSON.stringify(observation.output)).toContain("createOnly refused");
    expect(readFileSync(join(repoRoot, "result.txt"), "utf8")).toBe("existing");
  });

  it("blocks traversal and risky target paths", async () => {
    const repoRoot = makeTempDirectory();
    const registry = createRegistry();

    const traversal = await executeRegisteredTool(registry, "fs.edit.apply", {
      repoRoot,
      path: "../outside.txt",
      contents: "nope",
      dryRun: false
    });
    const risky = await executeRegisteredTool(registry, "fs.edit.apply", {
      repoRoot,
      path: ".env",
      contents: "SAFE_PLACEHOLDER=value",
      dryRun: false
    });

    expect(traversal.output).toMatchObject({ applied: false });
    expect(JSON.stringify(traversal.output)).toContain("escapes the repository root");
    expect(risky.output).toMatchObject({ applied: false });
    expect(JSON.stringify(risky.output)).toContain("risky-path policy");
  });

  it("blocks secret-like file contents without leaking the secret", async () => {
    const repoRoot = makeTempDirectory();
    const registry = createRegistry();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";

    const observation = await executeRegisteredTool(registry, "fs.edit.apply", {
      repoRoot,
      path: "result.txt",
      mode: "createOnly",
      contents: `token=${secret}`,
      dryRun: false
    });

    expect(observation.output).toMatchObject({ applied: false });
    expect(JSON.stringify(observation.output)).toContain("github-token");
    expect(JSON.stringify(observation.output)).not.toContain(secret);
    expect(existsSync(join(repoRoot, "result.txt"))).toBe(false);
  });
});

function createRegistry() {
  return createToolRegistry([
    createFileEditTool({
      riskyPathPatterns,
      secretAllowList: [],
      allowRiskyPaths: false
    })
  ]);
}

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guruharness-file-tool-"));
  tempDirectories.push(directory);

  return directory;
}
