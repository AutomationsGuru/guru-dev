import { isAbsolute, normalize, relative, resolve } from "node:path";

import { executeCommand, type CommandExecutor, type CommandExecutionResult } from "../review/gates.js";

import {
  ExecProfileSchema,
  ExecProfileKindSchema,
  type ExecProfile,
  type ExecProfileInput,
  type ExecProfileBackendRef
} from "./execProfileSchema.js";

export { ExecProfileSchema, ExecProfileKindSchema };
export type { ExecProfile, ExecProfileInput, ExecProfileBackendRef };

export interface ExecShellContext {
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ExecShellResult {
  readonly executed: boolean;
  readonly blocked: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export const ISOLATED_BLOCK_MESSAGE =
  "Isolated backend execution requires explicit ATTACH/approval; local fallback is disabled.";

/**
 * Create the default local profile. The harness runs on the host filesystem in the
 * caller-supplied project root unless the operator explicitly switches to an isolated
 * backend with a backendRef.
 */
export function createDefaultProfile(repoRoot: string): ExecProfile {
  return ExecProfileSchema.parse({
    id: "default",
    kind: "local",
    rootPath: resolve(repoRoot)
  });
}

/** Create an isolated profile. The backendRef must be supplied explicitly; no silent defaults. */
export function createIsolatedProfile(
  id: string,
  rootPath: string,
  backendRef: ExecProfileBackendRef
): ExecProfile {
  return ExecProfileSchema.parse({
    id,
    kind: "isolated",
    rootPath: resolve(rootPath),
    backendRef
  });
}

/** Switch execution profile. Returns a new profile; no side effects on the source. */
export function switchProfile(_current: ExecProfile, next: ExecProfileInput): ExecProfile {
  return ExecProfileSchema.parse(next);
}

/**
 * Resolve a path relative to the profile root. Absolute paths are rejected if they
 * escape the root; relative paths are normalized and resolved inside the root.
 */
export function resolvePath(profile: ExecProfile, inputPath: string): { readonly path: string; readonly blocked: boolean; readonly reason?: string } {
  const root = profile.rootPath;
  const normalized = normalize(inputPath).replace(/\\/gu, "/");
  if (isAbsolute(normalized)) {
    return { path: "", blocked: true, reason: "Absolute paths are not allowed; use a path relative to the workspace root." };
  }
  const fullPath = resolve(root, normalized);
  const rel = relative(root, fullPath);
  if (rel.startsWith("..") || rel === "") {
    // ".." escape or empty relative path (root itself) is not a valid target path.
    return { path: "", blocked: true, reason: "Path escapes the workspace root." };
  }
  return { path: fullPath, blocked: false };
}

/**
 * Execute a shell command under the profile. Local profiles run through the supplied
 * executor with cwd anchored to the profile root. Isolated profiles are blocked until
 * an explicit ATTACH adapter is provided (no silent local fallback).
 */
export async function execShell(
  profile: ExecProfile,
  context: ExecShellContext,
  executor: CommandExecutor = executeCommand
): Promise<ExecShellResult> {
  if (profile.kind === "isolated") {
    return {
      executed: false,
      blocked: true,
      exitCode: null,
      stdout: "",
      stderr: ISOLATED_BLOCK_MESSAGE,
      durationMs: 0
    };
  }

  const startedAt = Date.now();
  const cwd = resolve(profile.rootPath, context.cwd ?? ".");
  const rel = relative(profile.rootPath, cwd);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return {
      executed: false,
      blocked: true,
      exitCode: null,
      stdout: "",
      stderr: "Command cwd escapes the workspace root.",
      durationMs: Date.now() - startedAt
    };
  }

  const result: CommandExecutionResult = await executor(context.command, {
    cwd,
    timeoutMs: context.timeoutMs,
    gate: { kind: "validation", name: "execShell", command: context.command, required: true },
    ...(context.signal ? { signal: context.signal } : {})
  });

  return {
    executed: true,
    blocked: false,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs
  };
}
