import { describe, it, expect, beforeEach } from "vitest";
import { normalize as pathNormalize, sep as pathSep } from "node:path";
import {
  exportToDir,
  importFromDir,
  suggestCommitMessage,
  type MemoryBlock,
  type InjectableFs
} from '../../src/memory/versionedMemoryStore.js';

// In-memory fs mock
class MockFs implements InjectableFs {
  public files = new Map<string, string>();

  private norm(p: string): string {
    return pathNormalize(p);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {}

  async writeFile(path: string, data: string, options?: { encoding?: "utf8" }): Promise<void> {
    this.files.set(this.norm(path), data);
  }

  async readFile(path: string, options: { encoding: "utf8" }): Promise<string> {
    const data = this.files.get(this.norm(path));
    if (data === undefined) {
      const err = new Error("ENOENT");
      (err as any).code = "ENOENT";
      throw err;
    }
    return data;
  }

  async readdir(path: string): Promise<string[]> {
    // simplified readdir: only matches files exactly starting with path/
    // (for tests, we don't need full posix hierarchy matching, but let's make it work for root)
    const n = this.norm(path);
    const sep = pathSep;
    const normalizedPath = n.endsWith(sep) ? n : n + sep;
    const result = new Set<string>();

    for (const key of this.files.keys()) {
      if (key.startsWith(normalizedPath)) {
        const remaining = key.substring(normalizedPath.length);
        if (!remaining.includes("/")) {
          result.add(remaining);
        }
      }
    }

    // Also handle case where the path exactly matches a prefix
    // (if our mock only uses join, it might not have trailing slashes)
    const exactPrefix = path + (path.endsWith("/") ? "" : (path.includes("\\") ? "\\" : "/"));
    for (const key of this.files.keys()) {
      if (key.startsWith(exactPrefix)) {
         const remaining = key.substring(exactPrefix.length);
         if (!remaining.includes("/") && !remaining.includes("\\")) {
             result.add(remaining);
         }
      }
    }

    // In testing, since path.join uses local OS separators, let's just cheat and do a simple string matching
    // that works for the tests.
    // Instead of complex logic, let's just make it very simple based on what we know the code does.
    const readdirResult: string[] = [];
    const rootPath = path;
    for (const key of this.files.keys()) {
       // if key is rootPath + "/" + filename or rootPath + "\" + filename
       if (key.startsWith(rootPath)) {
         const rel = key.substring(rootPath.length);
         if ((rel.startsWith("/") || rel.startsWith("\\")) && rel.length > 1) {
             const filename = rel.substring(1);
             if (!filename.includes("/") && !filename.includes("\\")) {
                 readdirResult.push(filename);
             }
         }
       }
    }

    if (readdirResult.length === 0 && !this.files.has(path)) {
       // To be safe, let's not throw ENOENT for readdir if no files exist,
       // but maybe we should to emulate real FS.
       // The mock is simple, we can just return empty array.
    }
    return readdirResult;
  }

  async stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }> {
    if (this.files.has(path)) {
      return { isDirectory: () => false, isFile: () => true };
    }
    const err = new Error("ENOENT");
    (err as any).code = "ENOENT";
    throw err;
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    if (this.files.has(path)) {
      this.files.delete(path);
    }
  }
}

describe("versionedMemoryStore", () => {
  let fs: MockFs;
  const root = "/mem-root";

  beforeEach(() => {
    fs = new MockFs();
  });

  it("exports blocks to directory and returns change summary", async () => {
    const blocks: MemoryBlock[] = [
      { name: "core", content: "core content" },
      { name: "persona", content: "persona content" }
    ];

    const summary = await exportToDir(blocks, root, fs);

    expect(summary.added).toEqual(["core", "persona"]);
    expect(summary.modified).toEqual([]);
    expect(summary.deleted).toEqual([]);

    expect(await fs.readFile("/mem-root/core.md", { encoding: "utf8" })).toBe("core content");
    expect(await fs.readFile("/mem-root/persona.md", { encoding: "utf8" })).toBe("persona content");
  });

  it("imports blocks from directory", async () => {
    fs.files.set("/mem-root/core.md", "core content");
    fs.files.set("/mem-root/persona.md", "persona content");
    // Ignore non-md files
    fs.files.set("/mem-root/other.txt", "ignore");

    const blocks = await importFromDir(root, fs);
    expect(blocks).toHaveLength(2);
    // order doesn't matter strictly, but let's check contents
    expect(blocks).toContainEqual({ name: "core", content: "core content" });
    expect(blocks).toContainEqual({ name: "persona", content: "persona content" });
  });

  it("handles round-trip: export then import", async () => {
    const original: MemoryBlock[] = [
      { name: "block1", content: "val1" },
      { name: "block2", content: "val2" }
    ];

    await exportToDir(original, root, fs);
    const imported = await importFromDir(root, fs);

    expect(imported.sort((a, b) => a.name.localeCompare(b.name)))
      .toEqual(original.sort((a, b) => a.name.localeCompare(b.name)));
  });

  it("tracks modifications and deletions", async () => {
    // initial state
    fs.files.set("/mem-root/keep.md", "keep me");
    fs.files.set("/mem-root/modify.md", "old content");
    fs.files.set("/mem-root/delete.md", "bye");

    const blocks: MemoryBlock[] = [
      { name: "keep", content: "keep me" },
      { name: "modify", content: "new content" },
      { name: "add", content: "hello" }
    ];

    const summary = await exportToDir(blocks, root, fs);

    expect(summary.added).toEqual(["add"]);
    expect(summary.modified).toEqual(["modify"]);
    expect(summary.deleted).toEqual(["delete"]);

    const imported = await importFromDir(root, fs);
    const names = imported.map(b => b.name).sort();
    expect(names).toEqual(["add", "keep", "modify"]);
  });

  it("rejects path traversal in export", async () => {
    const blocks: MemoryBlock[] = [
      { name: "../outside", content: "malicious" }
    ];
    await expect(exportToDir(blocks, root, fs)).rejects.toThrow(/Invalid block name/);
  });

  it("suggests commit message based on summary", () => {
    expect(suggestCommitMessage({ added: [], modified: [], deleted: [] }))
      .toBe("chore(memory): sync memory blocks");

    expect(suggestCommitMessage({ added: ["core"], modified: [], deleted: [] }))
      .toBe("chore(memory): added core");

    expect(suggestCommitMessage({ added: ["core", "persona"], modified: ["human"], deleted: ["temp"] }))
      .toBe("chore(memory): added core, persona; updated human; removed temp");
  });
});
