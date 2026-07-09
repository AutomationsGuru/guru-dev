import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Hardening #13 regression — `guru self-build-run --loop` wires the UNATTENDED
 * multi-cycle driver (runDevCycleLoop) to a real surface. Runs MODEL-FREE by
 * construction: an empty temp config (no plannerModel) and a scrubbed env mean
 * BUILD fails fast with no spend — the test proves the wiring + report contract,
 * not a live model run.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// No inherited API keys: the loop must never be able to spend from a test.
const scrubbedEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  ...(process.env.COMSPEC ? { COMSPEC: process.env.COMSPEC } : {}),
  ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
  ...(process.env.TMP ? { TMP: process.env.TMP } : {})
};

function runCli(cliArgs: readonly string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...cliArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    env: scrubbedEnv,
    timeout: 120_000
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

describe("self-build-run --loop (hardening #13)", { timeout: 180_000 }, () => {
  it("documents --loop and --max-cycles in help", () => {
    const { stdout } = runCli(["self-build-run", "--help"]);
    expect(stdout).toContain("--loop");
    expect(stdout).toContain("--max-cycles");
  });

  it("drives the multi-cycle driver and prints one parseable DevCycleLoopReport", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "guruharness-loop-"));
    try {
      // Empty config: no plannerModel (BUILD fails fast, model-free), no completed tasks.
      const configPath = join(tempRoot, "guruharness.config.json");
      writeFileSync(configPath, "{}\n");

      const { stdout, stderr, status } = runCli([
        "self-build-run",
        "--loop",
        "--max-cycles",
        "1",
        "--config",
        configPath,
        "--allow-dirty-workspace"
      ]);

      const report = JSON.parse(stdout) as {
        cycles: readonly { terminal: string }[];
        completed: readonly string[];
        blocked: readonly string[];
        stoppedReason: string;
      };

      expect(Array.isArray(report.cycles)).toBe(true);
      expect(report.cycles.length).toBeLessThanOrEqual(1);
      expect(["no-ready-task", "max-cycles"]).toContain(report.stoppedReason);
      // Model-free run: the single cycle blocks (no planner) — exit code reflects it,
      // and per-cycle progress went to stderr so stdout stayed pure JSON.
      if (report.cycles.length > 0) {
        expect(stderr).toContain("[self-build-loop]");
        expect(report.blocked.length + report.completed.length).toBe(report.cycles.length);
        expect(status).toBe(report.blocked.length === 0 ? 0 : 1);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
