/**
 * Bugfix spec template — SpecPacket kind=bugfix.
 *
 * Part of the spec-work-packet family (see ideation/kiro-cli: K3
 * "Bugfix vs feature spec templates"). A bugfix spec captures a defect as
 * three required sections — current behavior, expected behavior, and
 * unchanged behavior — so a fix can be designed and tasked against an
 * explicit contract rather than a vague description.
 *
 * This template is intentionally self-contained and framework-free: it
 * produces an in-memory packet of named Markdown files. It composes with the
 * broader SpecPacket triple (requirements/design/tasks) by replacing the
 * requirements artifact with a `bugfix.md` and reusing design/tasks
 * skeletons. The `kind: "bugfix"` discriminator lets a future feature-spec
 * template share the same packet shape without editing this module.
 */

import { z } from "zod";

/** Canonical heading for each required bugfix section. */
export const BUGFIX_SECTION_HEADINGS = {
  current: "# Current Behavior",
  expected: "# Expected Behavior",
  unchanged: "# Unchanged Behavior"
} as const;

/** Ordered list of required section headings, used for assertion helpers. */
export const REQUIRED_BUGFIX_SECTIONS: readonly string[] = [
  BUGFIX_SECTION_HEADINGS.current,
  BUGFIX_SECTION_HEADINGS.expected,
  BUGFIX_SECTION_HEADINGS.unchanged
] as const;

/**
 * Input for a bugfix spec. `current` and `expected` are mandatory and must be
 * non-empty; `unchanged` is optional (the section heading is always emitted
 * so reviewers have an explicit place to record scope boundaries).
 */
export const BugfixSpecInputSchema = z
  .object({
    title: z.string().trim().min(1),
    current: z.string().trim().min(1),
    expected: z.string().trim().min(1),
    unchanged: z.string().trim().optional(),
    rootDir: z.string().trim().min(1).optional()
  })
  .strict();
export type BugfixSpecInput = z.infer<typeof BugfixSpecInputSchema>;

/** Discriminated packet kind — leaves room for a future `feature` variant. */
export type SpecPacketKind = "bugfix";

/** A named-Markdown-file spec packet. */
export interface SpecPacket {
  readonly kind: SpecPacketKind;
  readonly title: string;
  readonly files: Readonly<Record<string, string>>;
}

/**
 * Render the bugfix.md body. Sections appear in canonical order:
 * Current → Expected → Unchanged. When `unchanged` is absent the heading is
 * still emitted with an explicit `_None recorded._` placeholder so the
 * section is never silently dropped.
 */
export function renderBugfixMarkdown(input: BugfixSpecInput): string {
  const unchangedBody = input.unchanged && input.unchanged.length > 0
    ? input.unchanged
    : "_None recorded._";

  return [
    `# Bugfix: ${input.title}`,
    "",
    BUGFIX_SECTION_HEADINGS.current,
    "",
    input.current,
    "",
    BUGFIX_SECTION_HEADINGS.expected,
    "",
    input.expected,
    "",
    BUGFIX_SECTION_HEADINGS.unchanged,
    "",
    unchangedBody,
    ""
  ].join("\n");
}

/** Render a minimal design.md skeleton anchored on the bugfix contract. */
function renderDesignSkeleton(input: BugfixSpecInput): string {
  return [
    `# Design — ${input.title}`,
    "",
    "## Root Cause",
    "",
    "_Describe the cause of the current behavior._",
    "",
    "## Approach",
    "",
    "_Describe the fix and why it satisfies the expected behavior without",
    "regressing the unchanged behavior._",
    ""
  ].join("\n");
}

/** Render a minimal tasks.md skeleton with a first checked-wave placeholder. */
function renderTasksSkeleton(input: BugfixSpecInput): string {
  return [
    `# Tasks — ${input.title}`,
    "",
    "## Wave 1",
    "",
    "- [ ] Implement the fix.",
    "- [ ] Add a regression test that reproduces the current behavior.",
    "- [ ] Verify the unchanged behavior still holds.",
    ""
  ].join("\n");
}

/**
 * Assert that every required bugfix section heading is present in the rendered
 * bugfix.md. Throws if any section is missing — used as the post-render
 * invariant for `createBugfixSpec`.
 */
export function assertRequiredBugfixSections(bugfixMarkdown: string): void {
  const missing = REQUIRED_BUGFIX_SECTIONS.filter(
    (heading) => !bugfixMarkdown.includes(heading)
  );
  if (missing.length > 0) {
    throw new Error(
      `bugfixSpecTemplate: missing required section(s): ${missing.join(", ")}`
    );
  }
}

/**
 * Build a SpecPacket kind=bugfix from validated input. Always emits three
 * files: `bugfix.md` (current/expected/unchanged), `design.md`, and
 * `tasks.md`. Throws if input fails validation or any required section is
 * missing from the rendered bugfix.md.
 */
export function createBugfixSpec(rawInput: unknown): SpecPacket {
  const input = BugfixSpecInputSchema.parse(rawInput);
  const bugfixMd = renderBugfixMarkdown(input);
  assertRequiredBugfixSections(bugfixMd);

  return {
    kind: "bugfix",
    title: input.title,
    files: {
      "bugfix.md": bugfixMd,
      "design.md": renderDesignSkeleton(input),
      "tasks.md": renderTasksSkeleton(input)
    }
  };
}
