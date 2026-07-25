import {
  BugfixSpecInputSchema,
  createBugfixSpec,
  renderBugfixMarkdown
} from '../../src/planning/bugfixSpecTemplate.js';

describe("BugfixSpecInputSchema", () => {
  it("requires non-empty title, current, and expected sections", () => {
    const ok = BugfixSpecInputSchema.safeParse({
      title: "Crash on empty input",
      current: "Throws TypeError when arg is undefined.",
      expected: "Returns an empty result without throwing."
    });
    expect(ok.success).toBe(true);
  });

  it("rejects empty title / current / expected", () => {
    expect(
      BugfixSpecInputSchema.safeParse({
        title: "  ",
        current: "x",
        expected: "y"
      }).success
    ).toBe(false);
    expect(
      BugfixSpecInputSchema.safeParse({
        title: "t",
        current: "",
        expected: "y"
      }).success
    ).toBe(false);
    expect(
      BugfixSpecInputSchema.safeParse({
        title: "t",
        current: "x",
        expected: ""
      }).success
    ).toBe(false);
  });

  it("treats unchanged and rootDir as optional", () => {
    const parsed = BugfixSpecInputSchema.parse({
      title: "t",
      current: "c",
      expected: "e",
      unchanged: "u"
    });
    expect(parsed.unchanged).toBe("u");
    expect(parsed.rootDir).toBeUndefined();
  });
});

describe("createBugfixSpec", () => {
  it("produces a SpecPacket with kind=bugfix and bugfix.md", () => {
    const packet = createBugfixSpec({
      title: "Crash on empty input",
      current: "Throws TypeError when arg is undefined.",
      expected: "Returns an empty result without throwing.",
      unchanged: "Logging path is unaffected."
    });

    expect(packet.kind).toBe("bugfix");
    expect(packet.title).toBe("Crash on empty input");
    expect(packet.files).toHaveProperty("bugfix.md");
    expect(packet.files).toHaveProperty("design.md");
    expect(packet.files).toHaveProperty("tasks.md");
  });

  it("bugfix.md contains current / expected / unchanged sections", () => {
    const { files } = createBugfixSpec({
      title: "Off-by-one in pager",
      current: "Index starts at 1; should start at 0.",
      expected: "Index starts at 0.",
      unchanged: "Header rendering."
    });
    const md = files["bugfix.md"] ?? "";

    expect(md).toContain("# Current Behavior");
    expect(md).toContain("Index starts at 1; should start at 0.");
    expect(md).toContain("# Expected Behavior");
    expect(md).toContain("Index starts at 0.");
    expect(md).toContain("# Unchanged Behavior");
    expect(md).toContain("Header rendering.");
  });

  it("asserts required sections are present in bugfix.md", () => {
    const { files } = createBugfixSpec({
      title: "t",
      current: "c-body",
      expected: "e-body",
      unchanged: "u-body"
    });
    const requiredSections = ["# Current Behavior", "# Expected Behavior", "# Unchanged Behavior"];
    for (const section of requiredSections) {
      expect(files["bugfix.md"]).toContain(section);
    }
  });

  it("omits the unchanged section body when none is supplied but keeps the heading", () => {
    const { files } = createBugfixSpec({
      title: "t",
      current: "c",
      expected: "e"
    });
    const md = files["bugfix.md"] ?? "";
    expect(md).toContain("# Unchanged Behavior");
    expect(md).toContain("_None recorded._");
  });

  it("design.md and tasks.md are non-empty skeletons", () => {
    const { files } = createBugfixSpec({
      title: "Crash",
      current: "c",
      expected: "e"
    });
    expect((files["design.md"] ?? "").trim().length).toBeGreaterThan(0);
    expect((files["tasks.md"] ?? "").trim().length).toBeGreaterThan(0);
    expect(files["tasks.md"]).toContain("- [ ]");
  });

  it("throws on invalid input (preserving the validation contract)", () => {
    expect(() =>
      createBugfixSpec({ title: "", current: "c", expected: "e" })
    ).toThrow();
  });
});

describe("renderBugfixMarkdown", () => {
  it("renders the three required sections in canonical order", () => {
    const md = renderBugfixMarkdown({
      title: "t",
      current: "c",
      expected: "e",
      unchanged: "u"
    });
    const currentIdx = md.indexOf("# Current Behavior");
    const expectedIdx = md.indexOf("# Expected Behavior");
    const unchangedIdx = md.indexOf("# Unchanged Behavior");
    expect(currentIdx).toBeGreaterThan(-1);
    expect(expectedIdx).toBeGreaterThan(currentIdx);
    expect(unchangedIdx).toBeGreaterThan(expectedIdx);
  });
});
