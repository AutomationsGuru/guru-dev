import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type WorktreeTanglePolicy = "warn" | "block";
export type WorktreeTangleDisposition = "inside" | "outside";

export interface WorktreePathCheck {
  path: string;
  disposition: WorktreeTangleDisposition;
  reason?: "outside-root" | "symlink-escape";
}

export interface WorktreeTangleCheckResult {
  allowed: boolean;
  policy: WorktreeTanglePolicy;
  paths: WorktreePathCheck[];
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

function realpathIfPresent(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    // New output paths do not exist yet, so lexical containment is all we have.
    return undefined;
  }
}

/**
 * Checks a tool path against its assigned worktree root without relying on
 * prefix matching, which would accept siblings such as /worktree-copy.
 */
export function checkWorktreePath(assignedRoot: string, path: string): WorktreePathCheck {
  const root = resolve(assignedRoot);
  const candidate = isAbsolute(path) ? resolve(path) : resolve(root, path);

  if (!isInside(root, candidate)) {
    return { path, disposition: "outside", reason: "outside-root" };
  }

  const realRoot = realpathIfPresent(root);
  const realCandidate = realpathIfPresent(candidate);
  if (realRoot && realCandidate && !isInside(realRoot, realCandidate)) {
    return { path, disposition: "outside", reason: "symlink-escape" };
  }

  return { path, disposition: "inside" };
}

export function checkWorktreePaths(
  assignedRoot: string,
  paths: readonly string[],
  policy: WorktreeTanglePolicy = "block",
): WorktreeTangleCheckResult {
  const checks = paths.map((path) => checkWorktreePath(assignedRoot, path));
  const hasOutsidePath = checks.some((check) => check.disposition === "outside");

  return {
    allowed: policy === "warn" || !hasOutsidePath,
    policy,
    paths: checks,
  };
}
