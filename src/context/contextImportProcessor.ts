import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, relative } from "node:path";

/**
 * Asserts that a target path is strictly contained within the workspace root.
 * Throws an error if the target path escapes the workspace root to prevent path traversal.
 */
export function assertInsideWorkspace(workspaceRoot: string, targetPath: string): void {
  const root = resolve(workspaceRoot);
  const target = resolve(targetPath);

  if (root === target) {
    return;
  }

  const relativePath = relative(root, target);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Access denied: path escapes workspace`);
  }
}

/**
 * Recursively processes modular imports of the form "@path" in the provided text,
 * expanding them with the contents of the referenced files.
 * Includes cycle detection, maximum import depth bounds, and strict path containment checks.
 */
export function processImports(
  text: string,
  baseDir: string,
  workspaceRoot: string,
  options: {
    readonly maxDepth?: number;
    readonly visited?: Set<string>;
    readonly loadedPaths?: Set<string>;
  } = {}
): string {
  const maxDepth = options.maxDepth ?? 10;
  const visited = options.visited ?? new Set<string>();
  const loadedPaths = options.loadedPaths ?? new Set<string>();

  const lines = text.split(/\r?\n/u);
  const processedLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("@")) {
      const importPathRaw = line.slice(1).trim();
      const isExplicitImport =
        importPathRaw.startsWith("./") ||
        importPathRaw.startsWith("../") ||
        importPathRaw.startsWith("/");

      let resolvedPath: string;
      if (importPathRaw.startsWith(".") || isAbsolute(importPathRaw)) {
        resolvedPath = isAbsolute(importPathRaw)
          ? resolve(importPathRaw)
          : resolve(baseDir, importPathRaw);
      } else {
        resolvedPath = resolve(workspaceRoot, importPathRaw);
      }

      // Enforce strict workspace containment to prevent security leaks / path escapes
      try {
        assertInsideWorkspace(workspaceRoot, resolvedPath);
      } catch (err) {
        if (isExplicitImport) {
          throw err;
        }
        // For non-explicit entries (e.g. role annotations like "@operator"), preserve the text
        processedLines.push(line);
        continue;
      }

      if (existsSync(resolvedPath) && statSync(resolvedPath).isFile()) {
        if (visited.has(resolvedPath)) {
          throw new Error(`Circular import detected: ${resolvedPath}`);
        }
        if (visited.size >= maxDepth) {
          throw new Error(`Max import depth of ${maxDepth} exceeded`);
        }

        const nextVisited = new Set(visited);
        nextVisited.add(resolvedPath);
        loadedPaths.add(resolvedPath);

        const importedText = readFileSync(resolvedPath, "utf8");
        const processedImport = processImports(
          importedText,
          dirname(resolvedPath),
          workspaceRoot,
          { maxDepth, visited: nextVisited, loadedPaths }
        );
        processedLines.push(processedImport);
      } else if (isExplicitImport) {
        throw new Error(`Import file not found: ${resolvedPath}`);
      } else {
        // Fall back to preserving non-explicit non-file annotations like "@operator"
        processedLines.push(line);
      }
    } else {
      processedLines.push(line);
    }
  }

  return processedLines.join("\n");
}
