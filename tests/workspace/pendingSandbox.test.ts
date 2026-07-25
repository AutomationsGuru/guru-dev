import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPendingSandbox } from '../../src/workspace/pendingSandbox.js';
import { PendingOpSchema, PendingSandboxStoreSchema } from '../../src/workspace/pendingSandboxSchema.js';

const tempDirectories: string[] = [];
let clockTick = 0;

function makeRepoRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "pending-sandbox-"));
  tempDirectories.push(directory);
  return directory;
}

function nextNow(): string {
  // Distinct timestamps keep backup names unique within a test.
  return new Date(Date.UTC(2026, 6, 18, 0, 0, clockTick++)).toISOString();
}

function storePath(repoRoot: string): string {
  return join(repoRoot, ".guru", "pending", "pending.json");
}

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories.length = 0;
  clockTick = 0;
});

describe("pendingSandbox schema", () => {
  it("accepts a well-formed create op", () => {
    const op = PendingOpSchema.parse({
      id: "pend-1-abc123def456",
      path: "notes/result.txt",
      kind: "create",
      contentHash: "a".repeat(64),
      fullContent: "hello",
      sourceTurnId: "turn-1",
      createdAt: new Date(0).toISOString()
    });
    expect(op.kind).toBe("create");
  });

  it("refuses a create op without content or hash", () => {
    expect(() =>
      PendingOpSchema.parse({
        id: "pend-1",
        path: "a.txt",
        kind: "create",
        sourceTurnId: "turn-1",
        createdAt: new Date(0).toISOString()
      })
    ).toThrow();
  });

  it("refuses a delete op carrying content", () => {
    expect(() =>
      PendingOpSchema.parse({
        id: "pend-1",
        path: "a.txt",
        kind: "delete",
        fullContent: "x",
        sourceTurnId: "turn-1",
        createdAt: new Date(0).toISOString()
      })
    ).toThrow();
  });
});

describe("pendingSandbox stage", () => {
  it("stages an op with no working-tree change", async () => {
    const repoRoot = makeRepoRoot();
    const sandbox = createPendingSandbox({ repoRoot, enabled: true, now: nextNow });

    const op = await sandbox.stage({ path: "notes/result.txt", kind: "create", content: "hello", sourceTurnId: "turn-1" });

    expect(op.path).toBe("notes/result.txt");
    expect(op.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(repoRoot, "notes", "result.txt"))).toBe(false);
    const stored = PendingSandboxStoreSchema.parse(JSON.parse(readFileSync(storePath(repoRoot), "utf8")));
    expect(stored.ops).toHaveLength(1);
    expect(stored.ops[0]?.id).toBe(op.id);
  });

  it("rejects paths escaping the repo root", async () => {
    const repoRoot = makeRepoRoot();
    const sandbox = createPendingSandbox({ repoRoot, enabled: true, now: nextNow });

    await expect(sandbox.stage({ path: "../outside.txt", kind: "create", content: "x", sourceTurnId: "turn-1" })).rejects.toThrow(/escapes repoRoot/);
  });
});

describe("pendingSandbox list and reject", () => {
  it("lists staged ops and rejects by path without touching disk", async () => {
    const repoRoot = makeRepoRoot();
    const sandbox = createPendingSandbox({ repoRoot, enabled: true, now: nextNow });
    await sandbox.stage({ path: "a.txt", kind: "create", content: "a", sourceTurnId: "turn-1" });
    await sandbox.stage({ path: "b.txt", kind: "create", content: "b", sourceTurnId: "turn-1" });

    expect((await sandbox.list()).map((op) => op.path)).toEqual(["a.txt", "b.txt"]);

    const removed = await sandbox.reject(["a.txt"]);
    expect(removed.map((op) => op.path)).toEqual(["a.txt"]);
    expect((await sandbox.list()).map((op) => op.path)).toEqual(["b.txt"]);
    expect(existsSync(join(repoRoot, "a.txt"))).toBe(false);
    expect(existsSync(join(repoRoot, "b.txt"))).toBe(false);
  });
});

