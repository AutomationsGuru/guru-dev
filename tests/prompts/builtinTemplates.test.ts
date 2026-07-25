import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { BUGFIX_SPEC_TEMPLATE_NAME, builtinPromptTemplates } from '../../src/prompts/builtinTemplates.js';
import { discoverPromptTemplates, expandTemplate } from '../../src/prompts/templates.js';

const root = join(tmpdir(), `guru-builtin-tmpl-${process.pid}`);
mkdirSync(root, { recursive: true });

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("builtinPromptTemplates (f144)", () => {
  it("ships a bugfix-spec template with a required bug arg", () => {
    const builtins = builtinPromptTemplates();
    const bugfix = builtins.find((template) => template.name === BUGFIX_SPEC_TEMPLATE_NAME);
    expect(bugfix).toBeDefined();
    expect(bugfix?.source).toBe("builtin");
    expect(bugfix?.args).toHaveLength(1);
    expect(bugfix?.args[0]).toMatchObject({ name: "bug", required: true });
  });

  it("the bugfix-spec body carries every spec section in order", () => {
    const [bugfix] = builtinPromptTemplates();
    const sections = [
      "## Summary",
      "## Reproduction",
      "## Expected vs actual",
      "## Root cause hypothesis",
      "## Scope",
      "## Fix approach",
      "## Acceptance",
      "## Tests",
      "## Rollback"
    ];
    let cursor = -1;
    for (const section of sections) {
      const at = bugfix!.body.indexOf(section);
      expect(at, `missing section ${section}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("built-ins surface through discovery with no filesystem roots", () => {
    const templates = discoverPromptTemplates([join(root, "does-not-exist")]);
    const bugfix = templates.find((template) => template.name === BUGFIX_SPEC_TEMPLATE_NAME);
    expect(bugfix).toBeDefined();
    expect(bugfix?.source).toBe("builtin");
  });

  it("a filesystem template of the same name overrides the built-in", () => {
    writeFileSync(
      join(root, "bugfix-spec.md"),
      `---
name: bugfix-spec
description: Project-local override
args:
  - name: bug
    required: true
---
Custom project bugfix flow for {{bug}}.
`
    );
    const templates = discoverPromptTemplates([root]);
    const matches = templates.filter((template) => template.name === BUGFIX_SPEC_TEMPLATE_NAME);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.description).toBe("Project-local override");
    expect(matches[0]?.body).toContain("Custom project bugfix flow");
  });

  it("ACCEPTANCE: expands /bugfix-spec with the bug bound and reports missing without it", () => {
    const [bugfix] = builtinPromptTemplates();
    const withArg = expandTemplate(bugfix!, ["bug=composer drops keystrokes"]);
    expect(withArg.missing).toEqual([]);
    expect(withArg.text).toContain("Bug: composer drops keystrokes");
    expect(withArg.text).toContain("## Root cause hypothesis");
    expect(withArg.text).toContain("## Rollback");

    const withoutArg = expandTemplate(bugfix!, []);
    expect(withoutArg.missing).toEqual(["bug"]);
  });
});
