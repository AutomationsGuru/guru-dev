import { describe, expect, it } from "vitest";

import { extractInjects, needsConfirm } from '../../src/skills/recipeShellInjectConfirm.js';

describe("recipeShellInjectConfirm", () => {
  it("returns no inject commands when recipe text has none", () => {
    const recipeText = [
      "Review the staged changes.",
      "",
      "@{docs/review-checklist.md}",
      "",
      "Summarize the findings for {{args}}."
    ].join("\n");

    expect(extractInjects(recipeText)).toEqual([]);
    expect(needsConfirm(recipeText)).toEqual({
      needsConfirm: false,
      commands: []
    });
  });

  it("requires confirm and returns the exact commands for shell inject blocks", () => {
    const recipeText = [
      "Open context first.",
      "!{git diff --staged}",
      "Then inspect recent commits.",
      "!{git log --oneline -5}"
    ].join("\n");

    expect(extractInjects(recipeText)).toEqual(["git diff --staged", "git log --oneline -5"]);
    expect(needsConfirm(recipeText)).toEqual({
      needsConfirm: true,
      commands: ["git diff --staged", "git log --oneline -5"]
    });
  });

  it("adds an args escaped note when a shell inject command includes {{args}}", () => {
    const recipeText = "Investigate target: !{git log --oneline -- {{args}}}";
    const payload = needsConfirm(recipeText);

    expect(payload.needsConfirm).toBe(true);
    expect(payload.commands).toEqual(["git log --oneline -- {{args}}"]);
    expect(payload.note).toContain("{{args}}");
    expect(payload.note).toContain("shell-escaped");
  });
});
