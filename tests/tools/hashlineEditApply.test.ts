import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHashlineEditApplyTool } from '../../src/tools/hashlineEditApply.js';
import { createToolRegistry, executeRegisteredTool } from '../../src/tools/registry.js';

const tempDirectories: string[] = [];
const riskyPathPatterns = [".git", ".env", "secrets", "credentials", "id_rsa"];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

describe("createHashlineEditApplyTool", () => {
  it("applies a write when the expected hash matches the on-disk content", async () => {
    const repoRoot = makeTempDirectory();
    const filePath = "letter.txt";
    writeFileSync(join(repoRoot, filePath), "original body\n");
    const expectedHash = sha256("original body\n");
    const registry = createRegistry();

    const observation = await executeRegisteredTool(registry, "fs.edit.hashline", {
      repoRoot,
      path: filePath,
      expectedHash,
      contents: "revised body\n",
      dryRun: false
    });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({
      applied: true,
      dryRun: false,
      path: filePath,
      hashMatched: true
    });
    expect(readFileSync(join(repoRoot, filePath), "utf8")).toBe("revised body\n");
  });

  it("rejects a stale hash without writing (file changed since hash was computed)", async () => {
    const repoRoot = makeTempDirectory();
    const filePath = "letter.txt";
    writeFileSync(join(repoRoot, filePath), "original body\n");
    const expectedHash = sha256("original body\n");
    // Some other writer mutates the file after the hash was captured.
    writeFileSync(join(repoRoot, filePath), "sneaky concurrent edit\n");
    const registry = createRegistry();

    const observation = await executeRegisteredTool(registry, "fs.edit.hashline", {
      repoRoot,
      path: filePath,
      expectedHash,
      contents: "revised body\n",
      dryRun: false
    });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({ applied: false, hashMatched: false });
    expect(JSON.stringify(observation.output)).toContain("stale");
    // The on-disk content is untouched by the rejected write.
    expect(readFileSync(join(repoRoot, filePath), "utf8")).toBe("sneaky concurrent edit\n");
  });

  it("reports a stale hash when the target file does not exist yet", async () => {
    const repoRoot = makeTempDirectory();
    const filePath = "notes/missing.txt";
    const expectedHash = sha256("original body\n");
    const registry = createRegistry();

    const observation = await executeRegisteredTool(registry, "fs.edit.hashline", {
      repoRoot,
      path: filePath,
      expectedHash,
      contents: "revised body\n",
      dryRun: false
    });

    expect(observation.output).toMatchObject({ applied: false, hashMatched: false });
    expect(JSON.stringify(observation.output)).toContain("stale");
  });

  it("applies when expectedHash is empty and the file is empty (fresh empty anchor)", async () => {
    const repoRoot = makeTempDirectory();
    const filePath = "empty.txt";
    writeFileSync(join(repoRoot, filePath), "");
    const registry = createRegistry();

    const observation = await executeRegisteredTool(registry, "fs.edit.hashline", {
      repoRoot,
      path: filePath,
      expectedHash: sha256(""),
      contents: "now populated\n",
      dryRun: false
    });

    expect(observation.output).toMatchObject({ applied: true, hashMatched: true });
    expect(readFileSync(join(repoRoot, filePath), "utf8")).toBe("now populated\n");
  });

  it("returns a dry-run preview without writing when the hash matches", async () => {
    const repoRoot = makeTempDirectory();
    const filePath = "letter.txt";
    writeFileSync(join(repoRoot, filePath), "original body\n");
    const expectedHash = sha256("original body\n");
    const registry = createRegistry();

    const observation = await executeRegisteredTool(registry, "fs.edit.hashline", {
      repoRoot,
      path: filePath,
      expectedHash,
      contents: "revised body\n",
      dryRun: true
    });

    expect(observation.output).toMatchObject({ applied: false, dryRun: true, hashMatched: true });
    expect(JSON.stringify(observation.output)).toContain("redacted proposed content");
    expect(readFileSync(join(repoRoot, filePath), "utf8")).toBe("original body\n");
  });

  it("blocks traversal and risky target paths before any hash check", async () => {
    const repoRoot = makeTempDirectory();
    const registry = createRegistry();

    const traversal = await executeRegisteredTool(registry, "fs.edit.hashline", {
      repoRoot,
      path: "../outside.txt",
      expectedHash: sha256("anything"),
      contents: "nope",
      dryRun: false
    });

    expect(traversal.output).toMatchObject({ applied: false });
    expect(JSON.stringify(traversal.output)).toContain("escapes the repository root");
  });

  it("exposes a helper to compute the content-hash used as the anchor", () => {
    expect(createHashlineEditApplyTool().hashContent("hello\n")).toBe(sha256("hello\n"));
  });
});

function createRegistry() {
  return createToolRegistry([
    createHashlineEditApplyTool({
      riskyPathPatterns,
      secretAllowList: [],
      allowRiskyPaths: false
    })
  ]);
}

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guruharness-hashline-tool-"));
  tempDirectories.push(directory);

  return directory;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
