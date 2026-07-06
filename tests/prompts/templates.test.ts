import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { discoverPromptTemplates, expandTemplate, parseTemplate } from "../../src/prompts/templates.js";

const root = join(tmpdir(), `guru-tmpl-${process.pid}`);
mkdirSync(root, { recursive: true });
writeFileSync(
  join(root, "fix-tests.md"),
  `---
name: fix-tests
description: Fix failing tests in a file
args:
  - name: file
    required: true
    description: the test file
  - name: strategy
    default: minimal changes
---
Fix the failing tests in \`{{file}}\`. Strategy: {{strategy}}. Suit: $SUIT.
`
);
writeFileSync(join(root, "no-front.md"), "Just a body with {{1}} positional.");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseTemplate + discovery", () => {
  it("parses frontmatter, arg schema, and body", () => {
    const templates = discoverPromptTemplates([root]);
    const fix = templates.find((template) => template.name === "fix-tests");
    expect(fix).toBeDefined();
    expect(fix?.description).toBe("Fix failing tests in a file");
    expect(fix?.args).toHaveLength(2);
    expect(fix?.args[0]).toMatchObject({ name: "file", required: true });
    expect(fix?.args[1]).toMatchObject({ name: "strategy", default: "minimal changes" });
    expect(fix?.body).toContain("Fix the failing tests");
  });

  it("a file with no frontmatter uses the filename as the name", () => {
    const template = parseTemplate("body only {{1}}", "no-front", "x");
    expect(template.name).toBe("no-front");
    expect(template.args).toEqual([]);
  });
});

describe("expandTemplate", () => {
  it("ACCEPTANCE: substitutes named args + defaults + $SUIT", () => {
    const [fix] = discoverPromptTemplates([root]).filter((template) => template.name === "fix-tests");
    const result = expandTemplate(fix!, ["src/calc.test.ts"], { suit: "finance" });
    expect(result.missing).toEqual([]);
    expect(result.text).toContain("Fix the failing tests in `src/calc.test.ts`");
    expect(result.text).toContain("Strategy: minimal changes"); // default applied
    expect(result.text).toContain("Suit: finance");
  });

  it("reports a missing required arg (blocks send) and applies no substitution for it", () => {
    const [fix] = discoverPromptTemplates([root]).filter((template) => template.name === "fix-tests");
    const result = expandTemplate(fix!, []);
    expect(result.missing).toEqual(["file"]);
  });

  it("named forms (--k=v and k=v) bind by name; positional fills the rest", () => {
    const [fix] = discoverPromptTemplates([root]).filter((template) => template.name === "fix-tests");
    const result = expandTemplate(fix!, ["strategy=aggressive", "src/a.test.ts"]);
    expect(result.text).toContain("src/a.test.ts");
    expect(result.text).toContain("Strategy: aggressive");
  });

  it("positional {{N}}, {{@}}, and $CONTEXT/$TREE expansions", () => {
    const template = parseTemplate("first={{1}} all={{@}} ctx=$CONTEXT tree=$TREE", "t", "x");
    const result = expandTemplate(template, ["a", "b"], { context: "MEM", tree: "src/" });
    expect(result.text).toBe("first=a all=a b ctx=MEM tree=src/");
  });

  it("single-pass: an inserted value that looks like a placeholder is NOT re-expanded", () => {
    const template = parseTemplate("value={{1}} ctx=$CONTEXT", "t", "x");
    // The first arg contains tokens that would be re-matched under chained passes.
    const result = expandTemplate(template, ["$CONTEXT and {{1}}"], { context: "SHOULD-NOT-LEAK" });
    expect(result.text).toBe("value=$CONTEXT and {{1}} ctx=SHOULD-NOT-LEAK");
    expect(result.text).not.toContain("value=SHOULD-NOT-LEAK");
  });
});
