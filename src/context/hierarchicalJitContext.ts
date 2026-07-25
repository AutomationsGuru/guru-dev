import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, isAbsolute, relative } from "node:path";
import { processImports } from "./contextImportProcessor.js";

export interface ContextRoots {
  readonly home: string;
  readonly project: string;
  readonly trusted?: boolean;
}

export interface MergedContext {
  readonly text: string;
  readonly loadedPaths: readonly string[];
}

/**
 * Resolves the hierarchical chain of context files from home up to ancestors and the accessed JIT path.
 * Ordered: home -> ancestors -> jit.
 */
export function resolveChain(
  accessPath: string,
  roots: ContextRoots,
  fileNames: readonly string[] = ["AGENTS.md"]
): readonly string[] {
  const chain: string[] = [];

  // 1. Resolve Home Context
  const home = resolve(roots.home);
  for (const name of fileNames) {
    const homeFile = join(home, name);
    if (existsSync(homeFile) && statSync(homeFile).isFile()) {
      chain.push(homeFile);
    }
  }

  // 2. Resolve Project Context (only if trusted is not explicitly false)
  if (roots.trusted !== false) {
    const project = resolve(roots.project);
    const targetDir = resolveTargetDirectory(accessPath);

    // Get the directories from project root to target directory
    const dirChain = getDirectoryChain(project, targetDir);

    if (dirChain.length > 0) {
      // dirChain starts at project root and ends at targetDir.
      // - JIT is the last directory (targetDir)
      // - Ancestors are all directories before targetDir (from project root down to parent of targetDir)
      for (const dir of dirChain) {
        for (const name of fileNames) {
          const file = join(dir, name);
          if (existsSync(file) && statSync(file).isFile()) {
            chain.push(file);
          }
        }
      }
    }
  }

  return chain;
}

/**
 * Helper to get directory chain from project root to target directory.
 * Returns empty array if target directory escapes the project root.
 */
function getDirectoryChain(projectRoot: string, targetDir: string): string[] {
  const root = resolve(projectRoot);
  const target = resolve(targetDir);

  if (root === target) {
    return [root];
  }

  const relativePath = relative(root, target);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return []; // Target escapes project root
  }

  const segments = relativePath ? relativePath.split(/[\\/]+/u) : [];
  const chain: string[] = [root];
  let current = root;
  for (const segment of segments) {
    if (segment) {
      current = join(current, segment);
      chain.push(current);
    }
  }
  return chain;
}

/**
 * Helper to resolve target directory of accessPath.
 * If path is a file or does not exist, returns its parent directory.
 */
function resolveTargetDirectory(accessPath: string): string {
  const absolutePath = resolve(accessPath);
  try {
    const stats = statSync(absolutePath);
    return stats.isDirectory() ? absolutePath : dirname(absolutePath);
  } catch {
    return dirname(absolutePath);
  }
}

/**
 * Resolves the appropriate workspace containment root for a given file.
 * Home files use home directory as root, project files use project directory.
 */
function getWorkspaceRootForFile(filePath: string, roots: ContextRoots): string {
  const fileAbs = resolve(filePath);
  const homeAbs = resolve(roots.home);

  const relativeToHome = relative(homeAbs, fileAbs);
  if (!relativeToHome.startsWith("..") && !isAbsolute(relativeToHome)) {
    return homeAbs;
  }
  return resolve(roots.project);
}

/**
 * Merges the hierarchical JIT context for a tool access by resolving context files,
 * processing their modular imports, and merging them.
 */
export function mergeForToolAccess(
  accessPath: string,
  roots: ContextRoots,
  fileNames: readonly string[] = ["AGENTS.md"]
): MergedContext {
  const resolvedPaths = resolveChain(accessPath, roots, fileNames);
  const loadedPaths = new Set<string>();
  const texts: string[] = [];

  for (const filePath of resolvedPaths) {
    loadedPaths.add(filePath);
    const fileContent = readFileSync(filePath, "utf8");
    const workspaceRoot = getWorkspaceRootForFile(filePath, roots);

    const processedText = processImports(
      fileContent,
      dirname(filePath),
      workspaceRoot,
      { loadedPaths }
    );
    texts.push(processedText);
  }

  return {
    text: texts.join("\n\n"),
    loadedPaths: Array.from(loadedPaths)
  };
}
