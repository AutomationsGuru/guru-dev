import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { GURU_HARNESS_CONFIG_FILE_NAME, resolveGuruHomeDirectory } from "../home/paths.js";
import { DEFAULT_HARNESS_CONFIG, HarnessConfigSchema, type HarnessConfig } from "./schema.js";

export type ConfigLoadVerdict = "GREEN" | "YELLOW" | "RED";

export type ConfigLoadStatus = "loaded" | "missing" | "invalid";

export interface ConfigLoadResult {
  readonly status: ConfigLoadStatus;
  readonly verdict: ConfigLoadVerdict;
  readonly source: "explicit" | "workspace" | "project" | "home" | "defaults";
  readonly path: string;
  readonly config: HarnessConfig;
  readonly diagnostics: readonly string[];
}

export interface LoadHarnessConfigOptions {
  readonly configPath?: string;
  readonly cwd?: string;
  /** Home-profile override for tests and portable installations. */
  readonly homeDirectory?: string;
}

export const DEFAULT_CONFIG_FILE_NAME = GURU_HARNESS_CONFIG_FILE_NAME;

export function loadHarnessConfig(options: LoadHarnessConfigOptions = {}): ConfigLoadResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const candidates = resolveConfigCandidates(options, cwd);

  for (const candidate of candidates) {
    if (existsSync(candidate.path)) {
      return loadConfigAt(candidate.path, candidate.source);
    }
  }

  const missingPath = candidates[0]?.path ?? resolveConfigPath(DEFAULT_CONFIG_FILE_NAME, cwd);
  return {
    status: "missing",
    verdict: "YELLOW",
    source: "defaults",
    path: missingPath,
    config: DEFAULT_HARNESS_CONFIG,
    diagnostics: [`Config file not found at ${missingPath}; using safe defaults.`]
  };
}

interface ConfigCandidate {
  readonly path: string;
  readonly source: "explicit" | "workspace" | "project" | "home";
}

function resolveConfigCandidates(options: LoadHarnessConfigOptions, cwd: string): readonly ConfigCandidate[] {
  if (options.configPath) {
    return [{ path: resolveConfigPath(options.configPath, cwd), source: "explicit" }];
  }

  const homeDirectory = resolveGuruHomeDirectory(options.homeDirectory);
  return [
    // Source repositories may deliberately carry a root config; do not let a
    // generated overlay silently supersede the developer's explicit contract.
    { path: resolveConfigPath(DEFAULT_CONFIG_FILE_NAME, cwd), source: "workspace" },
    { path: join(cwd, ".guru", DEFAULT_CONFIG_FILE_NAME), source: "project" },
    { path: join(homeDirectory, DEFAULT_CONFIG_FILE_NAME), source: "home" }
  ];
}

function loadConfigAt(configPath: string, source: ConfigCandidate["source"]): ConfigLoadResult {
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
        source,
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
      source,
      path: configPath,
      config: parsedConfig.data,
      diagnostics: []
    };
  } catch (error) {
    return {
      status: "invalid",
      verdict: "RED",
      source,
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
