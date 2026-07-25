// Work ID: IDEA-F160-COMPLETION-GATE-01
// Completion gate loop: a task may mark complete only after a set of pure
// predicates pass. Model self-report alone never completes.

import { z } from "zod";

export const CompletionGateKindSchema = z.enum(["files-exist", "command-exit-zero", "operator-approved"]);
export type CompletionGateKind = z.infer<typeof CompletionGateKindSchema>;

export const FilesExistGateParamsSchema = z
  .object({
    paths: z.array(z.string().trim().min(1)).min(1)
  })
  .strict();
export type FilesExistGateParams = z.infer<typeof FilesExistGateParamsSchema>;

export const CommandExitZeroGateParamsSchema = z
  .object({
    command: z.string().trim().min(1)
  })
  .strict();
export type CommandExitZeroGateParams = z.infer<typeof CommandExitZeroGateParamsSchema>;

export const OperatorApprovedGateParamsSchema = z.object({}).strict();
export type OperatorApprovedGateParams = z.infer<typeof OperatorApprovedGateParamsSchema>;

export const CompletionGateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: z.string().trim().min(1),
      kind: z.literal("files-exist"),
      params: FilesExistGateParamsSchema
    })
    .strict(),
  z
    .object({
      id: z.string().trim().min(1),
      kind: z.literal("command-exit-zero"),
      params: CommandExitZeroGateParamsSchema
    })
    .strict(),
  z
    .object({
      id: z.string().trim().min(1),
      kind: z.literal("operator-approved"),
      params: OperatorApprovedGateParamsSchema
    })
    .strict()
]);
export type CompletionGate = z.infer<typeof CompletionGateSchema>;

export const CompletionGateFailureSchema = z
  .object({
    id: z.string(),
    kind: CompletionGateKindSchema,
    reason: z.string()
  })
  .strict();
export type CompletionGateFailure = z.infer<typeof CompletionGateFailureSchema>;

export const CompletionGateEvaluationSchema = z
  .object({
    passed: z.array(z.string()),
    failed: z.array(CompletionGateFailureSchema)
  })
  .strict();
export type CompletionGateEvaluation = z.infer<typeof CompletionGateEvaluationSchema>;

export const CompletionAttemptResultSchema = z
  .object({
    completed: z.boolean(),
    modelReportedDone: z.boolean(),
    evaluation: CompletionGateEvaluationSchema
  })
  .strict();
export type CompletionAttemptResult = z.infer<typeof CompletionAttemptResultSchema>;
