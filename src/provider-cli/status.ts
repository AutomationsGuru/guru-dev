import { existsSync } from "node:fs";

import { commandExists } from "../review/gates.js";
import { ProviderCliConfigSchema, type ProviderCliConfig, type ProviderCliId, type ProviderCliStatusReport } from "./schemas.js";

export const DEFAULT_PROVIDER_CLI_CONFIGS: readonly ProviderCliConfig[] = [
  { id: "codex", commandName: "codex.cmd", statusArgs: ["--version"], policy: "explicit-run-allowed" },
  { id: "claude", commandName: "claude", statusArgs: ["--version"], policy: "explicit-run-allowed" },
  { id: "agy", commandName: "agy", statusArgs: ["--version"], policy: "explicit-run-allowed" },
  { id: "opencode", commandName: "opencode", statusArgs: ["--version"], policy: "explicit-run-allowed" },
  { id: "grok", commandName: "grok", statusArgs: ["--version"], policy: "explicit-run-allowed" },
  { id: "mavis", commandName: "mavis", statusArgs: ["--version"], policy: "explicit-run-allowed" },
  { id: "minimax", commandName: "minimax", statusArgs: ["--version"], policy: "explicit-run-allowed" },
  { id: "gcloud", commandName: "gcloud", statusArgs: ["--version"], policy: "status-only" },
  { id: "gsutil", commandName: "gsutil", statusArgs: ["--version"], policy: "status-only" },
  { id: "bq", commandName: "bq", statusArgs: ["--version"], policy: "status-only" },
  { id: "cursor", commandName: "cursor", statusArgs: ["--version"], policy: "explicit-run-allowed" },
  { id: "honcho-admin", commandName: "honcho", statusArgs: ["--version"], policy: "status-only" }
].map((config) => ProviderCliConfigSchema.parse(config));

export interface ProviderCliStatusExecutor {
  readonly commandExists: (commandName: string) => boolean;
  readonly version: (config: ProviderCliConfig) => Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }>;
}

export interface ProviderCliStatusOptions {
  readonly configs?: readonly ProviderCliConfig[];
  readonly env?: NodeJS.ProcessEnv;
  readonly executor?: ProviderCliStatusExecutor;
}

export async function getProviderCliStatus(id: ProviderCliId, options: ProviderCliStatusOptions = {}): Promise<ProviderCliStatusReport> {
  const configs = options.configs ?? DEFAULT_PROVIDER_CLI_CONFIGS;
  const config = configs.find((candidate) => candidate.id === id);
  if (!config) return { id, status: "error", commandName: id, missingEnvNames: [], summary: `${id} provider CLI is not configured.` };
  const env = options.env ?? process.env;
  const missingEnvNames = config.requiredEnvNames.filter((name) => !env[name]);
  if (missingEnvNames.length > 0) return { id, status: "missing-env", commandName: config.commandName, missingEnvNames, summary: `${id} is missing required environment variable name(s).` };
  const executor = options.executor ?? defaultStatusExecutor;
  if (!executor.commandExists(config.commandName)) return { id, status: "missing-command", commandName: config.commandName, missingEnvNames: [], summary: `${config.commandName} was not found.` };
  const result = await executor.version(config);
  if (result.exitCode !== 0) return { id, status: "error", commandName: config.commandName, missingEnvNames: [], summary: result.stderr || `${id} version probe failed.` };
  return { id, status: "ready", commandName: config.commandName, version: firstLine(result.stdout), missingEnvNames: [], summary: `${id} provider CLI is ready.` };
}

export async function getProviderCliStatusMatrix(options: ProviderCliStatusOptions = {}): Promise<readonly ProviderCliStatusReport[]> {
  const configs = options.configs ?? DEFAULT_PROVIDER_CLI_CONFIGS;
  return await Promise.all(configs.map((config) => getProviderCliStatus(config.id, options)));
}

const defaultStatusExecutor: ProviderCliStatusExecutor = {
  commandExists(commandName) {
    // A path-qualified command: check the file exists. A bare command name: probe
    // PATH (review 2026-07-08). The old code returned `true` for EVERY bare name,
    // so `missing-command` was unreachable and a missing CLI showed as a confusing
    // "version probe failed" error instead of the clean "X was not found."
    if (commandName.includes("/") || commandName.includes("\\")) {
      return existsSync(commandName);
    }
    return commandExists(commandName);
  },
  async version(config) {
    const { executeCommand } = await import("../review/gates.js");
    // Forward the config's timeoutMs so a wedged CLI can't hang the status matrix
    // forever (review 2026-07-08): the old call passed no timeoutMs, so a CLI that
    // blocks (license prompt, network call, stuck drive) hung Promise.all with no
    // escape. config.timeoutMs defaults to 30000 (schemas.ts).
    return await executeCommand(
      [config.commandName, ...config.statusArgs],
      {
        gate: { kind: "validation", name: `provider-cli:${config.id}`, command: [config.commandName, ...config.statusArgs], required: false },
        timeoutMs: config.timeoutMs
      }
    );
  }
};

function firstLine(value: string): string | undefined {
  return value.trim().split(/\r?\n/u).find(Boolean);
}
