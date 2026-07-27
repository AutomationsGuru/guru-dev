import { z } from "zod";

export const WorkerStatusSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    state: z.enum(["running", "done", "failed", "blocked", "killed"]),
    failure: z.string().trim().min(1).optional()
  })
  .strict();
export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;

export const AwayDigestOptionsSchema = z
  .object({
    maxBytes: z.number().int().positive().default(4096),
    redactPaths: z.boolean().default(false),
    topFailureCount: z.number().int().nonnegative().default(5)
  })
  .strict();
export type AwayDigestOptions = z.infer<typeof AwayDigestOptionsSchema>;

export const AwayDigestSchema = z
  .object({
    generatedAt: z.string().trim().min(1),
    total: z.number().int().nonnegative(),
    counts: z.object({
      running: z.number().int().nonnegative(),
      done: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      blocked: z.number().int().nonnegative(),
      killed: z.number().int().nonnegative()
    }).strict(),
    topFailures: z.array(
      z.object({
        workerId: z.string().trim().min(1),
        name: z.string().trim().min(1),
        failure: z.string().trim().min(1)
      }).strict()
    ),
    markdown: z.string(),
    truncated: z.boolean()
  })
  .strict();
export type AwayDigest = z.infer<typeof AwayDigestSchema>;
