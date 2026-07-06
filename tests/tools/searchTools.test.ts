import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createGlobTool, createGrepTool, createLsTool, globToRegExp } from "../../src/tools/builtins/searchTools.js";

const root = join(tmpdir(), `guru-search-${process.pid}`);
mkdirSync(join(root, "src", "deep"), { recursive: true });
mkdirSync(join(root, "node_modules", "x"), { recursive: true });
writeFileSync(join(root, "src", "alpha.ts"), "const alpha = 1;\nexport function findMe(): number {\n  return alpha;\n}\n");
writeFileSync(join(root, "src", "deep", "beta.ts"), "// findMe appears here too\n");
writeFileSync(join(root, "src", "notes.md"), "nothing here\n");
writeFileSync(join(root, "node_modules", "x", "junk.ts"), "findMe in junk\n");
try {
  symlinkSync(join(root, "src"), join(root, "src", "deep", "loop"), "junction");
} catch {
  /* symlink may need privileges — the walk must be safe either way */
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("globToRegExp", () => {
  it("translates *, **, ? and treats everything else literally", () => {
    expect(globToRegExp("**/*.ts").test("src/deep/beta.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("alpha.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/alpha.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/deep/beta.ts")).toBe(false);
    expect(globToRegExp("src/?lpha.ts").test("src/alpha.ts")).toBe(true);
    expect(globToRegExp("*.md").test("src/notes.md")).toBe(false);
  });
});

describe("grep — typed matches", () => {
  const grep = createGrepTool();

  it("returns {file, line, content} matches, skipping node_modules", async () => {
    const result = await grep.execute({ repoRoot: root, pattern: "findMe", path: ".", caseInsensitive: false, maxMatches: 100 }, {});
    const files = result.matches.map((match) => match.file);
    expect(files).toContain("src/alpha.ts");
    expect(files).toContain("src/deep/beta.ts");
    expect(files.some((file) => file.includes("node_modules"))).toBe(false);
    const alpha = result.matches.find((match) => match.file === "src/alpha.ts");
    expect(alpha?.line).toBe(2);
    expect(alpha?.content).toContain("export function findMe");
  });

  it("include glob filters; invalid regex blocks honestly; containment enforced", async () => {
    const onlyMd = await grep.execute({ repoRoot: root, pattern: ".", path: ".", include: "**/*.md", caseInsensitive: false, maxMatches: 10 }, {});
    expect(onlyMd.matches.every((match) => match.file.endsWith(".md"))).toBe(true);
    const bad = await grep.execute({ repoRoot: root, pattern: "(", path: ".", caseInsensitive: false, maxMatches: 10 }, {});
    expect(bad.blockers.length).toBeGreaterThan(0);
    const escape = await grep.execute({ repoRoot: root, pattern: "x", path: "../..", caseInsensitive: false, maxMatches: 10 }, {});
    expect(escape.blockers[0]).toContain("escapes");
  });

  it("caps matches and reports truncation", async () => {
    const result = await grep.execute({ repoRoot: root, pattern: "e", path: ".", caseInsensitive: true, maxMatches: 2 }, {});
    expect(result.matches.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });
});

describe("glob — typed paths", () => {
  const glob = createGlobTool();

  it("matches patterns over the bounded walk, newest first", async () => {
    const result = await glob.execute({ repoRoot: root, pattern: "**/*.ts", path: ".", maxResults: 100 }, {});
    expect(result.paths).toContain("src/alpha.ts");
    expect(result.paths).toContain("src/deep/beta.ts");
    expect(result.paths.some((path) => path.includes("node_modules"))).toBe(false);
  });
});

describe("ls — typed entries", () => {
  const ls = createLsTool();

  it("lists {name,type,size,modified}, dirs first", async () => {
    const result = await ls.execute({ repoRoot: root, path: "src", includeHidden: false }, {});
    const names = result.entries.map((entry) => entry.name);
    expect(names[0]).toBe("deep"); // dir sorts first
    expect(names).toContain("alpha.ts");
    const alpha = result.entries.find((entry) => entry.name === "alpha.ts");
    expect(alpha?.type).toBe("file");
    expect(alpha?.size ?? 0).toBeGreaterThan(0);
  });

  it("containment blocks escapes", async () => {
    const result = await ls.execute({ repoRoot: root, path: "..", includeHidden: false }, {});
    expect(result.blockers[0]).toContain("escapes");
  });
});
