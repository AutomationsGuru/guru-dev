import { z } from 'zod';

export const execPolicyRuleSchema = z.object({
  pattern: z.string().min(1, 'Pattern must not be empty'),
  action: z.enum(['allow', 'deny', 'ask']),
  description: z.string().optional(),
});

export const execPolicyConfigSchema = z.object({
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  rules: z.array(execPolicyRuleSchema).optional().default([]),
});

export type ExecPolicyRule = z.infer<typeof execPolicyRuleSchema>;
export type ExecPolicyConfig = z.infer<typeof execPolicyConfigSchema>;