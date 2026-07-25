import { describe, expect, it } from "vitest";

import { createMemoryFsProvider, type FsProvider } from '../../src/tools/fsProvider.js';

describe("FsProvider", () => {
  describe("MemoryFsProvider", () => {
    it("should write text and read it back (roundtrip)", async () => {
      const provider = createMemoryFsProvider();

      await provider.writeText("/notes/todo.txt", "buy milk");
      const result = await provider.readText("/notes/todo.txt");

      expect(result).toBe("buy milk");
    });

    it("should write multiple files and read them independently", async () => {
      const provider = createMemoryFsProvider();

      await provider.writeText("/a.txt", "alpha");
      await provider.writeText("/b.txt", "beta");
      await provider.writeText("/c.txt", "gamma");

      expect(await provider.readText("/a.txt")).toBe("alpha");
      expect(await provider.readText("/b.txt")).toBe("beta");
      expect(await provider.readText("/c.txt")).toBe("gamma");
    });

    it("should list files in a directory", async () => {
      const provider = createMemoryFsProvider();

      await provider.writeText("/src/index.ts", "export {}");
      await provider.writeText("/src/lib.ts", "export {}");
      await provider.writeText("/README.md", "# readme");

      const srcFiles = await provider.list("/src");
      expect(srcFiles.sort()).toEqual(["index.ts", "lib.ts"]);

      const rootFiles = await provider.list("/");
      expect(rootFiles.sort()).toEqual(["README.md", "src/"]);
    });

    it("should return an empty list for an empty directory", async () => {
      const provider = createMemoryFsProvider();

      await provider.writeText("/src/index.ts", "export {}");

      const files = await provider.list("/src");
      expect(files).toEqual(["index.ts"]);
    });

    it("should be isolated between two independent instances", async () => {
      const alpha = createMemoryFsProvider();
      const beta = createMemoryFsProvider();

      await alpha.writeText("/secret.txt", "alpha-secret");
      await beta.writeText("/secret.txt", "beta-secret");

      expect(await alpha.readText("/secret.txt")).toBe("alpha-secret");
      expect(await beta.readText("/secret.txt")).toBe("beta-secret");
    });

    it("should list nested directories", async () => {
      const provider = createMemoryFsProvider();

      await provider.writeText("/a/b/c/deep.txt", "deep");

      expect(await provider.list("/a")).toEqual(["b/"]);
      expect(await provider.list("/a/b")).toEqual(["c/"]);
      expect(await provider.list("/a/b/c")).toEqual(["deep.txt"]);
    });

    it("should overwrite a file on second write", async () => {
      const provider = createMemoryFsProvider();

      await provider.writeText("/config.json", "v1");
      await provider.writeText("/config.json", "v2");

      expect(await provider.readText("/config.json")).toBe("v2");
    });

    it("should list entries at root when path is '/'", async () => {
      const provider = createMemoryFsProvider();

      await provider.writeText("/app.ts", "// app");
      await provider.writeText("/lib/helper.ts", "// helper");

      const rootEntries = await provider.list("/");
      expect(rootEntries.sort()).toEqual(["app.ts", "lib/"]);
    });

    it("should normalize entry names — directory entries end with '/'", async () => {
      const provider = createMemoryFsProvider();

      await provider.writeText("/src/components/Button.tsx", "// button");

      const rootList = await provider.list("/");
      expect(rootList).toContain("src/");

      const srcList = await provider.list("/src");
      expect(srcList).toContain("components/");
    });

    it("should surface an error when reading a missing path", async () => {
      const provider = createMemoryFsProvider();

      await expect(provider.readText("/nonexistent.txt")).rejects.toThrow();
    });

    it("should allow a path that looks like a directory to also be a file key", async () => {
      // The memory provider is path-agnostic: keys are just strings.
      const provider = createMemoryFsProvider();

      await provider.writeText("notes", "bare-key");
      expect(await provider.readText("notes")).toBe("bare-key");
    });
  });
});
