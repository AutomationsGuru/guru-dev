import { z } from "zod";

export const LHTMetricsSchema = z.object({
  elapsed: z.number().int().nonnegative(),
  spend: z.number().nonnegative(),
  netSpend: z.number(),
  gates: z.number().int().nonnegative(),
  status: z.enum(['active', 'paused', 'completed']),
  lastUpdate: z.string().datetime(),
});

export type LHTMetrics = z.infer<typeof LHTMetricsSchema>;

export const DonePacketSchema = z.object({
  verdict: z.enum(['PASS', 'FAIL', 'NEEDS_REVIEW']),
  objective: z.string(),
  changedFiles: z.array(z.object({
    path: z.string(),
    summary: z.string(),
  })),
  verification: z.array(z.object({
    command: z.string(),
    passed: z.boolean(),
    result: z.string(),
  })),
  review: z.array(z.object({
    reviewer: z.string(),
    status: z.enum(['approved', 'rejected', 'needs_changes']),
    summary: z.string(),
  })),
  risks: z.array(z.string()),
  nextSteps: z.array(z.string()),
  lht: z.object({
    status: z.enum(['active', 'paused', 'completed']),
    lastUpdate: z.string().datetime(),
    metrics: z.object({
      elapsed: z.number().int().nonnegative(),
      spend: z.number().nonnegative(),
      netSpend: z.number(),
      gates: z.number().int().nonnegative(),
    }),
  }),
  lhtMetrics: LHTMetricsSchema,
  sessionId: z.string().uuid(),
  completedAt: z.string().datetime(),
  duration: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
  tokens: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export type DonePacket = z.infer<typeof DonePacketSchema>;
export type DonePacketInput = z.input<typeof DonePacketSchema>;

export const ToolResultSchema = z.object({
  toolId: z.string(),
  result: z.unknown(),
  error: z.string().optional(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

export const VerdictSchema = z.enum(['PASS', 'FAIL', 'NEEDS_REVIEW']);
export type Verdict = z.infer<typeof VerdictSchema>;
