import { z } from "zod";

/**
 * IDEA-F7-STEP-CTX-01 — per-step context pack (R-PD-STEP-CTX).
 *
 * Multi-step plan runs inject only the files declared relevant to the
 * *current* step, plus the always-on hard context set (AGENTS chain +
 * mandates). These schemas are the typed contract between the plan
 * descriptor and the pack builder in `./stepContextPack.ts`.
 *
 * Scope: pure descriptors — no filesystem reads here. The builder resolves
 * which always-on paths exist; the schema only shapes the data.
 */

const RelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(value), {
    message: "path must be relative to the repository root."
  })
  .refine((value) => !value.split(/[\\/]+/u).includes(".."), {
    message: "path must not contain '..' segments."
  });

/** One step of a multi-step plan, with the files it declares relevant. */
export const StepContextStepSchema = z
  .object({
    id: z.string().trim().min(1),
    relevantPaths: z.array(RelativePathSchema).default([]),
    notes: z.string().trim().min(1).optional()
  })
  .strict();
export type StepContextStep = z.infer<typeof StepContextStepSchema>;

/** A plan as an ordered list of context-bearing steps. */
export const StepContextPlanSchema = z
  .object({
    steps: z.array(StepContextStepSchema).min(1)
  })
  .strict();
export type StepContextPlan = z.infer<typeof StepContextPlanSchema>;

/**
 * The inject pack for one active step: the step's own relevant files plus
 * the always-on hard context set. `stepFiles` never contains another step's
 * declared files; `alwaysOnFiles` is present in every pack regardless of
 * which step is active.
 */
export const StepContextPackSchema = z
  .object({
    stepId: z.string().trim().min(1),
    stepFiles: z.array(RelativePathSchema),
    alwaysOnFiles: z.array(RelativePathSchema),
    notes: z.string().trim().min(1).optional()
  })
  .strict();
export type StepContextPack = z.infer<typeof StepContextPackSchema>;
