import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseLiteLlmConfigYaml, type ParseLiteLlmConfigOptions } from "./configParser.js";
import type { LiteLlmConfigManifest } from "./schemas.js";

export const DEFAULT_LITELLM_HOST = "127.0.0.1";
export const DEFAULT_LITELLM_PORT = 4000;
export const DEFAULT_LITELLM_CONFIG_PATH = join(homedir(), ".config", "ai-router", "litellm.config.yaml");
export const DEFAULT_LITELLM_HEALTH_ENDPOINT = `http://${DEFAULT_LITELLM_HOST}:${DEFAULT_LITELLM_PORT}/health/liveliness`;

export type RouterHealthStatus = "online" | "offline" | "unknown";

export interface RouterHealthReport {
  readonly endpoint: string;
  readonly status: RouterHealthStatus;
  readonly httpStatus?: number;
  readonly latencyMs?: number;
  readonly error?: string;
}

export interface RouterProcessInfo {
  readonly pid: number;
  readonly command: string;
  readonly source: "process-list";
}

export interface RouterProcessProbe {
  readonly listProcesses: () => Promise<readonly RouterProcessInfo[]> | readonly RouterProcessInfo[];
}

export interface RouterStatusReport {
  readonly configPath: string;
  readonly health: RouterHealthReport;
  readonly processGuess: readonly RouterProcessInfo[];
  readonly aliasCount: number;
  readonly providerGroupCount: number;
  readonly missingEnvVarNames: readonly string[];
  readonly manifest?: LiteLlmConfigManifest;
  readonly diagnostics: readonly string[];
}

export interface RouterStatusOptions extends ParseLiteLlmConfigOptions {
  readonly configPath?: string;
  readonly configText?: string;
  readonly healthEndpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly processProbe?: RouterProcessProbe;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export async function checkRouterHealth(options: { readonly endpoint?: string; readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number } = {}): Promise<RouterHealthReport> {
  const endpoint = options.endpoint ?? DEFAULT_LITELLM_HEALTH_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const startedAt = Date.now();

  if (!fetchImpl) {
    return { endpoint, status: "unknown", error: "fetch is not available in this runtime." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000);

  try {
    const response = await fetchImpl(endpoint, { method: "GET", signal: controller.signal });
    return {
      endpoint,
      status: response.ok ? "online" : "offline",
      httpStatus: response.status,
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      endpoint,
      status: "offline",
      latencyMs: Date.now() - startedAt,
      error: sanitizeErrorMessage(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function createRouterStatusReport(options: RouterStatusOptions = {}): Promise<RouterStatusReport> {
  const configPath = options.configPath ?? DEFAULT_LITELLM_CONFIG_PATH;
  const diagnostics: string[] = [];
  let manifest: LiteLlmConfigManifest | undefined;

  try {
    const configText = options.configText ?? readFileSync(configPath, "utf8");
    manifest = parseLiteLlmConfigYaml(configText, {
      ...(options.expectedAliases ? { expectedAliases: options.expectedAliases } : {}),
      ...(options.expectedProviderGroups ? { expectedProviderGroups: options.expectedProviderGroups } : {})
    });
  } catch (error) {
    diagnostics.push(`LiteLLM config unavailable or invalid: ${sanitizeErrorMessage(error)}`);
  }

  const [health, processGuess] = await Promise.all([
    checkRouterHealth({
      ...(options.healthEndpoint ? { endpoint: options.healthEndpoint } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
    }),
    probeRouterProcesses(options.processProbe)
  ]);

  const requiredEnvNames = manifest ? unique(manifest.aliases.flatMap((alias) => [...alias.credentialEnvVarNames, ...alias.apiBaseEnvVarNames])).sort() : [];
  const missingEnvVarNames = requiredEnvNames.filter((name) => !hasEnvName(options.env ?? process.env, name));

  return {
    configPath,
    health,
    processGuess,
    aliasCount: manifest?.aliases.length ?? 0,
    providerGroupCount: manifest?.providerGroups.length ?? 0,
    missingEnvVarNames,
    ...(manifest ? { manifest } : {}),
    diagnostics
  };
}

async function probeRouterProcesses(probe: RouterProcessProbe | undefined): Promise<readonly RouterProcessInfo[]> {
  if (!probe) {
    return [];
  }

  const processes = await probe.listProcesses();
  return processes.filter((processInfo) => /litellm|ai-router|proxy_server/iu.test(processInfo.command));
}

function hasEnvName(env: NodeJS.ProcessEnv, name: string): boolean {
  return typeof env[name] === "string" && (env[name]?.length ?? 0) > 0;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/giu, "Bearer [redacted]")
    .replace(/(api[_-]?key|authorization|token|secret)(\s*[:=]\s*)[^\s,;}]+/giu, "$1$2[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/gu, "sk-[redacted]");
}
