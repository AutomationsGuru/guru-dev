import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApplyCommandQueue, type CommandApplyOutcome } from '../../src/workspace/applyCommandQueue.js';
import {
  APPLY_COMMAND_MAX_TIMEOUT_MS,
  ApplyCommandSchema
} from '../../src/workspace/applyCommandQueueSchema.js';

const tempDirectories: string[] = [];
let clockTick = 0;

function makeRepoRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "apply-cmdq-"));
  tempDirectories.push(directory);
  return directory;
}

function nextNow(): string {
  return new Date(Date.UTC(2026, 6, 18, 0, 0, clockTick++)).toISOString();
}

/** Create a file, apply an update with a recorded backup, and return the outcome + original content. */
function appliedUpdateOutcome(repoRoot: string, relPath: string, original: string, revised: string): CommandApplyOutcome {
  const target = join(repoRoot, ...relPath.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, original);
  const backupRel = `.guru/pending/backups/test-${relPath.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  const backupTarget = join(repoRoot, ...backupRel.split("/"));
  mkdirSync(join(backupTarget, ".."), { recursive: true });
  writeFileSync(backupTarget, original);
  // Simulate a successful apply.
  writeFileSync(target, revised);
  return { path: relPath, applied: true, backupPath: backupRel, blockers: [] };
}

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories.length = 0;
  clockTick = 0;
});

describe("applyCommandQueue schema", () => {
  it("accepts a well-formed command and applies defaults", () => {
    const command = ApplyCommandSchema.parse({ argv: ["node", "-v"] });
    expect(command.cwd).toBe(".");
    expect(command.timeoutMs).toBe(30_000);
    expect(command.rollbackPolicy).toBe("require");
  });

  it("rejects an empty argv or empty argv element", () => {
    expect(() => ApplyCommandSchema.parse({ argv: [] })).toThrow();
    expect(() => ApplyCommandSchema.parse({ argv: [""] })).toThrow();
  });

  it("rejects timeouts outside the bounded range", () => {
    expect(() => ApplyCommandSchema.parse({ argv: ["node"], timeoutMs: 0 })).toThrow();
    expect(() => ApplyCommandSchema.parse({ argv: ["node"], timeoutMs: APPLY_COMMAND_MAX_TIMEOUT_MS + 1 })).toThrow();
    expect(() => ApplyCommandSchema.parse({ argv: ["node"], timeoutMs: 12.5 })).toThrow();
  });

  it("rejects unknown rollback policies and extra keys", () => {
    expect(() => ApplyCommandSchema.parse({ argv: ["node"], rollbackPolicy: "sometimes" })).toThrow();
    expect(() => ApplyCommandSchema.parse({ argv: ["node"], shell: true })).toThrow();
  });
});

describe("applyCommandQueue skip paths", () => {
  it("skips cleanly when the queue is empty", async () => {
    const repoRoot = makeRepoRoot();
    const queue = createApplyCommandQueue({ repoRoot, now: nextNow });
    const outcome = appliedUpdateOutcome(repoRoot, "a.txt", "before", "after");

    const result = await queue.executeAfterApply([outcome]);

    expect(result).toEqual({
      ran: false,
      skipReason: "empty queue",
      results: [],
      rolledBack: false,
      restoredPaths: [],
      rollbackBlockers: [],
      allOk: true
    });
    // Skip never touches the applied file.
    expect(readFileSync(join(repoRoot, "a.txt"), "utf8")).toBe("after");
  });

  it("skips cleanly when nothing was applied, even with staged commands", async () => {
    const repoRoot = makeRepoRoot();
    const queue = createApplyCommandQueue({ repoRoot, now: nextNow });
    queue.stage({ argv: ["node", "-e", "process.exit(1)"] });
    const blocked: CommandApplyOutcome = { path: "a.txt", applied: false, blockers: ["Target already exists"] };

    const result = await queue.executeAfterApply([blocked]);

    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("no applied ops");
    expect(result.results).toEqual([]);
    expect(result.rolledBack).toBe(false);
  });
});

describe("applyCommandQueue success path", () => {
  it("runs staged commands post-apply in repo cwd and reports ok", async () => {
    const repoRoot = makeRepoRoot();
    const queue = createApplyCommandQueue({ repoRoot, now: nextNow });
    const outcome = appliedUpdateOutcome(repoRoot, "a.txt", "before", "after");
    queue.stage({ argv: ["node", "-e", "console.log(process.cwd())"] });
    queue.stage({ argv: ["node", "-e", "console.log('second')"], rollbackPolicy: "report" });

    const result = await queue.executeAfterApply([outcome]);

    expect(result.ran).toBe(true);
    expect(result.allOk).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.status).toBe("ok");
    expect(result.results[0]?.exitCode).toBe(0);
    expect(result.results[0]?.stdout.trim()).toBe(repoRoot);
    expect(result.results[1]?.stdout.trim()).toBe("second");
    // Staged queue drains on execution.
    const secondRun = await queue.executeAfterApply([outcome]);
    expect(secondRun.ran).toBe(false);
    expect(secondRun.skipReason).toBe("empty queue");
  });

  it("honours per-command cwd relative to the repo root", async () => {
    const repoRoot = makeRepoRoot();
    mkdirSync(join(repoRoot, "sub"), { recursive: true });
    const queue = createApplyCommandQueue({ repoRoot, now: nextNow });
    const outcome = appliedUpdateOutcome(repoRoot, "a.txt", "before", "after");

    const result = await queue.executeAfterApply([outcome], [
      { argv: ["node", "-e", "console.log(process.cwd())"], cwd: "sub" }
    ]);

    expect(result.allOk).toBe(true);
    expect(result.results[0]?.stdout.trim()).toBe(join(repoRoot, "sub"));
  });

  it("rejects a cwd that escapes the repo root", async () => {
    const repoRoot = makeRepoRoot();
    const queue = createApplyCommandQueue({ repoRoot, now: nextNow });
    const outcome = appliedUpdateOutcome(repoRoot, "a.txt", "before", "after");

    await expect(
      queue.executeAfterApply([outcome], [{ argv: ["node", "-v"], cwd: "../outside" }])
    ).rejects.toThrow(/escapes repoRoot/);
    // Nothing ran and nothing rolled back.
    expect(readFileSync(join(repoRoot, "a.txt"), "utf8")).toBe("after");
  });
});

describe("applyCommandQueue failure path with rollbackPolicy=require", () => {
  it("restores applied files from backup and stops the queue", async () => {
    const repoRoot = makeRepoRoot();
    const queue = createApplyCommandQueue({ repoRoot, now: nextNow });
    const first = appliedUpdateOutcome(repoRoot, "one.txt", "original-one", "revised-one");
    const second = appliedUpdateOutcome(repoRoot, "two.txt", "original-two", "revised-two");

    const result = await queue.executeAfterApply([first, second], [
      { argv: ["node", "-e", "console.log('before-fail')"] },
      { argv: ["node", "-e", "console.error('boom'); process.exit(3)"] },
      { argv: ["node", "-e", "console.log('never-runs')"] }
    ]);

    expect(result.ran).toBe(true);
    expect(result.allOk).toBe(false);
    expect(result.rolledBack).toBe(true);
    // Later applies restore first (reverse order).
    expect(result.restoredPaths).toEqual(["two.txt", "one.txt"]);
    expect(result.rollbackBlockers).toEqual([]);
    expect(readFileSync(join(repoRoot, "one.txt"), "utf8")).toBe("original-one");
    expect(readFileSync(join(repoRoot, "two.txt"), "utf8")).toBe("original-two");
    // Queue stops at the failing command.
    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.status).toBe("ok");
    expect(result.results[1]?.status).toBe("failed");
    expect(result.results[1]?.exitCode).toBe(3);
    expect(result.results[1]?.stderr).toContain("boom");
  });

  it("reports create ops (no backup) as rollback blockers without touching the created file", async () => {
    const repoRoot = makeRepoRoot();
    const queue = createApplyCommandQueue({ repoRoot, now: nextNow });
    writeFileSync(join(repoRoot, "created.txt"), "new content");
    const createOutcome: CommandApplyOutcome = { path: "created.txt", applied: true, blockers: [] };

    const result = await queue.executeAfterApply([createOutcome], [
      { argv: ["node", "-e", "process.exit(1)"] }
    ]);

    expect(result.rolledBack).toBe(false);
    expect(result.restoredPaths).toEqual([]);
    expect(result.rollbackBlockers).toHaveLength(1);
    expect(result.rollbackBlockers[0]).toContain("created.txt");
    // The created file is left in place — rollback never deletes.
    expect(readFileSync(join(repoRoot, "created.txt"), "utf8")).toBe("new content");
  });

  it("rolls back on timeout", async () => {
    const repoRoot = makeRepoRoot();
    const queue = createApplyCommandQueue({ repoRoot, now: nextNow });
    const outcome = appliedUpdateOutcome(repoRoot, "slow.txt", "original", "revised");

    const result = await queue.executeAfterApply([outcome], [
      { argv: ["node", "-e", "setTimeout(() => {}, 60_000)"], timeoutMs: 200 }
    ]);

    expect(result.results[0]?.status).toBe("timeout");
    expect(result.results[0]?.exitCode).toBeNull();
    expect(result.rolledBack).toBe(true);
    expect(readFileSync(join(repoRoot, "slow.txt"), "utf8")).toBe("original");
  });

  it("rolls back when the executable cannot be spawned", async () => {
    const repoRoot = makeRepoRoot();
    const queue = createApplyCommandQueue({ repoRoot, now: nextNow });
    const outcome = appliedUpdateOutcome(repoRoot, "a.txt", "original", "revised");

    const result = await queue.executeAfterApply([outcome], [
      { argv: ["definitely-not-a-real-executable-cmdq"] }
    ]);

    expect(result.results[0]?.status).toBe("failed");
    expect(result.results[0]?.exitCode).toBeNull();
    expect(result.results[0]?.error).toBeDefined();
    expect(result.rolledBack).toBe(true);
    expect(readFileSync(join(repoRoot, "a.txt"), "utf8")).toBe("original");
  });
});

describe("applyCommandQueue failure path with rollbackPolicy=report", () => {
  it("surfaces the failure, keeps applied files, and continues the queue", async () => {
    const repoRoot = makeRepoRoot();
    const queue = createApplyCommandQueue({ repoRoot, now: nextNow });
    const outcome = appliedUpdateOutcome(repoRoot, "a.txt", "original", "revised");

    const result = await queue.executeAfterApply([outcome], [
      { argv: ["node", "-e", "process.exit(2)"], rollbackPolicy: "report" },
      { argv: ["node", "-e", "console.log('still-runs')"], rollbackPolicy: "report" }
    ]);

    expect(result.ran).toBe(true);
    expect(result.allOk).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.restoredPaths).toEqual([]);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.status).toBe("failed");
    expect(result.results[1]?.status).toBe("ok");
    expect(result.results[1]?.stdout.trim()).toBe("still-runs");
    expect(readFileSync(join(repoRoot, "a.txt"), "utf8")).toBe("revised");
  });
});

describe("applyCommandQueue staging", () => {
  it("stage validates and returns a durable entry without executing anything", () => {
    const repoRoot = makeRepoRoot();
    const queue = createApplyCommandQueue({ repoRoot, now: nextNow });

    const entry = queue.stage({ argv: ["node", "-v"], cwd: ".", timeoutMs: 5000 });

    expect(entry.id).toMatch(/^cmdq-1-[0-9a-f]{12}$/);
    expect(entry.createdAt).toBe(new Date(Date.UTC(2026, 6, 18, 0, 0, 0)).toISOString());
    expect(entry.argv).toEqual(["node", "-v"]);
    // Nothing on disk was created by staging.
    expect(existsSync(join(repoRoot, ".guru"))).toBe(false);
    expect(() => queue.stage({ argv: [] })).toThrow();
  });
});
