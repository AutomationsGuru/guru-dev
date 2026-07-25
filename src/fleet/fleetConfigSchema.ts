import { z } from "zod";

export const FleetAgentConfigSchema = z
  .object({
    id: z.string().trim().min(1, "fleet agent id is required"),
    role: z.string().trim().min(1).optional(),
    maxConcurrency: z.number().int().nonnegative().optional()
  })
  .strict();
export type FleetAgentConfig = z.infer<typeof FleetAgentConfigSchema>;

export const FleetConfigSchema = z
  .object({
    agents: z.array(FleetAgentConfigSchema).default([])
  })
  .strict();
export type FleetConfig = z.infer<typeof FleetConfigSchema>;
export type FleetConfigInput = z.input<typeof FleetConfigSchema>;

export interface FleetValidationSuccess {
  readonly success: true;
  readonly data: FleetConfig;
}

export interface FleetValidationFailure {
  readonly success: false;
  readonly errors: readonly string[];
}

export type FleetValidationResult = FleetValidationSuccess | FleetValidationFailure;

export function validateFleetConfig(cfg: unknown): FleetValidationResult {
  const parsed = FleetConfigSchema.safeParse(cfg);

  if (parsed.success) {
    return { success: true, data: parsed.data };
  }

  return {
    success: false,
    errors: parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    })
  };
}
