import { describe, expect, it } from "vitest";

import { parseModeFile, ProjectModeFileSchema } from '../../src/config/projectModeFile.js';

describe("ProjectModeFileSchema", () => {
  it("accepts a lowercase kebab-case mode id", () => {
    const parsed = ProjectModeFileSchema.parse({ mode: "code-review" });
    expect(parsed.mode).toBe("code-review");
    expect(parsed.description).toBeUndefined();
  });

  it("rejects a non-kebab-case or empty mode id", () => {
    expect(() => ProjectModeFileSchema.parse({ mode: "Code Review" })).toThrow();
    expect(() => ProjectModeFileSchema.parse({ mode: "" })).toThrow();
  });
});

describe("parseModeFile", () => {
  it("parses valid frontmatter and resolves the mode id without executing tools", () => {
    const text = [
      "---",
      "mode: code-review",
      "description: Review-only lane.",
      "---",
      "",
      "# Mode notes",
      "Body is returned but never run."
    ].join("\n");

    const result = parseModeFile(text);

    expect(result).toMatchObject({ ok: true, modeId: "code-review" });
    if (result.ok) {
      expect(result.frontmatter.mode).toBe("code-review");
      expect(result.frontmatter.description).toBe("Review-only lane.");
      expect(result.body).toBe("# Mode notes\nBody is returned but never run.");
    }
  });

  it("accepts frontmatter that has a mode but no description", () => {
    const result = parseModeFile("---\nmode: build\n---\n\nbody");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modeId).toBe("build");
      expect(result.frontmatter.description).toBeUndefined();
    }
  });

  it("strips a single pair of surrounding double quotes around the mode value", () => {
    const result = parseModeFile('---\nmode: "ship"\n---\n');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modeId).toBe("ship");
    }
  });

  it("normalizes CRLF line endings before splitting", () => {
    const text = "---\r\nmode: build\r\ndescription: y\r\n---\r\n\r\nbody\r\n";
    const result = parseModeFile(text);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modeId).toBe("build");
      expect(result.body).toBe("body");
    }
  });

  it("fails when frontmatter is missing entirely", () => {
    const result = parseModeFile("# Just a markdown body\nNo frontmatter here.");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("frontmatter");
    }
  });

  it("fails when the mode field is missing", () => {
    const result = parseModeFile("---\ndescription: no mode here\n---\n");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("mode");
    }
  });

  it("fails when the mode field is present but empty", () => {
    const result = parseModeFile("---\nmode:\n---\n");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("mode");
    }
  });

  it("fails when the mode id is not lowercase kebab-case", () => {
    const result = parseModeFile("---\nmode: Code_Review\n---\n");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Invalid project mode file");
    }
  });

  it("fails when the frontmatter fence never closes", () => {
    const result = parseModeFile("---\nmode: build\nno closing fence");

    expect(result.ok).toBe(false);
  });

  it("does not execute or mutate body content beyond trimming trailing whitespace", () => {
    const body = "```bash\nrm -rf /\n```\n";
    const result = parseModeFile(`---\nmode: build\n---\n\n${body}`);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Body is carried verbatim (trimEnd only); nothing inside it is run.
      expect(result.body).toBe(body.trimEnd());
    }
  });
});
