import type { PromptTemplate } from "./templates.js";

/**
 * Built-in prompt templates (idea-f144-bugfix-spec-template).
 *
 * Ships a small set of Guru-native templates so users get a structured
 * `/bugfix-spec` flow without authoring a template file. Filesystem
 * templates (project `.guru/agent/prompts`, then user-level) override
 * built-ins by name — see `discoverPromptTemplates`.
 */

export const BUGFIX_SPEC_TEMPLATE_NAME = "bugfix-spec";

const BUGFIX_SPEC_BODY = `Write a bugfix spec for the following bug.

Bug: {{bug}}

Produce the spec with exactly these sections, in this order:

## Summary
One paragraph: what is broken and who/what it affects.

## Reproduction
Numbered, minimal steps to reproduce from a clean state. Include the exact
commands or interactions and the observed output.

## Expected vs actual
- **Expected:** what should happen.
- **Actual:** what happens instead (quote the error, log line, or behavior).

## Root cause hypothesis
The most likely cause, with the file/function/symbol implicated and the
evidence that points there. If unknown, say so and list the cheapest
diagnostic step that would discriminate between candidates.

## Scope
- **In scope:** the smallest correct change that fixes the bug.
- **Out of scope:** related-but-separate issues explicitly left unchanged.

## Fix approach
The proposed change, named files, and why this is the smallest correct fix.

## Acceptance
Testable conditions that prove the fix: the failing case now passes, plus
the regression checks that must stay green.

## Tests
The new or updated tests (file + case) that lock the fix in.

## Rollback
How to revert safely if the fix causes regressions.`;

const builtinBugfixSpec: PromptTemplate = {
  name: BUGFIX_SPEC_TEMPLATE_NAME,
  description: "Structured bugfix spec: summary, repro, root cause, scope, acceptance, tests, rollback.",
  args: [
    {
      name: "bug",
      required: true,
      description: "Short description of the bug (symptom, where seen)."
    }
  ],
  body: BUGFIX_SPEC_BODY,
  source: "builtin"
};

/** Built-in prompt templates, lowest precedence (overridden by filesystem). */
export function builtinPromptTemplates(): readonly PromptTemplate[] {
  return [builtinBugfixSpec];
}
