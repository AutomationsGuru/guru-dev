import { z } from "zod";

/**
 * Mission Packet Schema
 * Validates mission packets containing goals, budget, and stop conditions.
 */

export const BudgetSchema = z.object({
  maxTokens: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
  maxIterations: z.number().int().positive().optional(),
});

export const StopConditionSchema = z.object({
  type: z.enum(["maxTokens", "maxCost", "maxIterations", "manual", "error"]),
  threshold: z.number().optional(),
  message: z.string().optional(),
});

export const MissionPacketSchema = z.object({
  goals: z.array(z.string().min(1)).min(1, "At least one goal is required"),
  budget: BudgetSchema.optional(),
  stopConditions: z.array(StopConditionSchema).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type MissionPacket = z.infer<typeof MissionPacketSchema>;
export type Budget = z.infer<typeof BudgetSchema>;
export type StopCondition = z.infer<typeof StopConditionSchema>;

/**
 * Validates a mission packet.
 * Throws ZodError if validation fails.
 */
export function validate(mission: unknown): MissionPacket {
  return MissionPacketSchema.parse(mission);
}

/**
 * Safe validation that returns a result object instead of throwing.
 */
export function validateSafe(mission: unknown):
  | { success: true; data: MissionPacket }
  | { success: false; error: z.ZodError } {
  const result = MissionPacketSchema.safeParse(mission);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
