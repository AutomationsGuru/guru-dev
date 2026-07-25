import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createLocalActionExecBackend, type ActionExecBackend, type ActionExecResult } from '../../src/workspace/actionExecBackend.js';
import {
  createStatelessActionExecutor,
  type StatelessAction,
  type StatelessActionBlocker,
  type StatelessActionResult
} from '../../src/workspace/statelessActionExec.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const dir of tempDirectories) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirectories.length = 0;
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "guruharness-stateless-"));
  tempDirectories.push(dir);
  return dir;
}

// ── actionExecBackend ──────────────────────────────────────────────────────

describe("createLocalActionExecBackend", () => {
  it("runs a simple echo command and captures stdout", async () => {
    const backend = createLocalActionExecBackend();
    const cwd = makeTempDir();
    const result = await backend.run({ cmd: ["node", "-e", "console.log('hello')"], cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(result.stderr).toBe("");
    expect(result.cancelled).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("runs with a custom env and captures the effect", async () => {
    const backend = createLocalActionExecBackend();
    const cwd = makeTempDir();
    const result = await backend.run({
      cmd: ["node", "-e", "console.log(process.env.GURU_TEST_VAR)"],
      cwd,
      env: { ...process.env, GURU_TEST_VAR: "stateless-42" }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("stateless-42");
  });

  it("captures stderr from a failing command", async () => {
    const backend = createLocalActionExecBackend();
    const cwd = makeTempDir();
    const result = await backend.run({ cmd: ["node", "-e", "process.stderr.write('err-msg'); process.exit(1)"], cwd });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("err-msg");
  });

  it("returns cancelled=true on timeout", async () => {
    const backend = createLocalActionExecBackend();
    const cwd = makeTempDir();
    const result = await backend.run({
      cmd: ["node", "-e", "setTimeout(() => {}, 30000)"],
      cwd,
      timeoutMs: 500
    });

    expect(result.cancelled).toBe(true);
    // exitCode may be null (killed before close) — both are valid for a killed child
    expect(result.stderr).toContain("timed out");
  });

  it("respects AbortSignal to cancel a running command", async () => {
    const backend = createLocalActionExecBackend();
    const cwd = makeTempDir();
    const controller = new AbortController();
    const promise = backend.run({
      cmd: ["node", "-e", "setTimeout(() => {}, 30000)"],
      cwd,
      signal: controller.signal
    });

    // Allow the subprocess to start before aborting
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();

    const result = await promise;
    expect(result.cancelled).toBe(true);
    expect(result.stderr).toContain("aborted");
  });

  it("returns a clean failure for an empty command", async () => {
    const backend = createLocalActionExecBackend();
    const cwd = makeTempDir();
    const result = await backend.run({ cmd: [], cwd });

    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("empty");
    expect(result.cancelled).toBe(false);
  });
});

// ── statelessActionExec ────────────────────────────────────────────────────

describe("createStatelessActionExecutor", () => {
  it("runs two independent commands — cwd does not leak between calls", async () => {
    const executor = createStatelessActionExecutor();
    const dir1 = makeTempDir();
    const dir2 = makeTempDir();

    // Write a different marker to each directory
    const set1: StatelessAction = {
      cmd: ["node", "-e", `require('fs').writeFileSync('marker.txt', 'dir1-marker')`],
      cwd: dir1
    };
    const set2: StatelessAction = {
      cmd: ["node", "-e", `require('fs').writeFileSync('marker.txt', 'dir2-marker')`],
      cwd: dir2
    };

    const [r1, r2] = await Promise.all([executor.run(set1), executor.run(set2)]);

    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);

    // Read back — each directory got its own marker
    const read1: StatelessAction = { cmd: ["node", "-e", "console.log(require('fs').readFileSync('marker.txt','utf8'))"], cwd: dir1 };
    const read2: StatelessAction = { cmd: ["node", "-e", "console.log(require('fs').readFileSync('marker.txt','utf8'))"], cwd: dir2 };
    const [v1, v2] = await Promise.all([executor.run(read1), executor.run(read2)]);

    expect(v1.stdout.trim()).toBe("dir1-marker");
    expect(v2.stdout.trim()).toBe("dir2-marker");
    // Neither action leaked cwd into the other
  });

  it("each action resets cwd — no sticky working directory", async () => {
    const executor = createStatelessActionExecutor();
    const dir = makeTempDir();

    // First action changes directory (via a sub-shell) — but that doesn't persist
    const a1: StatelessAction = { cmd: ["node", "-e", "process.chdir('/tmp')"], cwd: dir };
    await executor.run(a1);

    // Second action runs in the original cwd
    const a2: StatelessAction = { cmd: ["node", "-e", "console.log(process.cwd())"], cwd: dir };
    const r2 = await executor.run(a2);

    expect(r2.stdout.trim()).toBe(resolve(dir));
    expect(r2.exitCode).toBe(0);
  });

  it("passes explicit env to a single action without polluting others", async () => {
    const executor = createStatelessActionExecutor();
    const cwd = makeTempDir();

    const a1: StatelessAction = {
      cmd: ["node", "-e", "console.log(process.env.STATELESS_X)"],
      cwd,
      env: { ...process.env, STATELESS_X: "action-1" }
    };
    const a2: StatelessAction = {
      cmd: ["node", "-e", "console.log(process.env.STATELESS_X ?? 'MISSING')"],
      cwd
    };

    const [r1, r2] = await Promise.all([executor.run(a1), executor.run(a2)]);

    expect(r1.stdout.trim()).toBe("action-1");
    expect(r2.stdout.trim()).toBe("MISSING");
  });

  it("fails closed on a hard-limit command-class blocker hook", async () => {
    const destructiveCmdBlocker: StatelessActionBlocker = (action) => {
      const cmd = action.cmd.join(" ");
      if (cmd.includes("rm -rf") || cmd.includes("format")) {
        return `Destructive command blocked: ${cmd}`;
      }
      return null;
    };

    const executor = createStatelessActionExecutor({ blocker: destructiveCmdBlocker });
    const cwd = makeTempDir();

    // This would be a destructive command — blocker should intercept it
    const blocked = await executor.run({ cmd: ["rm", "-rf", "/tmp/nonexistent"], cwd });
    expect(blocked.exitCode).toBeNull();
    expect(blocked.stderr).toContain("Blocked");
    expect(blocked.stderr).toContain("Destructive command blocked");
    expect(blocked.durationMs).toBe(0);
    expect(blocked.cancelled).toBe(false);

    // Normal commands still pass through
    const allowed = await executor.run({ cmd: ["node", "-e", "console.log('ok')"], cwd });
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout.trim()).toBe("ok");
  });

  it("blocker is always evaluated — fail-closed cannot be bypassed by any backend", async () => {
    const alwaysBlock: StatelessActionBlocker = () => "always blocked";

    const executor = createStatelessActionExecutor({ blocker: alwaysBlock });
    const cwd = makeTempDir();

    const result = await executor.run({ cmd: ["node", "-e", "console.log('should not run')"], cwd });
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("Blocked: always blocked");
  });

  it("timeout is enforced per-action (no orphan leak between calls)", async () => {
    const executor = createStatelessActionExecutor();
    const cwd = makeTempDir();

    // A long-running action that should be killed
    const r1 = await executor.run({
      cmd: ["node", "-e", "setTimeout(() => {}, 30000)"],
      cwd,
      timeoutMs: 500
    });
    expect(r1.cancelled).toBe(true);
    expect(r1.stderr).toContain("timed out");

    // A second action that should run fine — proving the first didn't corrupt state
    const r2 = await executor.run({ cmd: ["node", "-e", "console.log('after-timeout')"], cwd });
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout.trim()).toBe("after-timeout");
    expect(r2.cancelled).toBe(false);
  });

  it("rejects invalid actions with schema errors", async () => {
    const executor = createStatelessActionExecutor();
    const cwd = makeTempDir();

    // Empty command array
    const r1 = await executor.run({ cmd: [], cwd });
    expect(r1.exitCode).toBeNull();
    expect(r1.stderr).toContain("Invalid action");
  });

  it("works with an injected custom backend (test double)", async () => {
    const fakeResults: ActionExecResult[] = [
      { exitCode: 0, stdout: "backend-result-1", stderr: "", durationMs: 5, cancelled: false },
      { exitCode: 1, stdout: "", stderr: "backend-error-2", durationMs: 3, cancelled: false }
    ];
    let callIndex = 0;
    const fakeBackend: ActionExecBackend = {
      kind: "local",
      async run() {
        const result = fakeResults[callIndex];
        callIndex += 1;
        return result ?? { exitCode: null, stdout: "", stderr: "no more results", durationMs: 0, cancelled: false };
      }
    };

    const executor = createStatelessActionExecutor({ backend: fakeBackend });
    const cwd = makeTempDir();

    const r1 = await executor.run({ cmd: ["echo", "hello"], cwd });
    const r2 = await executor.run({ cmd: ["false"], cwd });

    expect(r1.exitCode).toBe(0);
    expect(r1.stdout).toBe("backend-result-1");
    expect(r2.exitCode).toBe(1);
    expect(r2.stderr).toBe("backend-error-2");
    expect(callIndex).toBe(2);
  });

  it("forwards AbortSignal to the backend via the executor", async () => {
    const executor = createStatelessActionExecutor();
    const cwd = makeTempDir();
    const controller = new AbortController();

    const promise = executor.run({ cmd: ["node", "-e", "setTimeout(() => {}, 30000)"], cwd }, controller.signal);
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();

    const result = await promise;
    expect(result.cancelled).toBe(true);
    expect(result.stderr).toContain("aborted");
  });
});