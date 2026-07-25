import { fromLines } from '../../src/workspace/workspaceIgnorePatterns.js';

describe("workspace ignore patterns", () => {
  // ── empty / blank input ──────────────────────────────────────────────────

  describe("empty input", () => {
    it("allows any path when there are no patterns", () => {
      const p = fromLines([]);

      expect(p.isIgnored("anything.txt")).toBe(false);
      expect(p.isIgnored("deeply/nested/path.ts")).toBe(false);
      expect(p.isIgnored("node_modules")).toBe(false);
    });

    it("allows any path when lines are only blank or comments", () => {
      const p = fromLines(["", "  ", "# comment", "  # indented comment"]);

      expect(p.isIgnored("anything.txt")).toBe(false);
      expect(p.isIgnored("src/index.ts")).toBe(false);
    });
  });

  // ── common gitignore patterns ────────────────────────────────────────────

  describe("basename-only patterns", () => {
    it("matches node_modules at any depth", () => {
      const p = fromLines(["node_modules"]);

      expect(p.isIgnored("node_modules")).toBe(true);
      expect(p.isIgnored("node_modules/package.json")).toBe(true);
      expect(p.isIgnored("src/node_modules")).toBe(true);
      expect(p.isIgnored("foo/bar/node_modules/baz")).toBe(true);
    });

    it("matches *.log at any depth", () => {
      const p = fromLines(["*.log"]);

      expect(p.isIgnored("debug.log")).toBe(true);
      expect(p.isIgnored("logs/error.log")).toBe(true);
      expect(p.isIgnored("a/b/c/app.log")).toBe(true);
      expect(p.isIgnored("log.txt")).toBe(false);
    });

    it("matches .env files", () => {
      const p = fromLines([".env"]);

      expect(p.isIgnored(".env")).toBe(true);
      expect(p.isIgnored("src/.env")).toBe(true);
      expect(p.isIgnored(".env.local")).toBe(false);
    });

    it("matches .git at any depth", () => {
      const p = fromLines([".git"]);

      expect(p.isIgnored(".git")).toBe(true);
      expect(p.isIgnored("subdir/.git")).toBe(true);
      expect(p.isIgnored(".gitignore")).toBe(false);
    });
  });

  // ── anchored patterns (leading /) ────────────────────────────────────────

  describe("root-anchored patterns", () => {
    it("matches only at the root with a leading /", () => {
      const p = fromLines(["/build"]);

      expect(p.isIgnored("build")).toBe(true);
      expect(p.isIgnored("build/output.js")).toBe(true);
      expect(p.isIgnored("src/build")).toBe(false);
      expect(p.isIgnored("src/build/index.js")).toBe(false);
    });

    it("matches anchored directory-only pattern", () => {
      const p = fromLines(["/dist/"]);

      expect(p.isIgnored("dist/")).toBe(true);
      // Directory match implies everything inside it.
      expect(p.isIgnored("dist/index.html")).toBe(true);
      expect(p.isIgnored("dist/a/b/c/deep.js")).toBe(true);
      expect(p.isIgnored("src/dist/")).toBe(false);
    });
  });

  // ── directory-only patterns (trailing /) ─────────────────────────────────

  describe("directory-only patterns", () => {
    it("matches directory paths (trailing /) but not files with the same base name", () => {
      const p = fromLines(["temp/"]);

      // Directory paths (trailing slash) — matched
      expect(p.isIgnored("temp/")).toBe(true);
      expect(p.isIgnored("src/temp/")).toBe(true);
      // Contents of ignored directory are also ignored
      expect(p.isIgnored("temp/file.txt")).toBe(true);
      expect(p.isIgnored("src/temp/file.txt")).toBe(true);

      // Bare file name (no trailing slash) — NOT matched by dir-only
      expect(p.isIgnored("temp")).toBe(false);
      expect(p.isIgnored("src/temp")).toBe(false);
    });
  });

  // ── wildcard * ───────────────────────────────────────────────────────────

  describe("single-star wildcard *", () => {
    it("matches anything within a single segment", () => {
      const p = fromLines(["*.ts"]);

      expect(p.isIgnored("file.ts")).toBe(true);
      expect(p.isIgnored("src/file.ts")).toBe(true);
      expect(p.isIgnored("a/b/c/file.ts")).toBe(true);
      expect(p.isIgnored("file.tsx")).toBe(false);
      expect(p.isIgnored("file.ts.bak")).toBe(false);
    });

    it("matches * in the middle of a pattern", () => {
      const p = fromLines(["test-*.js"]);

      expect(p.isIgnored("test-foo.js")).toBe(true);
      expect(p.isIgnored("test-.js")).toBe(true);
      expect(p.isIgnored("tests/foo.js")).toBe(false);
    });
  });

  // ── wildcard ** ──────────────────────────────────────────────────────────

  describe("double-star wildcard **", () => {
    it("matches across path segments", () => {
      const p = fromLines(["src/**/*.test.ts"]);

      expect(p.isIgnored("src/foo.test.ts")).toBe(true);
      expect(p.isIgnored("src/a/foo.test.ts")).toBe(true);
      expect(p.isIgnored("src/a/b/c/foo.test.ts")).toBe(true);
      expect(p.isIgnored("lib/foo.test.ts")).toBe(false);
    });

    it("matches **/ prefix as zero-or-more leading segments", () => {
      const p = fromLines(["**/*.md"]);

      expect(p.isIgnored("README.md")).toBe(true);
      expect(p.isIgnored("docs/README.md")).toBe(true);
      expect(p.isIgnored("a/b/c/README.md")).toBe(true);
      expect(p.isIgnored("README.txt")).toBe(false);
    });

    it("matches trailing /** for all contents of a dir", () => {
      const p = fromLines(["dist/**"]);

      expect(p.isIgnored("dist/file.js")).toBe(true);
      expect(p.isIgnored("dist/a/b/c/deep.js")).toBe(true);
      // Without leading /, dist/** matches any 'dist' directory at any depth.
      expect(p.isIgnored("src/dist/file.js")).toBe(true);
    });
  });

  // ── wildcard ? ───────────────────────────────────────────────────────────

  describe("question-mark wildcard ?", () => {
    it("matches exactly one non-slash character", () => {
      const p = fromLines(["page-?.tsx"]);

      expect(p.isIgnored("page-1.tsx")).toBe(true);
      expect(p.isIgnored("page-a.tsx")).toBe(true);
      expect(p.isIgnored("page-12.tsx")).toBe(false);
      // `?` matches exactly one char; in `page-.tsx` the `?` would eat the `.`
      // leaving nothing for the literal `.tsx` suffix.
      expect(p.isIgnored("page-.tsx")).toBe(false);
    });
  });

  // ── negation (!) ─────────────────────────────────────────────────────────

  describe("negation patterns", () => {
    it("un-ignores a path excluded by a previous pattern (last-match-wins)", () => {
      const p = fromLines(["*.log", "!important.log"]);

      expect(p.isIgnored("debug.log")).toBe(true);
      expect(p.isIgnored("error.log")).toBe(true);
      expect(p.isIgnored("important.log")).toBe(false);
    });

    it("un-ignores a file inside an ignored directory", () => {
      const p = fromLines(["build/", "!build/keep.txt"]);

      expect(p.isIgnored("build/")).toBe(true);
      expect(p.isIgnored("build/keep.txt")).toBe(false);
      expect(p.isIgnored("build/other.txt")).toBe(true);
    });

    it("handles multiple negation layers", () => {
      const p = fromLines(["*.js", "!*.test.js", "*.e2e.test.js"]);

      expect(p.isIgnored("app.js")).toBe(true);
      expect(p.isIgnored("app.test.js")).toBe(false);
      expect(p.isIgnored("app.e2e.test.js")).toBe(true);
    });

    it("skips a bare ! line gracefully", () => {
      const p = fromLines(["!", "*.log"]);

      expect(p.isIgnored("debug.log")).toBe(true);
    });
  });

  // ── path normalization (Windows backslashes) ─────────────────────────────

  describe("path normalization", () => {
    it("normalizes Windows backslash paths", () => {
      const p = fromLines(["node_modules"]);

      expect(p.isIgnored("src\\node_modules\\package.json")).toBe(true);
      expect(p.isIgnored("node_modules\\lodash")).toBe(true);
    });

    it("normalizes backslashes in anchored patterns", () => {
      const p = fromLines(["/dist/"]);

      expect(p.isIgnored("dist\\")).toBe(true);
    });
  });

  // ── real-world ignore files ──────────────────────────────────────────────

  describe("real-world ignore files", () => {
    it("handles a typical Node.js .gitignore", () => {
      const p = fromLines([
        "node_modules",
        "dist",
        ".env",
        "*.log",
        "coverage/",
        ".DS_Store"
      ]);

      expect(p.isIgnored("node_modules/lodash/index.js")).toBe(true);
      expect(p.isIgnored("dist/bundle.js")).toBe(true);
      expect(p.isIgnored(".env")).toBe(true);
      expect(p.isIgnored("npm-debug.log")).toBe(true);
      expect(p.isIgnored("coverage/")).toBe(true);
      expect(p.isIgnored("coverage/lcov.info")).toBe(true);
      expect(p.isIgnored(".DS_Store")).toBe(true);

      // Not ignored
      expect(p.isIgnored("src/index.ts")).toBe(false);
      expect(p.isIgnored("package.json")).toBe(false);
      expect(p.isIgnored("README.md")).toBe(false);
    });

    it("handles patterns with interior slashes", () => {
      const p = fromLines(["docs/*.html", "src/generated/**"]);

      expect(p.isIgnored("docs/index.html")).toBe(true);
      expect(p.isIgnored("some/other/docs/index.html")).toBe(true);
      expect(p.isIgnored("src/generated/types.ts")).toBe(true);
      expect(p.isIgnored("src/generated/a/b/c.ts")).toBe(true);
      expect(p.isIgnored("src/real.ts")).toBe(false);
    });

    it("handles the negation patterns from the plan spec", () => {
      const p = fromLines([
        "*.log",
        "!keep.log",
        "node_modules",
        "dist/"
      ]);

      expect(p.isIgnored("debug.log")).toBe(true);
      expect(p.isIgnored("keep.log")).toBe(false);
      expect(p.isIgnored("node_modules/foo")).toBe(true);
      expect(p.isIgnored("dist/")).toBe(true);
    });
  });

  // ── edge cases ───────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("allows an empty string path", () => {
      const p = fromLines(["node_modules"]);

      expect(p.isIgnored("")).toBe(false);
    });

    it("allows a root-only path .", () => {
      const p = fromLines(["*"]);

      // `*` matches any non-empty string without `/` — `.` fits.
      expect(p.isIgnored(".")).toBe(true);
    });

    it("handles a # in a pattern that is not a comment", () => {
      // Only a # at position 0 (after trim) is a comment.
      const p = fromLines(["file#name.txt"]);

      expect(p.isIgnored("file#name.txt")).toBe(true);
    });

    it("handles a pattern that is just / gracefully", () => {
      const p = fromLines(["/"]);

      // Should not crash; a bare / is degenerate.
      expect(p.isIgnored("anything")).toBe(false);
      expect(p.isIgnored("/")).toBe(false);
    });

    it("trims whitespace from lines", () => {
      const p = fromLines(["  *.tmp  "]);

      expect(p.isIgnored("file.tmp")).toBe(true);
    });

    it("handles the explicit plan spec: node_modules test", () => {
      const p = fromLines(["node_modules"]);

      expect(p.isIgnored("node_modules")).toBe(true);
      expect(p.isIgnored("src/node_modules/foo.ts")).toBe(true);
      expect(p.isIgnored("src/server.ts")).toBe(false);
    });

    it("handles the explicit plan spec: empty allows all", () => {
      const p = fromLines([]);

      expect(p.isIgnored("anything.txt")).toBe(false);
      expect(p.isIgnored("node_modules")).toBe(false);
      expect(p.isIgnored("secret.key")).toBe(false);
    });

    it("handles the explicit plan spec: negation optional skip — negation un-ignores", () => {
      const p = fromLines(["*.tmp", "!keep.tmp"]);

      expect(p.isIgnored("delete.tmp")).toBe(true);
      expect(p.isIgnored("keep.tmp")).toBe(false);
    });
  });
});
