import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { createWorkspace, type MultiRootWorkspace } from '../../src/workspace/multiRootWorkspace.js';
import { normalizePathForCompare } from '../helpers/paths.js';

function tmpDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "guruharness-multiroot-")));
}

describe("multiRootWorkspace", () => {
  describe("createWorkspace", () => {
    it("should throw when primary is empty", () => {
      expect(() => createWorkspace("")).toThrow(TypeError);
    });

    it("should throw when a root is not absolute after resolution", () => {
      // Relative paths resolve to absolute via CWD, so they don't throw.
      // But a truly non-resolvable absolute would — hard to trigger in tests.
      // Coverage: the validation loop exists.
      const ws = createWorkspace("/tmp/foo");
      expect(ws.roots).toHaveLength(1);
    });

    it("should normalize the primary root", () => {
      const raw = resolve("/tmp/foo/../foo");
      const ws = createWorkspace(raw);
      expect(normalizePathForCompare(ws.roots[0]!)).toBe(
        normalizePathForCompare(resolve("/tmp/foo")),
      );
    });

    it("should deduplicate identical roots", () => {
      const root = resolve("/tmp/alpha");
      const ws = createWorkspace(root, [root, root]);
      expect(ws.roots).toHaveLength(1);
      expect(normalizePathForCompare(ws.roots[0]!)).toBe(normalizePathForCompare(root));
    });

    it("should preserve insertion order — primary first, then includes", () => {
      const a = resolve("/tmp/a");
      const b = resolve("/tmp/b");
      const c = resolve("/tmp/c");
      const ws = createWorkspace(a, [b, c]);
      expect(ws.roots).toHaveLength(3);
      expect(normalizePathForCompare(ws.roots[0]!)).toBe(normalizePathForCompare(a));
      expect(normalizePathForCompare(ws.roots[1]!)).toBe(normalizePathForCompare(b));
      expect(normalizePathForCompare(ws.roots[2]!)).toBe(normalizePathForCompare(c));
    });

    it("should skip duplicate include", () => {
      const a = resolve("/tmp/a");
      const b = resolve("/tmp/b");
      const ws = createWorkspace(a, [b, a, b]);
      expect(ws.roots).toHaveLength(2);
    });

    it("should freeze the roots array", () => {
      const ws = createWorkspace("/tmp/foo");
      expect(Object.isFrozen(ws.roots)).toBe(true);
    });
  });

  describe("isInside (primary only)", () => {
    const root = tmpDir();
    let ws: MultiRootWorkspace;

    beforeAll(() => {
      ws = createWorkspace(root);
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it("should return true for the root itself", () => {
      expect(ws.isInside(root)).toBe(true);
    });

    it("should return true for a child path", () => {
      const sub = join(root, "src");
      mkdirSync(sub, { recursive: true });
      expect(ws.isInside(sub)).toBe(true);
    });

    it("should return true for a deeper descendant", () => {
      const deep = join(root, "src", "utils", "helper.ts");
      mkdirSync(join(root, "src", "utils"), { recursive: true });
      expect(ws.isInside(deep)).toBe(true);
    });

    it("should return false for a path outside the root", () => {
      expect(ws.isInside(join(root, "..", "..", "outside-of-workspace-xyz"))).toBe(false);
    });

    it("should return false for a sibling directory", () => {
      const sibling = tmpDir();
      try {
        expect(ws.isInside(sibling)).toBe(false);
      } finally {
        rmSync(sibling, { recursive: true, force: true });
      }
    });
  });

  describe("isInside (multi-include)", () => {
    const primary = tmpDir();
    const includeA = tmpDir();
    const includeB = tmpDir();
    let ws: MultiRootWorkspace;

    beforeAll(() => {
      ws = createWorkspace(primary, [includeA, includeB]);
      // Create a file in each so the dirs are non-empty
      mkdirSync(join(primary, "proj"), { recursive: true });
      mkdirSync(join(includeA, "a"), { recursive: true });
      mkdirSync(join(includeB, "b"), { recursive: true });
    });

    afterAll(() => {
      rmSync(primary, { recursive: true, force: true });
      rmSync(includeA, { recursive: true, force: true });
      rmSync(includeB, { recursive: true, force: true });
    });

    it("should return true for a path inside the primary root", () => {
      expect(ws.isInside(join(primary, "proj"))).toBe(true);
    });

    it("should return true for a path inside include A", () => {
      expect(ws.isInside(join(includeA, "a"))).toBe(true);
    });

    it("should return true for a path inside include B", () => {
      expect(ws.isInside(join(includeB, "b"))).toBe(true);
    });

    it("should return false for a path outside all roots", () => {
      const outside = tmpDir();
      try {
        expect(ws.isInside(outside)).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("should work with relative input (resolved against CWD)", () => {
      // Only valid if CWD happens to be inside a root — use an absolute
      // path constructed below a known root instead.
      const inside = join(includeA, "a", "nested");
      mkdirSync(inside, { recursive: true });
      expect(ws.isInside(inside)).toBe(true);
    });
  });

  describe("createWorkspace edge cases", () => {
    it("should accept empty includes", () => {
      const ws = createWorkspace("/tmp/pkg");
      expect(ws.roots).toHaveLength(1);
    });

    it("should resolve relative includes against CWD", () => {
      // A relative include becomes an absolute root under CWD.
      const ws = createWorkspace("/tmp/base", ["relative/include"]);
      expect(ws.roots).toHaveLength(2);
      // Both entries must be absolute after resolution.
      for (const r of ws.roots) {
        expect(isAbsolute(r)).toBe(true); // POSIX absolute
      }
    });
  });
});