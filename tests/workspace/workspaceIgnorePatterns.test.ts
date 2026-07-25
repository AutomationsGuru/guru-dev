import { describe, it, expect } from "vitest";
import { WorkspaceIgnorePatterns } from '../../src/workspace/workspaceIgnorePatterns.js';

describe("WorkspaceIgnorePatterns", () => {
  describe("empty pattern sets", () => {
    it("should allow all files when patterns are empty", () => {
      const matcher = WorkspaceIgnorePatterns.fromLines([]);
      expect(matcher.isIgnored("src/index.ts")).toBe(false);
      expect(matcher.isIgnored("node_modules/foo.js")).toBe(false);
      expect(matcher.isIgnored(".git/config")).toBe(false);
    });

    it("should allow all files when only empty lines and whitespace are provided", () => {
      const matcher = WorkspaceIgnorePatterns.fromLines(["   ", "", "  \n  "]);
      expect(matcher.isIgnored("src/index.ts")).toBe(false);
    });
  });

  describe("comments and whitespace", () => {
    it("should skip lines starting with #", () => {
      const matcher = WorkspaceIgnorePatterns.fromLines([
        "# ignore all typescript files",
        "*.ts",
        "# but not logs",
        "# *.log",
      ]);
      expect(matcher.isIgnored("src/index.ts")).toBe(true);
      expect(matcher.isIgnored("app.log")).toBe(false);
    });

    it("should skip comments with leading spaces (if we trim them)", () => {
      const matcher = WorkspaceIgnorePatterns.fromLines([
        "  # this is a comment",
        "*.log",
      ]);
      expect(matcher.isIgnored("app.log")).toBe(true);
      expect(matcher.isIgnored("somefile.txt")).toBe(false);
    });
  });

  describe("single folder match (unanchored)", () => {
    it("should ignore folder itself and all files recursively inside", () => {
      const matcher = WorkspaceIgnorePatterns.fromLines(["node_modules"]);
      expect(matcher.isIgnored("node_modules")).toBe(true);
      expect(matcher.isIgnored("node_modules/")).toBe(true);
      expect(matcher.isIgnored("node_modules/foo/bar.js")).toBe(true);
      expect(matcher.isIgnored("src/node_modules/foo.js")).toBe(true);
      expect(matcher.isIgnored("src/node_modules")).toBe(true);
      expect(matcher.isIgnored("node_modules_fake/foo.js")).toBe(false);
    });

    it("should match folder and contents with trailing slash", () => {
      const matcher = WorkspaceIgnorePatterns.fromLines(["node_modules/"]);
      expect(matcher.isIgnored("node_modules")).toBe(true);
      expect(matcher.isIgnored("node_modules/foo/bar.js")).toBe(true);
      expect(matcher.isIgnored("src/node_modules/foo.js")).toBe(true);
      expect(matcher.isIgnored("node_modules_fake/foo.js")).toBe(false);
    });
  });

  describe("standard glob match", () => {
    it("should ignore files matching *.log at any level", () => {
      const matcher = WorkspaceIgnorePatterns.fromLines(["*.log"]);
      expect(matcher.isIgnored("app.log")).toBe(true);
      expect(matcher.isIgnored("src/app.log")).toBe(true);
      expect(matcher.isIgnored("src/components/button/test.log")).toBe(true);
      expect(matcher.isIgnored("app.log.backup")).toBe(false);
      expect(matcher.isIgnored("log")).toBe(false);
    });

    it("should match single character with ?", () => {
      const matcher = WorkspaceIgnorePatterns.fromLines(["image.p?g"]);
      expect(matcher.isIgnored("image.png")).toBe(true);
      expect(matcher.isIgnored("image.jpg")).toBe(false);
      expect(matcher.isIgnored("image.ppg")).toBe(true);
      expect(matcher.isIgnored("image.pnng")).toBe(false);
      expect(matcher.isIgnored("src/image.png")).toBe(true);
    });
  });

  describe("root-relative vs deep matches", () => {
    it("should anchor patterns with leading slash to root", () => {
      const matcher = WorkspaceIgnorePatterns.fromLines(["/temp/*"]);
      expect(matcher.isIgnored("temp/foo.js")).toBe(true);
      expect(matcher.isIgnored("temp/bar/baz.js")).toBe(true);
      expect(matcher.isIgnored("src/temp/foo.js")).toBe(false);
    });

    it("should anchor patterns with internal slash to root", () => {
      const matcher = WorkspaceIgnorePatterns.fromLines(["src/temp"]);
      expect(matcher.isIgnored("src/temp")).toBe(true);
      expect(matcher.isIgnored("src/temp/foo.js")).toBe(true);
      expect(matcher.isIgnored("foo/src/temp/bar.js")).toBe(false);
    });

    it("should support explicit **/ wildcard for deep matches of multi-level patterns", () => {
      const matcher = WorkspaceIgnorePatterns.fromLines(["**/foo/bar"]);
      expect(matcher.isIgnored("foo/bar")).toBe(true);
      expect(matcher.isIgnored("foo/bar/baz.js")).toBe(true);
      expect(matcher.isIgnored("src/foo/bar")).toBe(true);
      expect(matcher.isIgnored("src/foo/bar/baz.js")).toBe(true);
      expect(matcher.isIgnored("src/foo/baz")).toBe(false);
    });

    it("should support middle **/ wildcard", () => {
      const matcher = WorkspaceIgnorePatterns.fromLines(["a/**/b"]);
      expect(matcher.isIgnored("a/b")).toBe(true);
      expect(matcher.isIgnored("a/x/b")).toBe(true);
      expect(matcher.isIgnored("a/x/y/b")).toBe(true);
      expect(matcher.isIgnored("src/a/x/b")).toBe(false); // anchored to root since no leading **/
    });
  });

  describe("path normalization", () => {
    it("should handle backward slashes (Windows paths)", () => {
      const matcher = WorkspaceIgnorePatterns.fromLines(["node_modules/", "*.log"]);
      expect(matcher.isIgnored("node_modules\\foo\\bar.js")).toBe(true);
      expect(matcher.isIgnored("src\\app.log")).toBe(true);
      expect(matcher.isIgnored("src\\node_modules\\foo.js")).toBe(true);
    });

    it("should handle leading ./ and relative path prefixes", () => {
      const matcher = WorkspaceIgnorePatterns.fromLines(["node_modules/", "*.log"]);
      expect(matcher.isIgnored("./node_modules/foo.js")).toBe(true);
      expect(matcher.isIgnored("./src/app.log")).toBe(true);
    });
  });

  describe("negation", () => {
    it("should support simple negation", () => {
      const matcher = WorkspaceIgnorePatterns.fromLines(["*.log", "!important.log"]);
      expect(matcher.isIgnored("app.log")).toBe(true);
      expect(matcher.isIgnored("important.log")).toBe(false);
      expect(matcher.isIgnored("src/important.log")).toBe(false);
    });

    it("should not allow re-including files if parent directory is ignored", () => {
      const matcher = WorkspaceIgnorePatterns.fromLines([
        "temp/",
        "!temp/important.txt",
      ]);
      // Since temp/ is ignored as a parent directory, we can't re-include important.txt
      expect(matcher.isIgnored("temp/important.txt")).toBe(true);
    });

    it("should allow re-including files if only parent folder contents are ignored, but not the folder itself", () => {
      const matcher = WorkspaceIgnorePatterns.fromLines([
        "temp/*",
        "!temp/important.txt",
      ]);
      // Since temp/* ignores contents but not temp itself, important.txt can be re-included
      expect(matcher.isIgnored("temp/important.txt")).toBe(false);
      expect(matcher.isIgnored("temp/other.txt")).toBe(true);
    });
  });
});
