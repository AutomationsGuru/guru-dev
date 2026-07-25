import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WorktreeIsolationError,
  claimWritableGlobs,
  createWorktreeIsolation,
  detectGitRepo,
  resolveIsolation,
  type WorktreeIsolation
} from "../../src/swarm/worktreeIsolation.js";

/**
 * Bounded temp-repo fixture. Each test gets a fresh git repo in a tmpdir so we
 * never touch the operator checkout, never hit the network, and never leak
 * state between tests.
 */
interface TempRepo {
  readonly root: string;
  cleanup(): void;
}

function makeTempRepo(): TempRepo {
  const root = mkdtempSync(join(tmpdir(), "guru-wt-iso-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@guru.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Guru Test"], { cwd: root });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  // An initial commit so HEAD exists and worktree add has a base.
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

describe("resolveIsolation — ship default", () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = makeTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it("defaults to 'worktree' inside a git repo", () => {
    expect(resolveIsolation(repo.root)).toBe("worktree");
  });

  it("defaults to 'none' outside a git repo", () => {
    const bare = mkdtempSync(join(tmpdir(), "guru-wt-bare-"));
    try {
      expect(resolveIsolation(bare)).toBe("none");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("an explicit request wins over the default", () => {
    expect(resolveIsolation(repo.root, "none")).toBe("none");
  });
});

describe("detectGitRepo", () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = makeTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it("returns the repo root for a git directory", () => {
    expect(detectGitRepo(repo.root)).toBe(resolve(repo.root));
  });

  it("returns null for a non-git directory", () => {
    const bare = mkdtempSync(join(tmpdir(), "guru-wt-nongit-"));
    try {
      expect(detectGitRepo(bare)).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("claimWritableGlobs — tangle detect", () => {
  it("first claim wins; disjoint second claim succeeds", () => {
    const claims = claimWritableGlobs();
    claims.claim("ship-a", ["src/a/**"]);
    expect(() => claims.claim("ship-b", ["src/b/**"])).not.toThrow();
  });

  it("overlapping claim by a DIFFERENT ship throws (tangle)", () => {
    const claims = claimWritableGlobs();
    claims.claim("ship-a", ["src/shared/**"]);
    expect(() => claims.claim("ship-b", ["src/shared/file.ts"])).toThrow(WorktreeIsolationError);
    expect(() => claims.claim("ship-b", ["src/shared/file.ts"])).toThrow(/tangle/i);
  });

  it("same-ship re-claim of its own globs is idempotent, not a tangle", () => {
    const claims = claimWritableGlobs();
    claims.claim("ship-a", ["src/a/**"]);
    expect(() => claims.claim("ship-a", ["src/a/**"])).not.toThrow();
  });

  it("exact-duplicate glob across ships is a tangle", () => {
    const claims = claimWritableGlobs();
    claims.claim("ship-a", ["src/x.ts"]);
    expect(() => claims.claim("ship-b", ["src/x.ts"])).toThrow(WorktreeIsolationError);
  });
});

describe("createWorktreeIsolation — bounded project-local worktrees", () => {
  let repo: TempRepo;
  let iso: WorktreeIsolation | undefined;
  beforeEach(() => {
    repo = makeTempRepo();
    iso = undefined;
  });
  afterEach(() => {
    iso?.disposeAll();
    repo.cleanup();
  });

  it("creates a worktree under the bounded project-local path, never touching the operator checkout", () => {
    iso = createWorktreeIsolation({ projectRoot: repo.root });
    const handle = iso.acquire("ship-1", ["src/**"]);
    // Worktree path must live under <root>/.guru/worktrees/<id>.
    expect(handle.path.startsWith(join(repo.root, ".guru", "worktrees"))).toBe(true);
    // The operator checkout is NOT the worktree path.
    expect(handle.path).not.toBe(resolve(repo.root));
    // The worktree is a real git worktree (has .git pointer).
    expect(detectGitRepo(handle.path)).toBe(resolve(handle.path));
  });

  it("never deletes operator branches: dispose removes only its own worktree, not the main checkout", () => {
    iso = createWorktreeIsolation({ projectRoot: repo.root });
    const handle = iso.acquire("ship-1", ["src/**"]);
    const wtPath = handle.path;
    handle.dispose();
    // Worktree path is gone.
    expect(detectGitRepo(wtPath)).toBeNull();
    // Operator checkout still a live repo with its branch intact.
    expect(detectGitRepo(repo.root)).toBe(resolve(repo.root));
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo.root, encoding: "utf8" }).trim();
    expect(branch).toBe("main");
  });

  it("isolation 'none' falls back to the operator checkout with no worktree", () => {
    iso = createWorktreeIsolation({ projectRoot: repo.root, isolation: "none" });
    const handle = iso.acquire("ship-1", ["src/**"]);
    expect(handle.path).toBe(resolve(repo.root));
    expect(handle.isolated).toBe(false);
  });

  it("tangle detect on acquire: second ship claiming overlapping globs fails", () => {
    iso = createWorktreeIsolation({ projectRoot: repo.root });
    iso.acquire("ship-a", ["src/shared/**"]);
    expect(() => iso!.acquire("ship-b", ["src/shared/**"])).toThrow(WorktreeIsolationError);
  });

  it("disjoint ships coexist; releasing a claim frees the globs", () => {
    iso = createWorktreeIsolation({ projectRoot: repo.root });
    const a = iso.acquire("ship-a", ["src/a/**"]);
    const b = iso.acquire("ship-b", ["src/b/**"]);
    expect(a.path).not.toBe(b.path);
    a.dispose();
    // After release, ship-c may claim the freed glob.
    expect(() => iso!.acquire("ship-c", ["src/a/**"])).not.toThrow();
  });
});
