import { z } from "zod";

import {
  DEFAULT_PROVIDER_CLI_CONFIGS,
  getProviderCliStatus,
  getProviderCliStatusMatrix,
  type ProviderCliStatusOptions
} from "../../provider-cli/status.js";
import {
  ProviderCliIdSchema,
  ProviderCliRunRequestSchema,
  ProviderCliRunResultSchema,
  ProviderCliStatusReportSchema,
  type ProviderCliConfig,
  type ProviderCliRunRequest,
  type ProviderCliRunResult
} from "../../provider-cli/schemas.js";
import type { ToolDefinition } from "../registry.js";

/**
 * Agent-facing provider-CLI tools — wrap the readiness matrix + a dry-run-first
 * delegated run contract. Status is read-only; real runs require policy
 * `explicit-run-allowed`, dryRun=false, and userApproved=true.
 */

const StatusInputSchema = z
  .object({
    /** When set, probe one CLI; omit to return the full matrix. */
    id: ProviderCliIdSchema.optional()
  })
  .strict();

const StatusOutputSchema = z
  .object({
    reports: z.array(ProviderCliStatusReportSchema),
    summary: z.string()
  })
  .strict();

export type ProviderCliToolsOptions = ProviderCliStatusOptions & {
  /** Override the real-run executor (tests). */
  readonly runExecutor?: (
    config: ProviderCliConfig,
    request: ProviderCliRunRequest
  ) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
};

function summarizeReports(reports: readonly z.infer<typeof ProviderCliStatusReportSchema>[]): string {
  const ready = reports.filter((r) => r.status === "ready").length;
  const missing = reports.filter((r) => r.status === "missing-command" || r.status === "missing-env").length;
  const errors = reports.filter((r) => r.status === "error" || r.status === "disabled" || r.status === "not-implemented").length;
  return `${reports.length} provider CLI(s): ${ready} ready, ${missing} missing, ${errors} other.`;
}

function buildArgv(config: ProviderCliConfig, request: ProviderCliRunRequest): string[] {
  // Conservative argv shape — never shell-interpolate the prompt. CLIs that need
  // different shapes (stdin, flags) can grow adapters later; dry-run surfaces the plan.
  const argv = [config.commandName];
  if (request.model) {
    argv.push("--model", request.model);
  }
  argv.push(request.prompt);
  return argv;
}

async function defaultRun(
  config: ProviderCliConfig,
  request: ProviderCliRunRequest
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const { executeCommand } = await import("../../review/gates.js");
  const argv = buildArgv(config, request);
  const result = await executeCommand(argv, {
    gate: {
      kind: "validation",
      name: `provider-cli-run:${config.id}`,
      command: argv,
      required: false
    },
    ...(request.cwd ? { cwd: request.cwd } : {}),
    timeoutMs: request.timeoutMs
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

function redact(text: string, enabled: boolean): string {
  if (!enabled) {
    return text;
  }
  // Cheap value-shape scrub — never log full secrets if a CLI echoes tokens.
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}\b/giu, "Bearer [REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/gu, "[REDACTED_JWT]");
}

export function createProviderCliStatusTool(
  options: ProviderCliToolsOptions = {}
): ToolDefinition<typeof StatusInputSchema, typeof StatusOutputSchema> {
  return {
    id: "provider_cli_status",
    title: "Provider CLI Status",
    description:
      "Probe installed provider CLIs (codex, claude, grok, cursor, gcloud, …) for PATH presence, version, and required env NAME readiness. Omit id for the full matrix.",
    inputSchema: StatusInputSchema,
    outputSchema: StatusOutputSchema,
    async execute(input) {
      if (input.id) {
        const report = await getProviderCliStatus(input.id, options);
        return { reports: [report], summary: report.summary };
      }
      const reports = await getProviderCliStatusMatrix(options);
      return { reports: [...reports], summary: summarizeReports(reports) };
    }
  };
}

export function createProviderCliRunTool(
  options: ProviderCliToolsOptions = {}
): ToolDefinition<typeof ProviderCliRunRequestSchema, typeof ProviderCliRunResultSchema> {
  return {
    id: "provider_cli_run",
    title: "Provider CLI Run",
    description:
      "Delegate a prompt to an installed provider CLI. Default is dry-run (returns planned argv). Live runs require policy explicit-run-allowed, dryRun=false, and userApproved=true.",
    inputSchema: ProviderCliRunRequestSchema,
    outputSchema: ProviderCliRunResultSchema,
    async execute(input): Promise<ProviderCliRunResult> {
      const configs = options.configs ?? DEFAULT_PROVIDER_CLI_CONFIGS;
      const config = configs.find((c) => c.id === input.id);
      if (!config) {
        return {
          id: input.id,
          status: "blocked",
          redacted: true,
          summary: `${input.id} is not in the provider CLI inventory.`
        };
      }

      if (config.policy === "blocked") {
        return {
          id: input.id,
          status: "blocked",
          redacted: true,
          summary: `${input.id} is blocked by policy.`
        };
      }

      const argv = buildArgv(config, input);
      if (input.dryRun || config.policy === "status-only") {
        const reason =
          config.policy === "status-only"
            ? "status-only policy — live run not permitted"
            : "dry-run (set dryRun=false and userApproved=true to execute)";
        return {
          id: input.id,
          status: "dry-run",
          redacted: true,
          summary: `${reason}. Planned: ${argv.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`
        };
      }

      if (!input.userApproved) {
        return {
          id: input.id,
          status: "blocked",
          redacted: true,
          summary: "Live provider CLI run requires userApproved=true (and dryRun=false)."
        };
      }

      // Presence + env before spawn.
      const status = await getProviderCliStatus(input.id, options);
      if (status.status !== "ready") {
        return {
          id: input.id,
          status: "blocked",
          redacted: true,
          summary: `Cannot run: ${status.summary}`
        };
      }

      const runner = options.runExecutor ?? defaultRun;
      try {
        const result = await runner(config, input);
        const stdout = redact(result.stdout, input.redactOutput);
        const stderr = redact(result.stderr, input.redactOutput);
        const ok = result.exitCode === 0;
        return {
          id: input.id,
          status: ok ? "succeeded" : "failed",
          exitCode: result.exitCode ?? undefined,
          stdout,
          stderr,
          redacted: input.redactOutput,
          summary: ok
            ? `${input.id} exited 0.`
            : `${input.id} exited ${result.exitCode ?? "null"}${stderr ? `: ${stderr.slice(0, 200)}` : "."}`
        };
      } catch (error) {
        return {
          id: input.id,
          status: "failed",
          redacted: true,
          summary: error instanceof Error ? error.message : String(error)
        };
      }
    }
  };
}

export function createProviderCliTools(options: ProviderCliToolsOptions = {}): readonly ToolDefinition[] {
  return [createProviderCliStatusTool(options), createProviderCliRunTool(options)];
}
