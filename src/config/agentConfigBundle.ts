import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  AGENT_CONFIG_BUNDLE_VERSION,
  AgentConfigBundleSchema,
  DEFAULT_AGENT_CONFIG_BUNDLE,
  type AgentConfigBundle
} from "./agentConfigBundleSchema.js";

export { DEFAULT_AGENT_CONFIG_BUNDLE };

/**
 * Agent config bundle load / validate / export (IDEA-F91, R-CD-CONFIG).
 *
 * The bundle is the versionable, secrets-free project contract at
 * `<project>/.guru/agent-config.json`. This module owns three concerns:
 *
 * 1. {@link loadAgentConfigBundle} — locate, read, and validate the bundle
 *    (missing file is OK: the operator has not adopted the bundle yet).
 * 2. {@link saveAgentConfigBundle} — write a validated bundle back to disk.
 * 3. {@link rejectEmbeddedSecrets} — a structural scan that refuses to load or
 *    save any bundle whose raw text contains an embedded secret VALUE, so the
 *    rule "no secrets in the file" is enforced in code, not just in prose
 *    (Foundational Law 3 / prompt-rule drift closure).
 *
 * The schema in {@link ./agentConfigBundleSchema.ts} already forces every
 * credential to be an env-var NAME. The secret scan is a second line of
 * defense against a pasted key landing in `notes`, a free-form field, or a
 * future optional field — defense in depth, never the only layer.
 */

/** The conventional project-relative location for the bundle. */
export const AGENT_CONFIG_BUNDLE_FILE_NAME = "agent-config.json";
export const AGENT_CONFIG_BUNDLE_DIR = ".guru";

export type AgentConfigBundleVerdict = "GREEN" | "YELLOW" | "RED";
export type AgentConfigBundleStatus = "loaded" | "missing" | "invalid";

export interface AgentConfigBundleLoadResult {
  readonly status: AgentConfigBundleStatus;
  readonly verdict: AgentConfigBundleVerdict;
  readonly source: "explicit" | "project" | "defaults";
  readonly path: string;
  readonly bundle: AgentConfigBundle;
  readonly diagnostics: readonly string[];
}

export interface LoadAgentConfigBundleOptions {
  /** Explicit bundle path; overrides the `.guru/agent-config.json` discovery. */
  readonly bundlePath?: string;
  readonly cwd?: string;
}

/**
 * Locate and validate the agent config bundle.
 *
 * Discovery order: an explicit `bundlePath` (only that path; missing is not
 * silently hidden behind a default), else `<cwd>/.guru/agent-config.json`.
 * A missing file yields YELLOW with safe defaults — adopting the bundle is
 * opt-in. Any embedded secret VALUE yields RED, regardless of schema validity.
 */
export function loadAgentConfigBundle(options: LoadAgentConfigBundleOptions = {}): AgentConfigBundleLoadResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const candidates = resolveBundleCandidates(options, cwd);

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) {
      continue;
    }
    return loadBundleAt(candidate.path, candidate.source);
  }

  const missingPath = candidates[0]?.path ?? resolveProjectBundlePath(cwd);
  return {
    status: "missing",
    verdict: "YELLOW",
    source: "defaults",
    path: missingPath,
    bundle: DEFAULT_AGENT_CONFIG_BUNDLE,
    diagnostics: [`Agent config bundle not found at ${missingPath}; using safe defaults.`]
  };
}

interface BundleCandidate {
  readonly path: string;
  readonly source: "explicit" | "project";
}

function resolveBundleCandidates(options: LoadAgentConfigBundleOptions, cwd: string): readonly BundleCandidate[] {
  if (options.bundlePath) {
    return [{ path: resolveBundlePath(options.bundlePath, cwd), source: "explicit" }];
  }
  return [{ path: resolveProjectBundlePath(cwd), source: "project" }];
}

function resolveProjectBundlePath(cwd: string): string {
  return join(cwd, AGENT_CONFIG_BUNDLE_DIR, AGENT_CONFIG_BUNDLE_FILE_NAME);
}

function resolveBundlePath(bundlePath: string, cwd: string): string {
  return isAbsolute(bundlePath) ? bundlePath : resolve(cwd, bundlePath);
}

