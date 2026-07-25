import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  resolveChain,
  mergeForToolAccess,
  type ContextRoots
} from '../../src/context/hierarchicalJitContext.js';
import {
  processImports,
  assertInsideWorkspace
} from '../../src/context/contextImportProcessor.js';

describe("hierarchicalJitContext", () => {
  let tempRoot: string;
  let homeDir: string;
  let projectDir: string;
  let roots: ContextRoots;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "guruharness-jit-test-"));
    homeDir = join(tempRoot, "home");
    projectDir = join(tempRoot, "project");

    mkdirSync(homeDir);
    mkdirSync(projectDir);

    roots = {
      home: homeDir,
      project: projectDir,
      trusted: true
    };
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("resolveChain", () => {
    it("should order files correctly: home -> ancestors -> jit", () => {
      // 1. Setup home context
      writeFileSync(join(homeDir, "AGENTS.md"), "Home context");

      // 2. Setup project root context
      writeFileSync(join(projectDir, "AGENTS.md"), "Project root context");

      // 3. Setup sub-directory context
      const subDir = join(projectDir, "src", "sub");
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, "AGENTS.md"), "JIT sub context");

      // 4. Resolve the chain for a file inside the sub-directory
      const targetFile = join(subDir, "file.ts");
      const chain = resolveChain(targetFile, roots, ["AGENTS.md"]);

      expect(chain).toEqual([
        resolve(join(homeDir, "AGENTS.md")),
        resolve(join(projectDir, "AGENTS.md")),
        resolve(join(subDir, "AGENTS.md"))
      ]);
    });

    it("should skip ancestors not on the path to the accessed target (JIT only when entered)", () => {
      // Setup context files
      writeFileSync(join(projectDir, "AGENTS.md"), "Project root context");

      const activeSub = join(projectDir, "src", "active");
      mkdirSync(activeSub, { recursive: true });
      writeFileSync(join(activeSub, "AGENTS.md"), "Active JIT context");

      const inactiveSub = join(projectDir, "src", "inactive");
      mkdirSync(inactiveSub, { recursive: true });
      writeFileSync(join(inactiveSub, "AGENTS.md"), "Inactive context");

      // Resolve for active sub
      const chain = resolveChain(join(activeSub, "file.ts"), roots, ["AGENTS.md"]);

      expect(chain).toContain(resolve(join(projectDir, "AGENTS.md")));
      expect(chain).toContain(resolve(join(activeSub, "AGENTS.md")));
      expect(chain).not.toContain(resolve(join(inactiveSub, "AGENTS.md")));
    });

    it("should handle custom context filenames", () => {
      writeFileSync(join(homeDir, "CUSTOM.md"), "Home custom");
      writeFileSync(join(projectDir, "CUSTOM.md"), "Project custom");

      const chain = resolveChain(projectDir, roots, ["CUSTOM.md"]);

      expect(chain).toEqual([
        resolve(join(homeDir, "CUSTOM.md")),
        resolve(join(projectDir, "CUSTOM.md"))
      ]);
    });

    it("should skip project files if workspace is untrusted (F94 composition)", () => {
      writeFileSync(join(homeDir, "AGENTS.md"), "Home context");
      writeFileSync(join(projectDir, "AGENTS.md"), "Project context");

      const untrustedRoots = { ...roots, trusted: false };
      const chain = resolveChain(projectDir, untrustedRoots, ["AGENTS.md"]);

      expect(chain).toEqual([resolve(join(homeDir, "AGENTS.md"))]);
    });
  });

  describe("processImports", () => {
    it("should expand valid relative imports within the workspace", () => {
      const baseFile = join(projectDir, "main.md");
      const importFile = join(projectDir, "imported.md");

      writeFileSync(importFile, "Imported Content");
      const text = "Prefix\n@./imported.md\nSuffix";

      const expanded = processImports(text, projectDir, projectDir);
      expect(expanded).toBe("Prefix\nImported Content\nSuffix");
    });

    it("should expand valid workspace-relative imports", () => {
      const subDir = join(projectDir, "sub");
      mkdirSync(subDir);
      const importFile = join(subDir, "imported.md");

      writeFileSync(importFile, "Workspace relative content");
      // @/sub/imported.md or @sub/imported.md should resolve relative to workspaceRoot
      const text = "@sub/imported.md";

      const expanded = processImports(text, projectDir, projectDir);
      expect(expanded).toBe("Workspace relative content");
    });

    it("should throw on circular imports", () => {
      const fileA = join(projectDir, "a.md");
      const fileB = join(projectDir, "b.md");

      writeFileSync(fileA, "File A\n@./b.md");
      writeFileSync(fileB, "File B\n@./a.md");

      expect(() => {
        processImports("@./a.md", projectDir, projectDir);
      }).toThrow(/Circular import detected/);
    });

    it("should throw on path escape attempts (containment check)", () => {
      const text = "@../escaped.md";
      expect(() => {
        processImports(text, projectDir, projectDir);
      }).toThrow(/Access denied: path escapes workspace/);
    });

    it("should throw on max depth limit exceeded", () => {
      const depth = 4;
      for (let i = 0; i < depth; i++) {
        const file = join(projectDir, `file${i}.md`);
        const nextFile = i === depth - 1 ? "final.md" : `file${i + 1}.md`;
        writeFileSync(file, `@./${nextFile}`);
      }
      writeFileSync(join(projectDir, "final.md"), "Final reached");

      expect(() => {
        processImports("@./file0.md", projectDir, projectDir, { maxDepth: 2 });
      }).toThrow(/Max import depth of 2 exceeded/);
    });

    it("should preserve non-explicit role or chat annotations like @operator", () => {
      const text = "Review by @operator and @guru";
      const expanded = processImports(text, projectDir, projectDir);
      expect(expanded).toBe("Review by @operator and @guru");
    });
  });

  describe("mergeForToolAccess", () => {
    it("should load, expand imports, and merge hierarchical contexts completely", () => {
      // 1. Home context with import
      const homeImport = join(homeDir, "home_rules.md");
      writeFileSync(homeImport, "Home Rule Content");
      writeFileSync(join(homeDir, "AGENTS.md"), "Home Baseline\n@./home_rules.md");

      // 2. Project context with import
      const projectImport = join(projectDir, "project_rules.md");
      writeFileSync(projectImport, "Project Rule Content");
      writeFileSync(join(projectDir, "AGENTS.md"), "Project Root\n@./project_rules.md");

      // 3. JIT context
      const subDir = join(projectDir, "src");
      mkdirSync(subDir);
      writeFileSync(join(subDir, "AGENTS.md"), "JIT Specific Context");

      const result = mergeForToolAccess(subDir, roots);

      expect(result.text).toContain("Home Baseline");
      expect(result.text).toContain("Home Rule Content");
      expect(result.text).toContain("Project Root");
      expect(result.text).toContain("Project Rule Content");
      expect(result.text).toContain("JIT Specific Context");

      expect(result.loadedPaths).toContain(resolve(join(homeDir, "AGENTS.md")));
      expect(result.loadedPaths).toContain(resolve(homeImport));
      expect(result.loadedPaths).toContain(resolve(join(projectDir, "AGENTS.md")));
      expect(result.loadedPaths).toContain(resolve(projectImport));
      expect(result.loadedPaths).toContain(resolve(join(subDir, "AGENTS.md")));
    });
  });
});
