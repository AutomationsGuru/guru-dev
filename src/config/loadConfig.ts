import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { DEFAULT_HARNESS_CONFIG, HarnessConfigSchema, type HarnessConfig } from "./schema.js";

export type ConfigLoadVerdict = "GREEN" | "YELLOW" | "RED";

export type ConfigLoadStatus = "loaded" | "missing" | "invalid";

export interface ConfigLoadResult {
  readonly status: ConfigLoadStatus;
  readonly verdict: ConfigLoadVerdict;
  readonly path: string;
  readonly config: HarnessConfig;
  readonly diagnostics: readonly string[];
}

export interface LoadHarnessConfigOptions {
  readonly configPath?: string;
  readonly cwd?: string;
}

export const DEFAULT_CONFIG_FILE_NAME = "guruharness.config.json";

export function loadHarnessConfig(options: LoadHarnessConfigOptions = {}): ConfigLoadResult {
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolveConfigPath(options.configPath ?? DEFAULT_CONFIG_FILE_NAME, cwd);

  if (!existsSync(configPath)) {
    return {
      status: "missing",
      verdict: "YELLOW",
      path: configPath,
      config: DEFAULT_HARNESS_CONFIG,
      diagnostics: [`Config file not found at ${configPath}; using safe defaults.`]
    };
  }

  try {
    const rawText = readFileSync(configPath, "utf8");
    // Strip a UTF-8 BOM (the Windows Notepad default) — JSON.parse throws on it,
    // which silently replaced the operator's ENTIRE config with safe defaults.
    const rawConfig = JSON.parse(rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText) as unknown;
    const parsedConfig = HarnessConfigSchema.safeParse(rawConfig);

    if (!parsedConfig.success) {
      return {
        status: "invalid",
        verdict: "RED",
        path: configPath,
        config: DEFAULT_HARNESS_CONFIG,
        diagnostics: parsedConfig.error.issues.map((issue) => {
          const path = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : " at root";

          return `Invalid config${path}: ${issue.message}`;
        })
      };
    }

    return {
      status: "loaded",
      verdict: "GREEN",
      path: configPath,
      config: parsedConfig.data,
      diagnostics: []
    };
  } catch (error) {
    return {
      status: "invalid",
      verdict: "RED",
      path: configPath,
      config: DEFAULT_HARNESS_CONFIG,
      diagnostics: [`Failed to read config at ${configPath}: ${formatError(error)}`]
    };
  }
}

export function resolveConfigPath(configPath: string, cwd: string): string {
  return isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
