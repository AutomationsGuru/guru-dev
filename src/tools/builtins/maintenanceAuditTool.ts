import { z } from "zod";

import { runMaintenanceAudit } from "../../maintenance/audit.js";
import type { ToolDefinition } from "../registry.js";

const MaintenanceAuditVerdictSchema = z.enum(["GREEN", "YELLOW", "RED"]);
const MaintenanceCheckStatusSchema = z.enum(["passed", "warning", "failed"]);

const MaintenanceCheckSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: MaintenanceCheckStatusSchema,
  summary: z.string(),
  evidence: z.array(z.string())
});

export const MaintenanceAuditToolInputSchema = z.object({
  repoRoot: z.string().trim().min(1).optional(),
  targetPath: z.string().trim().min(1).optional(),
  configPath: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional()
});

export const MaintenanceAuditToolOutputSchema = z.object({
  verdict: MaintenanceAuditVerdictSchema,
  startedAt: z.string(),
  endedAt: z.string(),
  durationMs: z.number(),
  checks: z.array(MaintenanceCheckSchema),
  summary: z.string()
});

export type MaintenanceAuditToolInput = z.infer<typeof MaintenanceAuditToolInputSchema>;
export type MaintenanceAuditToolOutput = z.infer<typeof MaintenanceAuditToolOutputSchema>;

export function createMaintenanceAuditTool(): ToolDefinition<
  typeof MaintenanceAuditToolInputSchema,
  typeof MaintenanceAuditToolOutputSchema
> {
  return {
    id: "maintenance.audit.run",
    title: "Run maintenance audit",
    description: "Audit repo context, config, validation gates, review gates, approval policy, self-build progress, and docs surfaces.",
    inputSchema: MaintenanceAuditToolInputSchema,
    outputSchema: MaintenanceAuditToolOutputSchema,
    execute(input) {
      const report = runMaintenanceAudit({
        ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
        ...(input.targetPath ? { targetPath: input.targetPath } : {}),
        ...(input.configPath ? { configPath: input.configPath } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {})
      });

      return {
        ...report,
        checks: report.checks.map((check) => ({
          ...check,
          evidence: [...check.evidence]
        }))
      };
    }
  };
}
