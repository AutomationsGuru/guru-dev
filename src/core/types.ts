import { z } from "zod";

export const VerdictSchema = z.enum(["GREEN", "YELLOW", "RED"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const ToolResultStatusSchema = z.enum(["success", "warning", "error"]);
export type ToolResultStatus = z.infer<typeof ToolResultStatusSchema>;

export const ArtifactKindSchema = z.enum(["file", "command", "url", "id", "other"]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactSchema = z
  .object({
    kind: ArtifactKindSchema.default("other"),
    label: z.string().trim().min(1),
    value: z.string().trim().min(1)
  })
  .strict();
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ToolResultSchema = z
  .object({
    status: ToolResultStatusSchema,
    summary: z.string().trim().min(1),
    artifacts: z.array(ArtifactSchema).default([]),
    nextActions: z.array(z.string().trim().min(1)).default([])
  })
  .strict();
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const ChangedFileSchema = z
  .object({
    path: z.string().trim().min(1),
    summary: z.string().trim().min(1)
  })
  .strict();
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const VerificationEvidenceSchema = z
  .object({
    command: z.string().trim().min(1),
    result: z.string().trim().min(1),
    passed: z.boolean()
  })
  .strict();
export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;

export const ReviewStatusSchema = z.enum(["passed", "blocked", "not_run"]);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const ReviewEvidenceSchema = z
  .object({
    reviewer: z.string().trim().min(1),
    status: ReviewStatusSchema,
    summary: z.string().trim().min(1)
  })
  .strict();
export type ReviewEvidence = z.infer<typeof ReviewEvidenceSchema>;

export const TaskContextSchema = z
  .object({
    objective: z.string().trim().min(1),
    repoRoot: z.string().trim().min(1).optional(),
    branch: z.string().trim().min(1).optional(),
    planPath: z.string().trim().min(1).optional()
  })
  .strict();
export type TaskContext = z.infer<typeof TaskContextSchema>;

export const DonePacketSchema = z
  .object({
    verdict: VerdictSchema,
    objective: z.string().trim().min(1),
    changedFiles: z.array(ChangedFileSchema),
    verification: z.array(VerificationEvidenceSchema),
    review: z.array(ReviewEvidenceSchema),
    risks: z.array(z.string().trim().min(1)).default([]),
    nextSteps: z.array(z.string().trim().min(1)).default([])
  })
  .strict();
export type DonePacket = z.infer<typeof DonePacketSchema>;
export type DonePacketInput = z.input<typeof DonePacketSchema>;
