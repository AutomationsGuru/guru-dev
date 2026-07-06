import { z } from "zod";

import type { ToolDefinition } from "../tools/registry.js";
import { buildReadinessReport, type ReadinessReportOptions } from "./report.js";
import { ReadinessReportSchema } from "./schemas.js";

const EmptyInputSchema = z.object({}).strict();

/**
 * Folded from integration-tools: exposes the readiness report as a registered tool
 * so it is reachable through the extension host / tool registry, not only inline.
 */
export function createReadinessTools(options: ReadinessReportOptions = {}): readonly ToolDefinition[] {
  const readinessTool: ToolDefinition<typeof EmptyInputSchema, typeof ReadinessReportSchema> = {
    id: "service_readiness_report",
    title: "Service readiness report",
    description: "Report readiness across the runtime, Honcho, and provider-CLI surfaces.",
    inputSchema: EmptyInputSchema,
    outputSchema: ReadinessReportSchema,
    execute: () => buildReadinessReport(options)
  };

  return [readinessTool];
}

export function registerReadinessCommands(): readonly string[] {
  return ["service-readiness-report"];
}
