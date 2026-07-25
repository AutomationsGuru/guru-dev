import { z } from "zod";

/**
 * Trigger types that a skill frontmatter can declare to become
 * conditionally eligible (only inject when the context matches).
 *
 * No triggers on a skill = legacy always-eligible ("always-on").
 */

export const PathGlobTriggerSchema = z
  .object({
    type: z.literal("pathGlob"),
    glob: z.string().trim().min(1)
  })
  .strict();
export type PathGlobTrigger = z.infer<typeof PathGlobTriggerSchema>;

export const KeywordTriggerSchema = z
  .object({
    type: z.literal("keyword"),
    keyword: z.string().trim().min(1)
  })
  .strict();
export type KeywordTrigger = z.infer<typeof KeywordTriggerSchema>;

export const CommandTriggerSchema = z
  .object({
    type: z.literal("command"),
    command: z.string().trim().min(1)
  })
  .strict();
export type CommandTrigger = z.infer<typeof CommandTriggerSchema>;

export const SkillTriggerSchema = z.discriminatedUnion("type", [
  PathGlobTriggerSchema,
  KeywordTriggerSchema,
  CommandTriggerSchema
]);
export type SkillTrigger = z.infer<typeof SkillTriggerSchema>;

export const SkillTriggersArraySchema = z.array(SkillTriggerSchema);
export type SkillTriggersArray = z.infer<typeof SkillTriggersArraySchema>;

/**
 * Context passed by the runtime at injection time.
 * Fields are optional — matching only fires on the fields present.
 */
export const SkillTriggerContextSchema = z
  .object({
    /** Absolute or relative path the operator is currently working on. */
    currentPath: z.string().optional(),
    /** The operator's latest message / prompt text. */
    message: z.string().optional(),
    /** The slash-command or tool name being invoked (e.g. "review", "build"). */
    command: z.string().optional()
  })
  .strict();
export type SkillTriggerContext = z.infer<typeof SkillTriggerContextSchema>;

/**
 * Extract parsed triggers from a skill manifest's frontmatter metadata.
 * The frontmatter key is `triggers` — an array of trigger objects.
 * Returns an empty array when `triggers` is absent or unparseable.
 */
export function parseSkillTriggers(metadata: Record<string, unknown>): SkillTrigger[] {
  const raw = metadata["triggers"];
  if (raw === undefined || raw === null) {
    return [];
  }

  const parsed = SkillTriggersArraySchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }

  return parsed.data;
}
