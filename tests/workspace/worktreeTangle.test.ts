import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkWorktreePath, checkWorktreePaths } from '../../src/workspace/worktreeTangle.js';

const temporaryPaths: string[] = [];

function createWorktreeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "guruharness-worktree-tangle-"));
  temporaryPaths.push(root);
  return root;
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("checkWorktreePath", () => {
  it("accepts paths inside the assigned worktree root", () => {
    const root = createWorktreeRoot();

    expect(checkWorktreePath(root, "src/workspace/file.ts")).toEqual({
      path: "src/workspace/file.ts",
      disposition: "inside",
    });
  });

  it("rejects paths outside the assigned worktree root", () => {
    const root = createWorktreeRoot();
    const outside = join(tmpdir(), "outside-worktree.ts");

    expect(checkWorktreePath(root, outside)).toEqual({
      path: outside,
      disposition: "outside",
      reason: "outside-root",
    });
  });

  it("rejects an existing symlink that escapes the assigned root", () => {
    const root = createWorktreeRoot();
    const outside = createWorktreeRoot();
    const outsideFile = join(outside, "outside.ts");
    writeFileSync(outsideFile, "export {}\n");
    const link = join(root, "linked-outside.ts");
    symlinkSync(outsideFile, link);

    expect(checkWorktreePath(root, link)).toEqual({
      path: link,
      disposition: "outside",
      reason: "symlink-escape",
    });
  });
});

describe("checkWorktreePaths", () => {
  it("warns without blocking but blocks under block policy", () => {
    const root = createWorktreeRoot();
    const paths = ["src/inside.ts", join(tmpdir(), "outside-worktree.ts")];

    expect(checkWorktreePaths(root, paths, "warn")).toMatchObject({
      allowed: true,
      policy: "warn",
      paths: [{ disposition: "inside" }, { disposition: "outside" }],
    });
    expect(checkWorktreePaths(root, paths, "block")).toMatchObject({
      allowed: false,
      policy: "block",
      paths: [{ disposition: "inside" }, { disposition: "outside" }],
    });
  });
});
