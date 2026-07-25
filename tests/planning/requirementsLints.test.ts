import {
  lintRequirements,
  REQUIREMENTS_LINT_CODES,
  type RequirementsLintIssue
} from '../../src/planning/requirementsLints.js';

function codes(issues: readonly RequirementsLintIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

describe("lintRequirements", () => {
  it("returns no issues for a clean feature requirements document", () => {
    const text = [
      "# Requirements",
      "",
      "## User Stories",
      "",
      "- As an operator, I want spec packets so that large work is gated.",
      "- As a reviewer, I want phase status so that approval is auditable.",
      "",
      "## Acceptance Criteria",
      "",
      "- Packet creation requires requirements and design paths.",
      "- Implementation is blocked until required phases are approved."
    ].join("\n");

    expect(lintRequirements(text)).toEqual([]);
  });

  it("flags an empty acceptance criteria section", () => {
    const text = [
      "## User Stories",
      "",
      "- As an operator, I want spec packets.",
      "",
      "## Acceptance Criteria",
      ""
    ].join("\n");

    const issues = lintRequirements(text);

    expect(codes(issues)).toContain(REQUIREMENTS_LINT_CODES.emptyAcceptanceCriteria);
    const issue = issues.find((i) => i.code === REQUIREMENTS_LINT_CODES.emptyAcceptanceCriteria);
    expect(issue?.message).toMatch(/acceptance criteria/i);
  });

  it("flags acceptance criteria entries that are blank bullets", () => {
    const text = ["## Acceptance Criteria", "", "- Real criterion.", "-", "-   "].join("\n");

    const issues = lintRequirements(text);

    expect(codes(issues)).toContain(REQUIREMENTS_LINT_CODES.emptyAcceptanceCriterion);
    const blanks = issues.filter((i) => i.code === REQUIREMENTS_LINT_CODES.emptyAcceptanceCriterion);
    expect(blanks.length).toBe(2);
  });

  it("flags a missing acceptance criteria section", () => {
    const text = ["## User Stories", "", "- As an operator, I want spec packets."].join("\n");

    const issues = lintRequirements(text);

    expect(codes(issues)).toContain(REQUIREMENTS_LINT_CODES.missingSection);
    const issue = issues.find((i) => i.code === REQUIREMENTS_LINT_CODES.missingSection);
    expect(issue?.message).toMatch(/acceptance criteria/i);
  });

  it("flags duplicate user stories regardless of case and trailing punctuation", () => {
    const text = [
      "## User Stories",
      "",
      "- As an operator, I want spec packets so that large work is gated.",
      "- As an operator, I want spec packets so that large work is gated",
      "- AS AN OPERATOR, I WANT SPEC PACKETS SO THAT LARGE WORK IS GATED.",
      "- As a reviewer, I want phase status.",
      "",
      "## Acceptance Criteria",
      "",
      "- Packet creation requires requirements and design paths."
    ].join("\n");

    const issues = lintRequirements(text);

    const dups = issues.filter((i) => i.code === REQUIREMENTS_LINT_CODES.duplicateUserStory);
    expect(dups.length).toBe(2);
    expect(dups[0]?.message).toMatch(/duplicate user stor/i);
  });

  it("does not flag stories that merely share a prefix", () => {
    const text = [
      "## User Stories",
      "",
      "- As an operator, I want spec packets.",
      "- As an operator, I want spec packets with design phases.",
      "",
      "## Acceptance Criteria",
      "",
      "- Packet creation requires requirements and design paths."
    ].join("\n");

    expect(lintRequirements(text)).toEqual([]);
  });

  it("flags a bugfix requirements document missing expected behavior", () => {
    const text = [
      "# Bugfix Requirements",
      "",
      "## User Stories",
      "",
      "- As an operator, I want the crash fixed.",
      "",
      "## Acceptance Criteria",
      "",
      "- The crash no longer occurs."
    ].join("\n");

    const issues = lintRequirements(text, { kind: "bugfix" });

    expect(codes(issues)).toContain(REQUIREMENTS_LINT_CODES.missingExpectedBehavior);
  });

  it("auto-detects a bugfix document from its heading and requires expected behavior", () => {
    const text = [
      "# Bug Fix: session resume drops memory",
      "",
      "## User Stories",
      "",
      "- As an operator, I want resume to keep memory.",
      "",
      "## Acceptance Criteria",
      "",
      "- Resume restores memory."
    ].join("\n");

    const issues = lintRequirements(text);

    expect(codes(issues)).toContain(REQUIREMENTS_LINT_CODES.missingExpectedBehavior);
  });

  it("accepts a bugfix document that states expected behavior", () => {
    const text = [
      "# Bugfix Requirements",
      "",
      "## User Stories",
      "",
      "- As an operator, I want the crash fixed.",
      "",
      "## Expected Behavior",
      "",
      "- Resume restores the parked memory snapshot.",
      "",
      "## Acceptance Criteria",
      "",
      "- The crash no longer occurs."
    ].join("\n");

    expect(lintRequirements(text, { kind: "bugfix" })).toEqual([]);
  });

  it("does not require expected behavior for feature documents", () => {
    const text = [
      "# Feature Requirements",
      "",
      "## User Stories",
      "",
      "- As an operator, I want spec packets.",
      "",
      "## Acceptance Criteria",
      "",
      "- Packet creation requires requirements and design paths."
    ].join("\n");

    expect(lintRequirements(text, { kind: "feature" })).toEqual([]);
  });

  it("flags an empty document as missing required sections", () => {
    const issues = lintRequirements("");

    expect(codes(issues)).toContain(REQUIREMENTS_LINT_CODES.missingSection);
  });

  it("is pure: repeated calls over the same text return equal fresh arrays", () => {
    const text = ["## Acceptance Criteria", ""].join("\n");

    const first = lintRequirements(text);
    const second = lintRequirements(text);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});
