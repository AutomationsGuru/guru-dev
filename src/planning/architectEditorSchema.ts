import { z } from "zod";

/**
 * Architect → editor two-phase pipeline schemas (IDEA-F16).
 *
 * The pipeline is OPTIONAL and default-off. When enabled, an architect model
 * produces a natural-language change proposal; an editor model then emits a
 * structured edit list. The pipeline never auto-applies edits; it returns the
 * validated ops for downstream mandate/approval gates.
 */

/** Path string with traversal and NUL guards, reused from planMode.ts conventions. */
export const AffectedPathSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.includes("\0"), {
    message: "Affected paths must not contain NUL characters."
  })
  .refine((value) => !/(^|[\\/])\.\.([\\/]|$)/.test(value), {
    message: "Affected paths must not contain path traversal segments."
  });

export const ArchitectStepSchema = z
  .object({
    order: z.number().int().positive(),
    description: z.string().trim().min(1).max(4_000),
    affectedPaths: z.array(AffectedPathSchema).default([])
  })
  .strict();
export type ArchitectStep = z.infer<typeof ArchitectStepSchema>;

export const ArchitectProposalSchema = z
  .object({
    objective: z.string().trim().min(1).max(4_000),
    reasoning: z.string().trim().min(1).max(20_000),
    steps: z.array(ArchitectStepSchema).min(1).max(50),
    affectedPaths: z.array(AffectedPathSchema).default([]),
    validation: z.array(z.string().trim().min(1)).default([]),
    unresolvedQuestions: z.array(z.string().trim().min(1)).default([])
  })
  .strict()
  .superRefine((proposal, context) => {
    stepsMustBeSequential(proposal.steps, context);
    if (proposal.affectedPaths.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["affectedPaths"],
        message: "At least one affected path is required."
      });
    }
  });
export type ArchitectProposal = z.infer<typeof ArchitectProposalSchema>;

export const SearchReplaceEditSchema = z
  .object({
    kind: z.literal("search-replace"),
    path: AffectedPathSchema,
    search: z.string().min(1),
    replace: z.string()
  })
  .strict();
export type SearchReplaceEdit = z.infer<typeof SearchReplaceEditSchema>;

export const FullContentEditSchema = z
  .object({
    kind: z.literal("full-content"),
    path: AffectedPathSchema,
    content: z.string()
  })
  .strict();
export type FullContentEdit = z.infer<typeof FullContentEditSchema>;

export const EditorEditSchema = z.discriminatedUnion("kind", [SearchReplaceEditSchema, FullContentEditSchema]);
export type EditorEdit = z.infer<typeof EditorEditSchema>;

export const EditorEditListSchema = z
  .object({
    edits: z.array(EditorEditSchema).min(1).max(100)
  })
  .strict();
export type EditorEditList = z.infer<typeof EditorEditListSchema>;

export const ArchitectEditorFailureReasonSchema = z.enum([
  "invalid-proposal",
  "invalid-edits",
  "architect-threw",
  "editor-threw"
]);
export type ArchitectEditorFailureReason = z.infer<typeof ArchitectEditorFailureReasonSchema>;

export const ArchitectEditorResultSchema = z
  .object({
    enabled: z.boolean(),
    proposal: ArchitectProposalSchema.nullable(),
    edits: z.array(EditorEditSchema),
    reviewRequired: z.boolean().default(false),
    failureReason: ArchitectEditorFailureReasonSchema.optional(),
    error: z.string().trim().min(1).optional()
  })
  .strict();
export type ArchitectEditorResult = z.infer<typeof ArchitectEditorResultSchema>;

function stepsMustBeSequential(steps: readonly ArchitectStep[], context: z.RefinementCtx): void {
  steps.forEach((step, index) => {
    if (step.order !== index + 1) {
      context.addIssue({
        code: "custom",
        path: ["steps", index, "order"],
        message: "Step order must match its one-based position."
      });
    }
  });
}
