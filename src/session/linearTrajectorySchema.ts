import { z } from "zod";

/** One tool interaction that occurred while producing a model-facing message. */
export const LinearTrajectoryToolSchema = z
  .object({
    name: z.string().trim().min(1),
    input: z.json(),
    output: z.json().optional()
  })
  .strict();
export type LinearTrajectoryTool = z.infer<typeof LinearTrajectoryToolSchema>;

/** A durable, JSON-ready model-facing trajectory record. */
export const LinearTrajectoryMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string(),
    tool: LinearTrajectoryToolSchema.optional()
  })
  .strict();
export type LinearTrajectoryMessage = z.infer<typeof LinearTrajectoryMessageSchema>;

export const LinearTrajectorySchema = z.array(LinearTrajectoryMessageSchema);
export type LinearTrajectory = z.infer<typeof LinearTrajectorySchema>;
