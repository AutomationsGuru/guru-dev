import {
  parseFrontMatter,
  type SteeringDoc
} from '../../src/context/steeringInclusionSchema.js';
import { resolveSteering } from '../../src/context/steeringInclusion.js';

function makeDoc(overrides: Partial<SteeringDoc> & Pick<SteeringDoc, "id" | "mode">): SteeringDoc {
  const content = overrides.content ?? `# ${overrides.id}\n\nBody for ${overrides.id}.\n`;
  const body = overrides.body ?? `Body for ${overrides.id}.\n`;
  const { content: _ignored, body: _ignoredBody, ...rest } = overrides;
  return {
    content,
    body,
    ...rest
  } as SteeringDoc;
}

describe("parseFrontMatter", () => {
  it("extracts scalar and array keys from a `--- ... ---` block", () => {
    const content = [
      "---",
      "id: coding-style",
      "description: Coding style rules for TypeScript files.",
      "fileMatch: [\"src/**/*.ts\"]",
      "mode: fileMatch",
      "---",
      "",
      "# Coding style",
      "",
      "Use single quotes for strings."
    ].join("\n");

    const parsed = parseFrontMatter(content);

    expect(parsed.frontmatter).toEqual({
      id: "coding-style",
      description: "Coding style rules for TypeScript files.",
      fileMatch: ["src/**/*.ts"],
      mode: "fileMatch"
    });
    expect(parsed.body).toBe("\n# Coding style\n\nUse single quotes for strings.");
  });

  it("returns empty front-matter and the full content as body when opener is missing", () => {
    const content = "# No front-matter\n\nJust body content.\n";
    const parsed = parseFrontMatter(content);

    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe(content);
  });

  it("returns empty front-matter and the full content as body when closer is missing", () => {
    const content = "---\nid: open-ended\ndescription: No closer here.\n\nBody content.\n";
    const parsed = parseFrontMatter(content);

    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe(content);
  });
});

describe("resolveSteering — mode: always", () => {
  it("always selects a doc regardless of context", () => {
    const doc = makeDoc({ id: "global", mode: "always" });

    const result = resolveSteering([doc], { manualRefs: [] });

    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]).toMatchObject({ id: "global", mode: "always", reason: "always-on" });
  });
});

describe("resolveSteering — mode: fileMatch", () => {
  const doc = makeDoc({
    id: "ts-style",
    mode: "fileMatch",
    fileMatch: ["src/**/*.ts"]
  });

  it("selects the doc when activePath matches a glob", () => {
    const result = resolveSteering([doc], { activePath: "src/foo/bar.ts" });

    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]).toMatchObject({
      id: "ts-style",
      mode: "fileMatch",
      reason: "file-match:src/**/*.ts"
    });
  });

  it("does not select the doc when activePath does not match", () => {
    const result = resolveSteering([doc], { activePath: "README.md" });

    expect(result.selected).toEqual([]);
  });

  it("does not select the doc when activePath is not provided", () => {
    const result = resolveSteering([doc], {});

    expect(result.selected).toEqual([]);
  });
});

describe("resolveSteering — mode: manual", () => {
  const doc = makeDoc({ id: "guide", mode: "manual" });

  it("selects the doc when manualRefs includes its id", () => {
    const result = resolveSteering([doc], { manualRefs: ["guide"] });

    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]).toMatchObject({ id: "guide", mode: "manual", reason: "manual" });
  });

  it("does not select the doc when manualRefs does not include its id", () => {
    const result = resolveSteering([doc], { manualRefs: ["other"] });

    expect(result.selected).toEqual([]);
  });

  it("does not select any manual docs when manualRefs is empty", () => {
    const result = resolveSteering([doc], { manualRefs: [] });

    expect(result.selected).toEqual([]);
  });
});

describe("resolveSteering — mode: auto", () => {
  const doc = makeDoc({
    id: "migrations",
    mode: "auto",
    description: "Database migration patterns"
  });

  it("selects the doc when the user query mentions a description keyword", () => {
    const result = resolveSteering([doc], { userQuery: "Help me write a database migration" });

    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]).toMatchObject({
      id: "migrations",
      mode: "auto",
      reason: expect.stringMatching(/^auto:.+/)
    });
    expect(result.selected[0]?.reason).toBe("auto:migration");
  });

  it("does not select the doc when the user query has no keyword overlap", () => {
    const result = resolveSteering([doc], { userQuery: "Make a sandwich" });

    expect(result.selected).toEqual([]);
  });

  it("does not select the doc when no user query is provided", () => {
    const result = resolveSteering([doc], {});

    expect(result.selected).toEqual([]);
  });
});

describe("resolveSteering — front-matter parsing integration", () => {
  it("builds a doc from raw content with front-matter and resolves its mode", () => {
    const raw = [
      "---",
      "id: extracted",
      "description: Front-matter extraction sample.",
      "fileMatch: [\"src/**/*.ts\"]",
      "mode: fileMatch",
      "---",
      "",
      "# Extracted body"
    ].join("\n");

    const parsed = parseFrontMatter(raw);
    const doc: SteeringDoc = {
      id: String(parsed.frontmatter["id"] ?? ""),
      content: raw,
      body: parsed.body,
      description: typeof parsed.frontmatter["description"] === "string"
        ? (parsed.frontmatter["description"] as string)
        : undefined,
      fileMatch: Array.isArray(parsed.frontmatter["fileMatch"])
        ? (parsed.frontmatter["fileMatch"] as string[])
        : undefined,
      mode: parsed.frontmatter["mode"] === "always"
        || parsed.frontmatter["mode"] === "fileMatch"
        || parsed.frontmatter["mode"] === "manual"
        || parsed.frontmatter["mode"] === "auto"
        ? parsed.frontmatter["mode"]
        : "manual"
    };

    expect(doc.id).toBe("extracted");
    expect(doc.description).toBe("Front-matter extraction sample.");
    expect(doc.fileMatch).toEqual(["src/**/*.ts"]);
    expect(doc.mode).toBe("fileMatch");
    expect(doc.body).toBe("\n# Extracted body");

    const result = resolveSteering([doc], { activePath: "src/foo.ts" });
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]).toMatchObject({ id: "extracted", mode: "fileMatch" });
  });

  it("returns empty fields when front-matter is missing and treats content as body", () => {
    const raw = "# Just body\n\nNo front-matter here.\n";
    const parsed = parseFrontMatter(raw);

    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe(raw);
  });
});