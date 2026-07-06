import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createToolRegistry, executeRegisteredTool } from "../../src/tools/registry.js";
import { createBaseTools } from "../../src/tools/builtins/baseToolFactory.js";
import { createPiBashTool } from "../../src/tools/builtins/bashTool.js";

describe("base tools", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "guruharness-pibase-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("should read with offset and limit", async () => {
    await writeFile(join(repoRoot, "sample.txt"), "abcdef", "utf8");
    const registry = createToolRegistry(createBaseTools());
    const observation = await executeRegisteredTool(registry, "read", { repoRoot, path: "sample.txt", offset: 2, limit: 3 });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({ contents: "cde", bytesRead: 3, truncated: true });
  });

  it("should write with dry-run default and apply when requested", async () => {
    const registry = createToolRegistry(createBaseTools({ write: { riskyPathPatterns: [".env"], secretAllowList: [] } }));
    const dryRun = await executeRegisteredTool(registry, "write", { repoRoot, path: "nested/out.txt", contents: "hello" });
    expect(dryRun.output).toMatchObject({ applied: false, dryRun: true });

    const applied = await executeRegisteredTool(registry, "write", { repoRoot, path: "nested/out.txt", contents: "hello", dryRun: false });
    expect(applied.output).toMatchObject({ applied: true, dryRun: false });
    await expect(readFile(join(repoRoot, "nested", "out.txt"), "utf8")).resolves.toBe("hello");
  });

  it("should enforce exact edit uniqueness", async () => {
    await writeFile(join(repoRoot, "edit.txt"), "one two one", "utf8");
    const registry = createToolRegistry(createBaseTools({ edit: { riskyPathPatterns: [], secretAllowList: [] } }));
    const blocked = await executeRegisteredTool(registry, "edit", { repoRoot, path: "edit.txt", oldText: "one", newText: "three" });
    expect(blocked.output).toMatchObject({ applied: false, replacements: 0 });

    const applied = await executeRegisteredTool(registry, "edit", { repoRoot, path: "edit.txt", oldText: "one", newText: "three", replaceAll: true, dryRun: false });
    expect(applied.output).toMatchObject({ applied: true, replacements: 2 });
  });

  it("should run bash through an injected executor", async () => {
    const registry = createToolRegistry(createBaseTools({ bash: { shellAllowlist: ["node"], executor: async () => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }) } }));
    const observation = await executeRegisteredTool(registry, "bash", { repoRoot, command: "node", args: ["script.js"], dryRun: false });
    expect(observation.output).toMatchObject({ executed: true, exitCode: 0, stdout: "ok" });
  });
});

describe("bash full-command-line handling (shakedown fixes)", () => {
  it("splits a full command line into argv when args are omitted", async () => {
    let seen: readonly string[] = [];
    const tool = createPiBashTool({
      shellAllowlist: ["npm"],
      executor: async (command, _context) => {
        seen = command;
        return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 5 };
      }
    });
    const output = await tool.execute({
      repoRoot: process.cwd(),
      command: "npm test",
      args: [],
      timeoutMs: 5000,
      maxOutputBytes: 64000,
      dryRun: false
    }, {});

    expect(seen).toEqual(["npm", "test"]);
    expect(output.executed).toBe(true);
  });

  it("keeps quoted arguments together when splitting", async () => {
    let seen: readonly string[] = [];
    const tool = createPiBashTool({
      shellAllowlist: ["git"],
      executor: async (command, _context) => {
        seen = command;
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 5 };
      }
    });
    await tool.execute({
      repoRoot: process.cwd(),
      command: 'git commit -m "two words"',
      args: [],
      timeoutMs: 5000,
      maxOutputBytes: 64000,
      dryRun: false
    }, {});

    expect(seen).toEqual(["git", "commit", "-m", "two words"]);
  });

  it("still blocks non-allowlisted executables after splitting", async () => {
    const tool = createPiBashTool({ shellAllowlist: ["npm"] });
    const output = await tool.execute({
      repoRoot: process.cwd(),
      command: "curl http://example.com",
      args: [],
      timeoutMs: 5000,
      maxOutputBytes: 64000,
      dryRun: false
    }, {});

    expect(output.executed).toBe(false);
    expect(output.blockers.some((blocker) => blocker.includes("allowlisted"))).toBe(true);
  });
});
