import { z } from "zod";

/**
 * Supported edit operations. New ops extend this union; parsing fails closed on
 * unknown kinds via the discriminated union so callers cannot half-apply an
 * unrecognized instruction.
 */
export const EditOpKindSchema = z.enum(["search_replace", "whole_file"]);
export type EditOpKind = z.infer<typeof EditOpKindSchema>;

/**
 * A single search/replace edit block. Every block carries an unambiguous id
 * so apply-time diagnostics can name the failing op, and callers must supply at
 * least one old→new block. `search` is matched literally; line endings are
 * normalized to the file's actual terminator before matching.
 */
export const SearchReplaceEditOpSchema = z
  .object({
    kind: z.literal("search_replace"),
    id: z.string().trim().min(1),
    path: z.string().trim().min(1),
    blocks: z
      .array(
        z
          .object({
            search: z.string().min(1),
            replace: z.string()
          })
          .strict()
      )
      .min(1)
  })
  .strict();
export type SearchReplaceEditOp = z.infer<typeof SearchReplaceEditOpSchema>;

/**
 * Whole-file replacement fallback. Used when a higher-level patch parse fails
 * or when the caller explicitly requests the simplest, least-surprising write
 * path. Requires explicit `allowOverwrite=true` before replacing an existing
 * file so accidental gutting is not silent.
 */
export const WholeFileEditOpSchema = z
  .object({
    kind: z.literal("whole_file"),
    id: z.string().trim().min(1),
    path: z.string().trim().min(1),
    contents: z.string(),
    allowOverwrite: z.boolean().default(false)
  })
  .strict();
export type WholeFileEditOp = z.infer<typeof WholeFileEditOpSchema>;

/**
 * Discriminated union of all edit operations. Additional op kinds must add
 * their own literal `kind` field and extend this union; this is the single
 * schema boundary that enforces the "fail closed on unknown" contract.
 */
export const EditOpSchema = z.discriminatedUnion("kind", [
  SearchReplaceEditOpSchema,
  WholeFileEditOpSchema
]);
export type EditOp = z.infer<typeof EditOpSchema>;

/**
 * Structured result for one op. `applied` is true iff the file on disk was
 * modified. `fallback` records whether a whole-file fallback was used, which
 * matters for downstream diagnostics and double-write checks. `diagnostics`
 * always carry block-level detail when an op fails or is skipped.
 */
export const EditOpResultSchema = z
  .object({
    id: z.string(),
    path: z.string(),
    applied: z.boolean(),
    fallback: z.boolean(),
    diagnostics: z.array(z.string())
  })
  .strict();
export type EditOpResult = z.infer<typeof EditOpResultSchema>;

/**
 * Policy that governs how apply behaves when a search block misses or when a
 * path is unrecognized. Defaults are conservative: fail closed on miss.
 */
export const EditApplyPolicySchema = z
  .object({
    /**
     * When true, a search miss downgrades from error to a structured skipped
     * result; the rest of the batch still applies. When false (default), a miss
     * aborts the batch and no file is written.
     */
    skipMisses: z.boolean().default(false),
    /**
     * When true, a search miss that would otherwise abort the batch is replaced
     * by a whole-file write of the first `replace` value across all blocks in
     * the op. This is a deliberate escape hatch, not the default, so callers
     * must opt in.
     */
    wholeFileFallbackOnMiss: z.boolean().default(false)
  })
  .strict();
export type EditApplyPolicy = z.infer<typeof EditApplyPolicySchema>;

export const DEFAULT_EDIT_APPLY_POLICY: EditApplyPolicy = {
  skipMisses: false,
  wholeFileFallbackOnMiss: false
};
