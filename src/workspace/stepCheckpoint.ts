import { z } from "zod";

const StepCheckpointPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((path) => !path.includes("\0"), "Checkpoint paths cannot contain NUL bytes.");

export const StepCheckpointSnapshotSchema = z
  .object({
    path: StepCheckpointPathSchema,
    /** `null` means the path did not exist before the mutating step. */
    content: z.string().nullable()
  })
  .strict();

export const StepCheckpointSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    snapshots: z.array(StepCheckpointSnapshotSchema).min(1).max(1_000)
  })
  .strict()
  .superRefine((checkpoint, context) => {
    const seen = new Set<string>();
    for (const [index, snapshot] of checkpoint.snapshots.entries()) {
      if (seen.has(snapshot.path)) {
        context.addIssue({
          code: "custom",
          path: ["snapshots", index, "path"],
          message: `Checkpoint path is duplicated: ${snapshot.path}`
        });
      }
      seen.add(snapshot.path);
    }
  });

export type StepCheckpointSnapshot = z.infer<typeof StepCheckpointSnapshotSchema>;
export type StepCheckpoint = z.infer<typeof StepCheckpointSchema>;

export interface StepCheckpointRestore {
  readonly checkpoint: StepCheckpoint;
  readonly snapshots: readonly StepCheckpointSnapshot[];
}
