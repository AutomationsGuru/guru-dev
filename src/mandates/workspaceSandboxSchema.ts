import { isAbsolute } from "node:path";

import { z } from "zod";

/**
 * The default workspace confinement policy. The caller supplies the project or
 * worktree root; elevated network and outside-root access stay off until an
 * explicit policy opts into them.
 */
export const WorkspaceSandboxPolicySchema = z
  .object({
    writeRoot: z
      .string()
      .trim()
      .min(1)
      .refine((value) => isAbsolute(value), "writeRoot must be an absolute path."),
    allowNetwork: z.boolean().default(false),
    allowOutsideRoot: z.boolean().default(false)
  })
  .strict();

export type WorkspaceSandboxPolicy = z.infer<typeof WorkspaceSandboxPolicySchema>;
export type WorkspaceSandboxPolicyInput = z.input<typeof WorkspaceSandboxPolicySchema>;

export const WorkspaceSandboxOperationSchema = z
  .object({
    kind: z.enum(["write", "network", "shell"]),
    /** Required for a write because an unclassified target fails closed. */
    path: z.string().trim().min(1).optional(),
    /**
     * Compatibility seam for IDEA-F61 auto-approve classes. This module keeps
     * the value opaque so F61 remains its single owner.
     */
    approvalClass: z.string().trim().min(1).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "write" && value.path === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["path"], message: "write operations require a target path." });
    }
  });

export type WorkspaceSandboxOperation = z.infer<typeof WorkspaceSandboxOperationSchema>;
export type WorkspaceSandboxOperationInput = z.input<typeof WorkspaceSandboxOperationSchema>;

export const WorkspaceSandboxPathClassSchema = z.enum(["inside", "outside"]);
export type WorkspaceSandboxPathClass = z.infer<typeof WorkspaceSandboxPathClassSchema>;

export const WorkspaceSandboxOutcomeSchema = z.enum(["allow", "deny", "escalate"]);
export type WorkspaceSandboxOutcome = z.infer<typeof WorkspaceSandboxOutcomeSchema>;
