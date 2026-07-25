import { filterPaths } from '../../src/git/workspaceGitignorePathlist.js';

describe("filterPaths", () => {
  it("should return all paths when there are no rules", () => {
    expect(filterPaths(["src/index.ts", "dist/out.js"], [])).toEqual(["src/index.ts", "dist/out.js"]);
  });

  it("should return an empty list when there are no paths", () => {
    expect(filterPaths([], ["*.log"])).toEqual([]);
  });

  it("should ignore blank lines and comments in rules", () => {
    const rules = ["# build output", "", "   ", "*.log"];

    expect(filterPaths(["app.log", "src/index.ts"], rules)).toEqual(["src/index.ts"]);
  });

  it("should exclude paths matched by a simple extension rule at any depth", () => {
    const paths = ["app.log", "src/debug.log", "src/index.ts", "docs/notes.md"];

    expect(filterPaths(paths, ["*.log"])).toEqual(["src/index.ts", "docs/notes.md"]);
  });

  it("should match basename rules against any path segment", () => {
    const paths = ["foo", "src/foo", "src/bar/foo.ts", "food.ts"];

    expect(filterPaths(paths, ["foo"])).toEqual(["src/bar/foo.ts", "food.ts"]);
  });

  it("should honor negation rules that re-include a matching path", () => {
    const rules = ["*.log", "!important.log"];
    const paths = ["app.log", "important.log", "src/important.log", "src/index.ts"];

    expect(filterPaths(paths, rules)).toEqual(["important.log", "src/important.log", "src/index.ts"]);
  });

  it("should apply the last matching rule in order", () => {
    const paths = ["a.tmp", "b.tmp"];

    expect(filterPaths(paths, ["*.tmp", "!a.tmp"])).toEqual(["a.tmp"]);
    expect(filterPaths(paths, ["!a.tmp", "*.tmp"])).toEqual([]);
  });

  it("should anchor leading-slash rules to the root", () => {
    const paths = ["foo", "src/foo", "foo/bar.txt"];

    expect(filterPaths(paths, ["/foo"])).toEqual(["src/foo"]);
  });

  it("should match slash-containing rules relative to the root only", () => {
    const paths = ["src/foo.ts", "lib/src/foo.ts", "src/nested/foo.ts"];

    expect(filterPaths(paths, ["src/foo.ts"])).toEqual(["lib/src/foo.ts", "src/nested/foo.ts"]);
  });

  it("should exclude directory contents for trailing-slash rules", () => {
    const rules = ["node_modules/", "dist/"];
    const paths = [
      "node_modules/pkg/index.js",
      "src/node_modules/pkg/index.js",
      "dist/out.js",
      "src/dist/bundle.js",
      "src/index.ts",
      "distribution/list.txt"
    ];

    expect(filterPaths(paths, rules)).toEqual(["src/index.ts", "distribution/list.txt"]);
  });

  it("should not match a file path for a directory-only rule", () => {
    const paths = ["build", "build/out.js"];

    // "build" is a file here (no trailing slash) so "build/" does not match
    // it, but "build/out.js" has the directory prefix "build" which does match
    // and excludes everything beneath it — same as git's filesystem walk.
    expect(filterPaths(paths, ["build/"])).toEqual(["build"]);
  });

  it("should exclude a directory path itself for a directory-only rule", () => {
    const paths = ["build/", "build/out.js", "src/build.sh"];

    expect(filterPaths(paths, ["build/"])).toEqual(["src/build.sh"]);
  });

  it("should support single-character wildcards", () => {
    const paths = ["file1.txt", "file2.txt", "file10.txt", "file.txt"];

    expect(filterPaths(paths, ["file?.txt"])).toEqual(["file10.txt", "file.txt"]);
  });

  it("should support double-star rules spanning nested directories", () => {
    const rules = ["src/**/*.tmp"];
    const paths = ["src/a.tmp", "src/deep/nested/a.tmp", "lib/a.tmp", "src/keep.ts"];

    expect(filterPaths(paths, rules)).toEqual(["lib/a.tmp", "src/keep.ts"]);
  });

  it("should match leading double-star rules at any depth", () => {
    const paths = ["foo/bar.ts", "a/b/foo/bar.ts", "foo/other.ts"];

    expect(filterPaths(paths, ["**/foo/bar.ts"])).toEqual(["foo/other.ts"]);
  });

  it("should match double-star directory rules against everything beneath", () => {
    const paths = ["logs/a.txt", "logs/deep/b.txt", "src/logs/c.txt", "src/index.ts"];

    expect(filterPaths(paths, ["logs/**"])).toEqual(["src/logs/c.txt", "src/index.ts"]);
  });

  it("should not re-include a file when its parent directory is excluded", () => {
    const rules = ["node_modules/", "!node_modules/keep.js"];
    const paths = ["node_modules/keep.js", "node_modules/other.js", "src/keep.js"];

    expect(filterPaths(paths, rules)).toEqual(["src/keep.js"]);
  });

  it("should re-include a subdirectory when only its entries were excluded", () => {
    const rules = ["node_modules/*", "!node_modules/keep/"];
    const paths = ["node_modules/keep/index.js", "node_modules/drop/index.js", "src/index.ts"];

    expect(filterPaths(paths, rules)).toEqual(["node_modules/keep/index.js", "src/index.ts"]);
  });

  it("should normalize windows separators and leading slashes in paths", () => {
    const paths = ["src\\logs\\a.log", "/src/index.ts"];

    expect(filterPaths(paths, ["*.log"])).toEqual(["/src/index.ts"]);
  });
});