describe("pendingSandbox apply", () => {
  it("applies a staged create to disk and clears it from the store", async () => {
    const repoRoot = makeRepoRoot();
    const sandbox = createPendingSandbox({ repoRoot, enabled: true, now: nextNow });
    await sandbox.stage({ path: "notes/result.txt", kind: "create", content: "hello", sourceTurnId: "turn-1" });

    const results = await sandbox.apply();

    expect(results).toEqual([{ path: "notes/result.txt", applied: true, blockers: [] }]);
    expect(readFileSync(join(repoRoot, "notes", "result.txt"), "utf8")).toBe("hello");
    expect(await sandbox.list()).toEqual([]);
  });

  it("applies only the selected paths", async () => {
    const repoRoot = makeRepoRoot();
    const sandbox = createPendingSandbox({ repoRoot, enabled: true, now: nextNow });
    await sandbox.stage({ path: "a.txt", kind: "create", content: "a", sourceTurnId: "turn-1" });
    await sandbox.stage({ path: "b.txt", kind: "create", content: "b", sourceTurnId: "turn-1" });

    const results = await sandbox.apply(["a.txt"]);

    expect(results.map((r) => r.path)).toEqual(["a.txt"]);
    expect(readFileSync(join(repoRoot, "a.txt"), "utf8")).toBe("a");
    expect(existsSync(join(repoRoot, "b.txt"))).toBe(false);
    expect((await sandbox.list()).map((op) => op.path)).toEqual(["b.txt"]);
  });

  it("backs up prior state before an update (no destruction without preservation)", async () => {
    const repoRoot = makeRepoRoot();
    writeFileSync(join(repoRoot, "existing.txt"), "original");
    const sandbox = createPendingSandbox({ repoRoot, enabled: true, now: nextNow });
    await sandbox.stage({ path: "existing.txt", kind: "update", content: "revised", sourceTurnId: "turn-1" });

    const [result] = await sandbox.apply();

    expect(result?.applied).toBe(true);
    expect(result?.backupPath).toBeDefined();
    expect(readFileSync(join(repoRoot, "existing.txt"), "utf8")).toBe("revised");
    expect(readFileSync(join(repoRoot, ...result!.backupPath!.split("/")), "utf8")).toBe("original");
  });

  it("backs up prior state before a delete", async () => {
    const repoRoot = makeRepoRoot();
    writeFileSync(join(repoRoot, "doomed.txt"), "keep me");
    const sandbox = createPendingSandbox({ repoRoot, enabled: true, now: nextNow });
    await sandbox.stage({ path: "doomed.txt", kind: "delete", sourceTurnId: "turn-1" });

    const [result] = await sandbox.apply();

    expect(result?.applied).toBe(true);
    expect(result?.backupPath).toBeDefined();
    expect(existsSync(join(repoRoot, "doomed.txt"))).toBe(false);
    expect(readFileSync(join(repoRoot, ...result!.backupPath!.split("/")), "utf8")).toBe("keep me");
  });

  it("blocks a create whose target appeared after staging and keeps the op staged", async () => {
    const repoRoot = makeRepoRoot();
    const sandbox = createPendingSandbox({ repoRoot, enabled: true, now: nextNow });
    await sandbox.stage({ path: "conflict.txt", kind: "create", content: "staged", sourceTurnId: "turn-1" });
    writeFileSync(join(repoRoot, "conflict.txt"), "concurrent");

    const [result] = await sandbox.apply();

    expect(result?.applied).toBe(false);
    expect(result?.blockers[0]).toContain("already exists");
    expect(readFileSync(join(repoRoot, "conflict.txt"), "utf8")).toBe("concurrent");
    expect((await sandbox.list()).map((op) => op.path)).toEqual(["conflict.txt"]);
  });

  it("blocks a delete whose target is already absent", async () => {
    const repoRoot = makeRepoRoot();
    const sandbox = createPendingSandbox({ repoRoot, enabled: true, now: nextNow });
    await sandbox.stage({ path: "ghost.txt", kind: "delete", sourceTurnId: "turn-1" });

    const [result] = await sandbox.apply();

    expect(result?.applied).toBe(false);
    expect(result?.blockers[0]).toContain("already absent");
  });
});

describe("pendingSandbox disabled mode (passthrough)", () => {
  it("stageOrWrite writes through unchanged when disabled (YOLO default)", async () => {
    const repoRoot = makeRepoRoot();
    const sandbox = createPendingSandbox({ repoRoot, now: nextNow });

    const result = await sandbox.stageOrWrite({ path: "notes/direct.txt", kind: "create", content: "through", sourceTurnId: "turn-1" });

    expect(result).toEqual({ staged: false, applied: true, path: "notes/direct.txt", blockers: [] });
    expect(readFileSync(join(repoRoot, "notes", "direct.txt"), "utf8")).toBe("through");
    expect(existsSync(storePath(repoRoot))).toBe(false);
  });

  it("stageOrWrite deletes through when disabled", async () => {
    const repoRoot = makeRepoRoot();
    writeFileSync(join(repoRoot, "old.txt"), "gone");
    const sandbox = createPendingSandbox({ repoRoot, enabled: false, now: nextNow });

    const result = await sandbox.stageOrWrite({ path: "old.txt", kind: "delete", sourceTurnId: "turn-1" });

    expect(result.staged).toBe(false);
    expect(existsSync(join(repoRoot, "old.txt"))).toBe(false);
  });

  it("stageOrWrite stages without writing when enabled", async () => {
    const repoRoot = makeRepoRoot();
    const sandbox = createPendingSandbox({ repoRoot, enabled: true, now: nextNow });

    const result = await sandbox.stageOrWrite({ path: "staged.txt", kind: "create", content: "held", sourceTurnId: "turn-1" });

    expect(result).toEqual({ staged: true, applied: false, path: "staged.txt", blockers: [] });
    expect(existsSync(join(repoRoot, "staged.txt"))).toBe(false);
    expect((await sandbox.list()).map((op) => op.path)).toEqual(["staged.txt"]);
  });
});
