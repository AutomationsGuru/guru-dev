import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProjectMapTool } from '../../src/tools/builtins/projectMapTool.js';
import { createToolRegistry, executeRegisteredTool } from '../../src/tools/registry.js';
import { buildProjectMap } from '../../src/tools/projectMap/buildProjectMap.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

interface MapOutput {
  root: string;
  truncated: boolean;
  totalFiles: number;
  totalDirs: number;
  files: Array<{ path: string; bytes: number; symbols?: string[] }>;
  text: string;
}

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guruharness-project-map-"));
  tempDirectories.push(directory);

  return directory;
}

function write(root: string, relativePath: string, contents: string): void {
  const full = join(root, ...relativePath.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

async function runTool(input: Record<string, unknown>): Promise<{ status: string; output: MapOutput }> {
  const registry = createToolRegistry([createProjectMapTool()]);
  const observation = await executeRegisteredTool(registry, "project.map.build", input);

  return { status: observation.status, output: observation.output as MapOutput };
}

describe("createProjectMapTool", () => {
  it("should map a fixture tree through the tool registry with a symbol sketch", async () => {
    const root = makeTempDirectory();
    write(root, "src/index.ts", "export function main(): void {}\nexport const VERSION = 1;\n");
    write(root, "src/util/helper.ts", "export interface Helper {\n  run(): void;\n}\nexport class DefaultHelper {}\n");
    write(root, "README.md", "# fixture\n");

    const { status, output } = await runTool({ rootPath: root });

    expect(status).toBe("succeeded");
    expect(output.truncated).toBe(false);
    expect(output.totalFiles).toBe(3);
    expect(output.totalDirs).toBe(2);
    const paths = output.files.map((file) => file.path);
    expect(paths).toEqual(expect.arrayContaining(["src/index.ts", "src/util/helper.ts", "README.md"]));
    const index = output.files.find((file) => file.path === "src/index.ts");
    expect(index?.symbols).toEqual(expect.arrayContaining(["ƒ main()", "const VERSION"]));
    const helper = output.files.find((file) => file.path === "src/util/helper.ts");
    expect(helper?.symbols).toEqual(expect.arrayContaining(["interface Helper", "class DefaultHelper"]));
    // Rendered text carries the tree shape plus inline sketches.
    expect(output.text).toContain("src/");
    expect(output.text).toContain("index.ts — ƒ main(), const VERSION");
    expect(output.text).toContain("README.md");
  });

  it("should honor .gitignore rules including dir-only, wildcard, and negation", async () => {
    const root = makeTempDirectory();
    write(root, ".gitignore", "dist/\n*.log\n!important.log\ntmp\n");
    write(root, "dist/bundle.js", "ignored\n");
    write(root, "src/app.ts", "export function app(): void {}\n");
    write(root, "debug.log", "ignored\n");
    write(root, "important.log", "kept by negation\n");
    write(root, "tmp/scratch.txt", "ignored dir contents\n");

    const { status, output } = await runTool({ rootPath: root });

    expect(status).toBe("succeeded");
    const paths = output.files.map((file) => file.path);
    expect(paths).toEqual(expect.arrayContaining([".gitignore", "src/app.ts", "important.log"]));
    expect(paths).not.toContain("dist/bundle.js");
    expect(paths).not.toContain("debug.log");
    expect(paths).not.toContain("tmp/scratch.txt");
    expect(output.text).not.toContain("bundle.js");
    expect(output.text).not.toContain("debug.log");
    expect(output.text).not.toContain("scratch.txt");
    expect(output.text).toContain("important.log");
  });

  it("should stack a nested .gitignore on top of root rules", async () => {
    const root = makeTempDirectory();
    write(root, ".gitignore", "*.log\n");
    write(root, "pkg/.gitignore", "!keep.log\n");
    write(root, "top.log", "ignored at root\n");
    write(root, "pkg/keep.log", "re-included by nested rule\n");
    write(root, "pkg/drop.log", "still ignored by root rule\n");

    const { output } = await runTool({ rootPath: root });

    const paths = output.files.map((file) => file.path);
    expect(paths).toContain("pkg/keep.log");
    expect(paths).not.toContain("top.log");
    expect(paths).not.toContain("pkg/drop.log");
  });

  it("should stop at the file cap and flag truncation", async () => {
    const root = makeTempDirectory();
    for (let index = 0; index < 12; index += 1) {
      write(root, `f${String(index).padStart(2, "0")}.txt`, `file ${index}\n`);
    }

    const { output } = await runTool({ rootPath: root, maxFiles: 5 });

    expect(output.truncated).toBe(true);
    expect(output.totalFiles).toBeLessThanOrEqual(5);
    expect(output.text).toContain("walk truncated");
  });

  it("should stop at the depth cap and flag truncation", async () => {
    const root = makeTempDirectory();
    write(root, "a/b/c/d/deep.ts", "export function deep(): void {}\n");
    write(root, "shallow.ts", "export function shallow(): void {}\n");

    const { output } = await runTool({ rootPath: root, maxDepth: 2 });

    expect(output.truncated).toBe(true);
    const paths = output.files.map((file) => file.path);
    expect(paths).toContain("shallow.ts");
    expect(paths).not.toContain("a/b/c/d/deep.ts");
  });

  it("should never surface .env* files or node_modules even without a .gitignore", async () => {
    const root = makeTempDirectory();
    write(root, ".env", "SECRET=never\n");
    write(root, ".env.local", "SECRET=never\n");
    write(root, "node_modules/pkg/index.js", "module.exports = {};\n");
    write(root, "src/ok.ts", "export const ok = true;\n");

    const { output } = await runTool({ rootPath: root });

    const paths = output.files.map((file) => file.path);
    expect(paths).toEqual(["src/ok.ts"]);
    expect(output.text).not.toContain(".env");
    expect(output.text).not.toContain("node_modules");
  });

  it("should skip symlinks instead of following them", async () => {
    if (process.platform === "win32") {
      return; // symlink creation needs privileges on Windows dev boxes
    }
    const { symlinkSync } = await import("node:fs");
    const root = makeTempDirectory();
    write(root, "real/file.ts", "export function file(): void {}\n");
    symlinkSync(join(root, "real"), join(root, "loop"), "dir");

    const { output } = await runTool({ rootPath: root });

    expect(output.truncated).toBe(false);
    const paths = output.files.map((file) => file.path);
    expect(paths).toEqual(["real/file.ts"]);
  });

  it("should omit symbols when includeSymbols is false", async () => {
    const root = makeTempDirectory();
    write(root, "src/index.ts", "export function main(): void {}\n");

    const { output } = await runTool({ rootPath: root, includeSymbols: false });

    const index = output.files.find((file) => file.path === "src/index.ts");
    expect(index?.symbols).toBeUndefined();
    expect(output.text).toContain("index.ts");
    expect(output.text).not.toContain("ƒ main()");
  });

  it("should fail honestly for a missing rootPath", async () => {
    const root = makeTempDirectory();
    const missing = join(root, "does-not-exist");

    const { status } = await runTool({ rootPath: missing });

    expect(status).toBe("failed");
  });

  it("should reject out-of-range caps at the input schema", async () => {
    const root = makeTempDirectory();

    const { status } = await runTool({ rootPath: root, maxFiles: 100_000 });

    expect(status).toBe("failed");
  });
});

describe("buildProjectMap", () => {
  it("should cap rendered text and mark truncation in the text", () => {
    const root = makeTempDirectory();
    for (let index = 0; index < 40; index += 1) {
      write(root, `dir${index}/file${index}.txt`, `contents ${index}\n`);
    }

    const result = buildProjectMap(root, { maxTextChars: 200 });

    expect(result.text.length).toBeLessThanOrEqual(300);
    expect(result.text).toContain("truncated");
  });

  it("should not crash on an empty directory", () => {
    const root = makeTempDirectory();

    const result = buildProjectMap(root);

    expect(result.truncated).toBe(false);
    expect(result.totalFiles).toBe(0);
    expect(result.text).toBe("");
  });

  it("should bound the symbol sketch per file", () => {
    const root = makeTempDirectory();
    const exports = Array.from({ length: 30 }, (_, index) => `export function fn${index}(): void {}`).join("\n");
    write(root, "many.ts", `${exports}\n`);

    const result = buildProjectMap(root, { maxSymbolsPerFile: 5 });

    const file = result.files.find((entry) => entry.path === "many.ts");
    expect(file?.symbols?.length).toBe(5);
  });
});
