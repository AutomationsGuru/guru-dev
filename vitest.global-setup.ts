import { execFileSync } from "node:child_process";
import { closeSync, openSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const lockPath = resolve(repoRoot, "node_modules", ".vitest-dist-build.lock");
const distCli = resolve(repoRoot, "dist/cli.js");
const tscEntrypoint = resolve(repoRoot, "node_modules/typescript/bin/tsc");
const DIST_FRESH_MS = 10 * 60_000;
const STALE_LOCK_MS = 90_000;

function sleepSync(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    /* spin — globalSetup is sync-only */
  }
}

function distLooksFresh(): boolean {
  try {
    return Date.now() - statSync(distCli).mtimeMs < DIST_FRESH_MS;
  } catch {
    return false;
  }
}

function stealStaleLock(): void {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
      unlinkSync(lockPath);
    }
  } catch {
    /* no lock */
  }
}

/** One dist build per vitest wave; file lock covers stray parallel npm test runs. */
function withBuildLock(run: () => void): void {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        run();
      } finally {
        closeSync(fd);
        try {
          unlinkSync(lockPath);
        } catch {
          /* lock already gone */
        }
      }
      return;
    } catch {
      stealStaleLock();
      sleepSync(250);
    }
  }
  throw new Error("Timed out waiting for GuruHarness dist build lock.");
}

export default function setup(): void {
  if (distLooksFresh()) {
    return;
  }
  withBuildLock(() => {
    if (distLooksFresh()) {
      return;
    }
    execFileSync(process.execPath, [tscEntrypoint, "-p", "tsconfig.build.json"], {
      cwd: repoRoot,
      stdio: "pipe"
    });
  });
}