function loadBundleAt(bundlePath: string, source: BundleCandidate["source"]): AgentConfigBundleLoadResult {
  let rawText: string;
  try {
    // Strip a UTF-8 BOM (Windows Notepad default) — JSON.parse throws on it,
    // which would silently replace the operator's bundle with safe defaults.
    rawText = readFileSync(bundlePath, "utf8");
  } catch (error) {
    return {
      status: "invalid",
      verdict: "RED",
      source,
      path: bundlePath,
      bundle: DEFAULT_AGENT_CONFIG_BUNDLE,
      diagnostics: [`Failed to read agent config bundle at ${bundlePath}: ${formatError(error)}`]
    };
  }

  const cleaned = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;

  const secretHit = findEmbeddedSecret(cleaned);
  if (secretHit !== null) {
    // Foundational Law 3 (no leaked secrets): refuse to even parse a bundle that
    // carries a credential value. Report the match kind + location only — never
    // echo the secret back in diagnostics.
    return {
      status: "invalid",
      verdict: "RED",
      source,
      path: bundlePath,
      bundle: DEFAULT_AGENT_CONFIG_BUNDLE,
      diagnostics: [
        `Refused to load agent config bundle at ${bundlePath}: embedded secret value detected (${secretHit.kind}). Bundles must reference credential ENV NAMES, never values.`
      ]
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    return {
      status: "invalid",
      verdict: "RED",
      source,
      path: bundlePath,
      bundle: DEFAULT_AGENT_CONFIG_BUNDLE,
      diagnostics: [`Malformed agent config bundle at ${bundlePath}: ${formatError(error)}`]
    };
  }

  const result = AgentConfigBundleSchema.safeParse(parsed);
  if (!result.success) {
    return {
      status: "invalid",
      verdict: "RED",
      source,
      path: bundlePath,
      bundle: DEFAULT_AGENT_CONFIG_BUNDLE,
      diagnostics: result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : " at root";
        return `Invalid agent config bundle${path}: ${issue.message}`;
      })
    };
  }

  return {
    status: "loaded",
    verdict: "GREEN",
    source,
    path: bundlePath,
    bundle: result.data,
    diagnostics: []
  };
}

export interface SaveAgentConfigBundleOptions {
  /** Directory to resolve a relative path against. Defaults to process.cwd(). */
  readonly cwd?: string;
  /** Pretty-print indent. Defaults to 2. */
  readonly indent?: number;
}

/**
 * Validate and persist a bundle. Runs the schema AND the secret scan first;
 * throws {@link EmbeddedSecretError} if a secret value would be written, so a
 * secret can never reach disk through this path.
 */
export function saveAgentConfigBundle(
  bundlePath: string,
  bundle: AgentConfigBundle,
  options: SaveAgentConfigBundleOptions = {}
): void {
  const validated = AgentConfigBundleSchema.parse(bundle);
  const serialized = `${JSON.stringify(validated, null, options.indent ?? 2)}\n`;

  const secretHit = findEmbeddedSecret(serialized);
  if (secretHit !== null) {
    throw new EmbeddedSecretError(
      `Refused to save agent config bundle at ${bundlePath}: embedded secret value detected (${secretHit.kind}). Bundles must reference credential ENV NAMES, never values.`
    );
  }

  const resolved = resolveBundlePath(bundlePath, options.cwd ?? process.cwd());
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, serialized, "utf8");
}

/** Thrown when a save attempt would write an embedded secret value. */
export class EmbeddedSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddedSecretError";
  }
}

export interface ExportAgentConfigBundleOptions {
  readonly indent?: number;
}

/** Serialize a validated bundle to a stable JSON string (round-trips through load). */
export function exportAgentConfigBundle(bundle: AgentConfigBundle, options: ExportAgentConfigBundleOptions = {}): string {
  const validated = AgentConfigBundleSchema.parse(bundle);
  return `${JSON.stringify(validated, null, options.indent ?? 2)}\n`;
}

/**
 * Patterns that indicate a credential VALUE rather than a reference.
 *
 * This is deliberately conservative: each pattern targets a high-signal prefix
 * or structural marker of a real secret format, not arbitrary long strings, so
 * ordinary prose in `notes` does not false-positive. The env-NAME regex on
 * credential fields remains the primary defense; this is defense in depth.
 */
const SECRET_PATTERNS: readonly { kind: string; pattern: RegExp }[] = [
  { kind: "openai-style api key (sk-...)", pattern: /\bsk-[A-Za-z0-9]{16,}\b/ },
  { kind: "aws access key id (AKIA...)", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "slack token (xox[abprs]-...)", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "github token (gh[opsu]_...)", pattern: /\bgh[opsu]_[A-Za-z0-9]{16,}\b/ },
  { kind: "google api key (AIza...)", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { kind: "stripe key (sk_live_/sk_test_...)", pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { kind: "private key block (PEM)", pattern: /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/ },
  { kind: "jwt (eyJ...)", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ }
];

/** A located secret match — kind reported, value never echoed. */
export interface SecretMatch {
  readonly kind: string;
  /** 1-indexed line where the match starts, for operator triage. */
  readonly line: number;
}

/**
 * Scan raw text for an embedded credential value. Returns the first match or
 * null. Exported so callers and tests can reuse the exact detector the loader
 * uses — the rule is one definition, applied everywhere.
 */
export function findEmbeddedSecret(rawText: string): SecretMatch | null {
  for (const { kind, pattern } of SECRET_PATTERNS) {
    const match = rawText.match(pattern);
    if (match !== null && match.index !== undefined) {
      const line = rawText.slice(0, match.index).split("\n").length;
      return { kind, line };
    }
  }
  return null;
}

/** Convenience wrapper: true iff {@link findEmbeddedSecret} finds a hit. */
export function rejectEmbeddedSecrets(rawText: string): boolean {
  return findEmbeddedSecret(rawText) !== null;
}

/** Re-export so consumers can pin a bundle version without a second import. */
export { AGENT_CONFIG_BUNDLE_VERSION };

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
