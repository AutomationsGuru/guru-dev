import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { generateTemplates } from '../../src/steering/foundationTemplates.js';

describe("generateTemplates", () => {
  it("creates product, tech, and structure steering skeletons under a project", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "guru-foundation-templates-"));

    try {
      mkdirSync(join(projectRoot, "src"));
      mkdirSync(join(projectRoot, "tests"));
      const generated = generateTemplates({ projectRoot, kind: "all" });

      expect(generated).toEqual([
        join(projectRoot, ".guru", "steering", "product.md"),
        join(projectRoot, ".guru", "steering", "tech.md"),
        join(projectRoot, ".guru", "steering", "structure.md")
      ]);
      expect(readFileSync(generated[0] as string, "utf8")).toContain("# Product steering —");
      expect(readFileSync(generated[1] as string, "utf8")).toContain("# Technical steering —");
      expect(readFileSync(generated[2] as string, "utf8")).toContain("- `src` — describe what this area owns.");
      expect(readFileSync(generated[2] as string, "utf8")).toContain("- `tests` — describe what this area owns.");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("creates only the requested foundation template", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "guru-foundation-templates-"));

    try {
      const generated = generateTemplates({ projectRoot, kind: "tech" });

      expect(generated).toEqual([join(projectRoot, ".guru", "steering", "tech.md")]);
      expect(existsSync(join(projectRoot, ".guru", "steering", "product.md"))).toBe(false);
      expect(existsSync(join(projectRoot, ".guru", "steering", "structure.md"))).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("preserves existing steering and does not leave a partial foundation set", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "guru-foundation-templates-"));
    const techPath = join(projectRoot, ".guru", "steering", "tech.md");

    try {
      mkdirSync(join(projectRoot, ".guru", "steering"), { recursive: true });
      const existing = "# Technical steering\n\nKeep this operator-authored guidance.\n";
      writeFileSync(techPath, existing, "utf8");

      expect(() => generateTemplates({ projectRoot, kind: "all" })).toThrowError(
        `Refusing to overwrite existing steering file: ${techPath}`
      );
      expect(readFileSync(techPath, "utf8")).toBe(existing);
      expect(existsSync(join(projectRoot, ".guru", "steering", "product.md"))).toBe(false);
      expect(existsSync(join(projectRoot, ".guru", "steering", "structure.md"))).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("does not describe its own .guru directory as project structure", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "guru-foundation-templates-"));

    try {
      mkdirSync(join(projectRoot, ".guru"));
      mkdirSync(join(projectRoot, "src"));
      const [structurePath] = generateTemplates({ projectRoot, kind: "structure" });
      const structure = readFileSync(structurePath as string, "utf8");

      expect(structure).toContain("- `src` — describe what this area owns.");
      expect(structure).not.toContain("- `.guru` — describe what this area owns.");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
