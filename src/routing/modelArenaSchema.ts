import { z } from "zod";

export const ModelArenaTaskSchema = z.object({
  brief: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({})
});

export type ModelArenaTask = z.infer<typeof ModelArenaTaskSchema>;

export const ModelArenaRouteSchema = z.object({
  alias: z.string().min(1),
  label: z.string().optional()
});

export type ModelArenaRoute = z.infer<typeof ModelArenaRouteSchema>;

export const ModelArenaCheckSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["passfail", "diff", "cost"]).default("passfail")
});

export type ModelArenaCheck = z.infer<typeof ModelArenaCheckSchema>;

export const ModelArenaInputSchema = z.object({
  task: ModelArenaTaskSchema,
  routes: z.array(ModelArenaRouteSchema).min(1, "routes must not be empty"),
  checks: z.array(ModelArenaCheckSchema).default([])
});

export type ModelArenaInput = z.infer<typeof ModelArenaInputSchema>;

export const ModelArenaPlanSchema = z.object({
  task: ModelArenaTaskSchema,
  routes: z.array(ModelArenaRouteSchema),
  checks: z.array(ModelArenaCheckSchema),
  dryRun: z.literal(true)
});

export type ModelArenaPlan = z.infer<typeof ModelArenaPlanSchema>;
