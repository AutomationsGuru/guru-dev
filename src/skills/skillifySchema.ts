import { z } from "zod";

/**
 * Input message in a session segment. Roles use harness terminology: operator
 * (the human), assistant, system, or tool observations.
 */
export const SkillifySegmentMessageSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    role: z.enum(["system", "operator", "assistant", "tool"]),
    content: z.string().min(1),
    toolCalls: z
      .array(
        z
          .object({
            toolId: z.string().trim().min(1),
            input: z.string().min(1),
            output: z.string().min(1)
          })
          .strict()
      )
      .optional()
  })
  .strict();
export type SkillifySegmentMessage = z.infer<typeof SkillifySegmentMessageSchema>;

/**
 * Operator-gated capture of a session segment into a skill/garage artifact.
 *
 * Defaults to stage-only (`approve: false`). A final skill directory is only
 * written when the operator explicitly approves AND names a target skill root.
 * This enforces the self-build gate: a segment never auto-publishes as a skill.
 */
export const SkillifySegmentInputSchema = z
  .object({
    title: z.string().trim().min(1),
    provenance: z.enum(["observed", "built", "manual"]).default("observed"),
    messages: z.array(SkillifySegmentMessageSchema).min(1),
    /** Optional source note persisted in the skill frontmatter (session id, turn range, message ids, etc.). */
    source: z.string().trim().min(1).optional(),
    /** Directory for the draft when approve is false. */
    stageDirectory: z.string().trim().min(1).optional(),
    /** Final skill root; required when approve is true. */
    targetSkillDirectory: z.string().trim().min(1).optional(),
    /** Operator approval gate. False (default) = stage only. True = write to targetSkillDirectory. */
    approve: z.boolean().default(false)
  })
  .strict();
export type SkillifySegmentInput = z.infer<typeof SkillifySegmentInputSchema>;

export const SkillifySegmentResultSchema = z
  .object({
    ok: z.boolean(),
    approved: z.boolean(),
    skillId: z.string().trim().min(1).optional(),
    stagedPath: z.string().trim().min(1).optional(),
    skillPath: z.string().trim().min(1).optional(),
    error: z.string().trim().min(1).optional()
  })
  .strict();
export type SkillifySegmentResult = z.infer<typeof SkillifySegmentResultSchema>;
