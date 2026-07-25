import { z } from "zod";

/**
 * Skill from experience (IDEA-F176-SKILL-FROM-XP): draft a SKILL.md body from a
 * titled procedure so the garage flywheel can capture reusable know-how without
 * auto-promoting it. Compose with F164 skill promotion stages — the returned
 * meta always marks `stage: "draft"`; promotion is a separate step.
 *
 * Pure: deterministic, no I/O. Validation via zod.
 */

export const DraftSkillInputSchema = z
  .object({
    title: z.string().trim().min(1),
    when: z.string().trim().min(1),
    steps: z.array(z.string().trim().min(1)).min(1)
  })
  .strict();

export type DraftSkillInput = z.infer<typeof DraftSkillInputSchema>;

export interface DraftSkillMeta {
  readonly title: string;
  readonly when: string;
  readonly steps: readonly string[];
  readonly stage: "draft"; // NEVER promoted here
  readonly stepCount: number;
  readonly source: "experience";
  readonly name: string; // slug from title
}

export interface DraftSkillResult {
  readonly markdown: string;
  readonly meta: DraftSkillMeta;
}

/** Derive a stable skill id slug from a title. */
export function skillNameFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug.length > 0 ? slug : "skill";
}

function renderSkillMarkdown(
  name: string,
  title: string,
  when: string,
  steps: readonly string[]
): string {
  const numbered = steps.map((step, i) => `${i + 1}. ${step}`).join("\n");
  return [
    "---",
    `name: ${name}`,
    `description: ${when}`,
    "---",
    "",
    `# ${title}`,
    "",
    "## When to use",
    when,
    "",
    "## Steps",
    numbered,
    ""
  ].join("\n");
}

/**
 * Draft a SKILL.md body + meta from an experience success path.
 * Pure: no I/O, no auto-promote, no install. Stage is always "draft".
 * Throws ZodError (or Error) when title/when empty or steps empty/blank.
 */
export function draftSkill(input: DraftSkillInput): DraftSkillResult {
  const parsed = DraftSkillInputSchema.parse(input);
  const name = skillNameFromTitle(parsed.title);
  const meta: DraftSkillMeta = {
    title: parsed.title,
    when: parsed.when,
    steps: [...parsed.steps],
    stage: "draft",
    stepCount: parsed.steps.length,
    source: "experience",
    name
  };
  return {
    markdown: renderSkillMarkdown(name, meta.title, meta.when, meta.steps),
    meta
  };
}
