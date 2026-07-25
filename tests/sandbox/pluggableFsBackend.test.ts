import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createLocalFsBackend,
  createMemoryFsBackend,
  createPluggableFs,
  type FsBackend
} from '../../src/sandbox/pluggableFsBackend.js';

describe("pluggableFsBackend", () => {
  describe("LocalFsBackend", () => {
    let tempDir: string;
    let backend: FsBackend;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "fs-test-"));
      backend = createLocalFsBackend({ root: tempDir });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("should write and read a file", () => {
      backend.write("hello.txt", "world");
      expect(backend.read("hello.txt")).toBe("world");
    });

    it("should list directory contents", () => {
      backend.write("a.txt", "1");
      backend.write("b.txt", "2");
      const listing = backend.list(".");
      expect(listing).toContain("a.txt");
      expect(listing).toContain("b.txt");
    });

    it("should return empty list for non-existent dir", () => {
      expect(backend.list("nonexistent")).toEqual([]);
    });
  });

  describe("MemoryFsBackend", () => {
    let backend: FsBackend;

    beforeEach(() => {
      backend = createMemoryFsBackend({ "seed.txt": "initial" });
    });

    it("should read/write via memory map", () => {
      expect(backend.read("seed.txt")).toBe("initial");
      backend.write("new.txt", "created");
      expect(backend.read("new.txt")).toBe("created");
    });

    it("should list keys with prefix", () => {
      backend.write("dir/file.txt", "x");
      const list = backend.list("dir");
      expect(list).toContain("file.txt");
    });
  });

  describe("PluggableFs with injectable map", () => {
    it("should default to local and allow register override", () => {
      const memory = createMemoryFsBackend();
      const pluggable = createPluggableFs();
      pluggable.register("mem", memory);
      const memBackend = pluggable.use("mem");
      memBackend.write("test", "injected");
      expect(memBackend.read("test")).toBe("injected");
    });

    it("should throw on unknown backend key", () => {
      const pluggable = createPluggableFs();
      expect(() => pluggable.use("missing")).toThrow(/not registered/);
    });
  });
});
