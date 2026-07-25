import { z } from "zod";

export const ExpansionNeedSchema = z
  .object({
    paths: z.array(z.string().trim().min(1)).default([]),
    network: z.boolean().default(false),
    reason: z.string().trim().min(1),
    source: z.enum(["denial-signal", "proactive-classifier"]).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.paths.length === 0 && !value.network) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expansion requests must include at least one path or network access.",
        path: ["paths"]
      });
    }
  });
export type ExpansionNeed = z.infer<typeof ExpansionNeedSchema>;

export const ExpansionDecisionSchema = z.enum(["approve", "deny"]);
export type ExpansionDecision = z.infer<typeof ExpansionDecisionSchema>;

export const SandboxDenialSignalSchema = z
  .object({
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    error: z.string().optional(),
    requestedPaths: z.array(z.string().trim().min(1)).optional(),
    requestedNetwork: z.boolean().optional()
  })
  .strict();
export type SandboxDenialSignal = z.infer<typeof SandboxDenialSignalSchema>;

export const SandboxExpansionHintSchema = z
  .object({
    paths: z.array(z.string().trim().min(1)).optional(),
    network: z.boolean().optional(),
    reason: z.string().trim().min(1)
  })
  .strict();
export type SandboxExpansionHint = z.infer<typeof SandboxExpansionHintSchema>;
