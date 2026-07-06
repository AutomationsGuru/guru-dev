import { z } from "zod";

import { loadHarnessConfig } from "../../config/loadConfig.js";
import { runReviewGates, type CommandExecutor, type ReviewGatesReport } from "../../review/gates.js";
import type { ToolDefinition } from "../registry.js";

const ConfigStatusSchema = z.enum(["loaded", "missing", "invalid"]);
const VerdictSchema = z.enum(["GREEN", "YELLOW", "RED"]);
const GateKindSchema = z.enum(["validation", "review"]);
const GateStatusSchema = z.enum(["passed", "failed"]);

const CommandGateResultSchema = z.object({
  kind: GateKindSchema,
  name: z.string(),
  command: z.array(z.string()),
  required: z.boolean(),
  status: GateStatusSchema,
  exitCode: z.number().nullable(),
  signal: z.string().optional(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number(),
  summary: z.string()
});

const ReviewGatesReportSchema = z.object({
  verdict: VerdictSchema,
  startedAt: z.string(),
  endedAt: z.string(),
  durationMs: z.number(),
  results: z.array(CommandGateResultSchema),
  passed: z.number(),
  failed: z.number(),
  summary: z.string()
});

export const ReviewGatesToolInputSchema = z.object({
  configPath: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  includeReviewGate: z.boolean().default(true)
});

export const ReviewGatesToolOutputSchema = z.object({
  config: z.object({
    status: ConfigStatusSchema,
    verdict: VerdictSchema,
    path: z.string(),
    diagnostics: z.array(z.string())
  }),
  report: ReviewGatesReportSchema
});

export type ReviewGatesToolInput = z.infer<typeof ReviewGatesToolInputSchema>;
export type ReviewGatesToolOutput = z.infer<typeof ReviewGatesToolOutputSchema>;

export function createReviewGatesTool(
  executor?: CommandExecutor
): ToolDefinition<typeof ReviewGatesToolInputSchema, typeof ReviewGatesToolOutputSchema> {
  return {
    id: "review.gates.run",
    title: "Run review gates",
    description: "Run configured validation commands and the configured review gate, returning a GREEN/YELLOW/RED report.",
    inputSchema: ReviewGatesToolInputSchema,
    outputSchema: ReviewGatesToolOutputSchema,
    async execute(input) {
      const configResult = loadHarnessConfig({
        ...(input.configPath ? { configPath: input.configPath } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {})
      });
      const configSummary = {
        status: configResult.status,
        verdict: configResult.verdict,
        path: configResult.path,
        diagnostics: [...configResult.diagnostics]
      };

      if (configResult.verdict === "RED") {
        return {
          config: configSummary,
          report: materializeReport(createConfigFailureReport())
        };
      }

      const report = await runReviewGates(configResult.config, {
        includeReviewGate: input.includeReviewGate,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(executor ? { executor } : {})
      });

      return {
        config: configSummary,
        report: materializeReport(report)
      };
    }
  };
}

function createConfigFailureReport(): ReviewGatesReport {
  const now = new Date().toISOString();

  return {
    verdict: "RED",
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    results: [],
    passed: 0,
    failed: 0,
    summary: "RED: config invalid; review gates were not run."
  };
}

function materializeReport(report: ReviewGatesReport): ReviewGatesToolOutput["report"] {
  return {
    ...report,
    results: report.results.map((result) => ({
      ...result,
      command: [...result.command]
    }))
  };
}
