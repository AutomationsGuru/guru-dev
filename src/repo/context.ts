import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface AgentsFile {
  readonly path: string;
  readonly relativePath: string;
  readonly contents: string;
}

export interface RepositoryContext {
  readonly repoRoot: string;
  readonly targetPath: string;
  readonly gitStatus: string;
  readonly agentsChain: readonly AgentsFile[];
}

export interface ResolveRepositoryContextOptions {
  readonly targetPath?: string;
  readonly rootPath?: string;
  readonly cwd?: string;
}

export function resolveRepositoryContext(options: ResolveRepositoryContextOptions = {}): RepositoryContext {
  const cwd = options.cwd ?? process.cwd();
  const targetPath = resolvePath(options.targetPath ?? cwd, cwd);
  const repoRoot = options.rootPath ? resolvePath(options.rootPath, cwd) : findGitRoot(targetPath);

  if (!repoRoot) {
    throw new Error(`Unable to resolve git repository root for ${targetPath}`);
  }

  return {
    repoRoot,
    targetPath,
    gitStatus: readGitStatus(repoRoot),
    agentsChain: readAgentsChain({ rootPath: repoRoot, targetPath })
  };
}

export function findGitRoot(startPath: string): string | undefined {
  // git -C requires a directory; models routinely pass file paths as targetPath
  // (found in the 2026-07-02 scale shakedown).
  let searchDir = startPath;
  try {
    if (statSync(startPath).isFile()) {
      searchDir = dirname(startPath);
    }
  } catch {
    searchDir = dirname(startPath);
  }
  try {
    const output = execFileSync("git", ["-C", searchDir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    return resolve(output.trim());
  } catch {
    return undefined;
  }
}

export function readGitStatus(repoRoot: string): string {
  try {
    return execFileSync("git", ["-C", repoRoot, "status", "--short", "--branch"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trimEnd();
  } catch (error) {
    return `git status unavailable: ${formatError(error)}`;
  }
}

export interface ReadAgentsChainOptions {
  readonly rootPath: string;
  readonly targetPath: string;
}

export function readAgentsChain(options: ReadAgentsChainOptions): readonly AgentsFile[] {
  const rootPath = resolve(options.rootPath);
  const targetPath = resolve(options.targetPath);
  assertInsideRoot(rootPath, targetPath);

  const targetDirectory = resolveTargetDirectory(targetPath);
  const directories = directoriesFromRoot(rootPath, targetDirectory);

  return directories
    .map((directory) => join(directory, "AGENTS.md"))
    .filter((agentsPath) => existsSync(agentsPath))
    .map((agentsPath) => ({
      path: agentsPath,
      relativePath: normalizeRelativePath(relative(rootPath, agentsPath)),
      contents: readFileSync(agentsPath, "utf8")
    }));
}

function resolvePath(path: string, cwd: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function assertInsideRoot(rootPath: string, targetPath: string): void {
  const relativePath = relative(rootPath, targetPath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Target path ${targetPath} is outside repository root ${rootPath}`);
  }
}

function resolveTargetDirectory(targetPath: string): string {
  const stats = statSync(targetPath, { throwIfNoEntry: false });

  return stats?.isFile() ? dirname(targetPath) : targetPath;
}

function directoriesFromRoot(rootPath: string, targetDirectory: string): readonly string[] {
  const relativeDirectory = relative(rootPath, targetDirectory);
  const segments = relativeDirectory ? relativeDirectory.split(/[\\/]+/u) : [];
  const directories = [rootPath];
  let current = rootPath;

  for (const segment of segments) {
    current = join(current, segment);
    directories.push(current);
  }

  return directories;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split("\\").join("/") || "AGENTS.md";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
