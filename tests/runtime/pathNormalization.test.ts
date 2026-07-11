import { normalizeKnownPathFields, normalizeMsysPath } from "../../src/runtime/pathNormalization.js";

describe("pathNormalization", () => {
  it("should normalize MSYS absolute paths", () => {
    expect(normalizeMsysPath("/c")).toBe("C:/");
    expect(normalizeMsysPath("/c/Users/Example/project")).toBe("C:/Users/Example/project");
    expect(normalizeMsysPath("relative/path")).toBe("relative/path");
  });

  it("should normalize only known path fields inside arbitrary tool input", () => {
    const normalized = normalizeKnownPathFields({
      cwd: "/c/Users/Example/project",
      repoRoot: "/d/work/repo",
      body: "keep /c/Users/Example/project as literal content",
      nested: {
        targetPath: "/e/target/path",
        message: "do not rewrite /f/message"
      }
    });

    expect(normalized).toEqual({
      cwd: "C:/Users/Example/project",
      repoRoot: "D:/work/repo",
      body: "keep /c/Users/Example/project as literal content",
      nested: {
        targetPath: "E:/target/path",
        message: "do not rewrite /f/message"
      }
    });
  });
});
