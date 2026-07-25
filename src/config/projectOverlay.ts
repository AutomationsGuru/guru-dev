import { lstatSync, readFileSync } from "node:fs";
import { parse, resolve, sep } from "node:path";

import type { HarnessConfig } from "./schema.js";

/**
 * Project-local overlay merge (IDEA-C2 / R-CW-TIGHTEN).
 *
 * A generated `<project>/.guru/guruharness.config.json` may only TIGHTEN the
 * operator's global/home posture. It can never widen approvals, loosen the
 * sandbox, grow shell capability, or inject secrets, endpoints, provider
 * credentials, or MCP servers. This module enforces that structurally: every
 * project key is either applied (equal-or-stricter along a defined safety
 * direction), dropped (a widen attempt — global value kept, diagnostic
 * emitted), or hard-rejected (credential/endpoint/MCP/shell-widen keys never
 * reach the merged config). The input global config is never mutated and
 * nothing here writes project state.
 */

export interface ProjectOverlayResult {
  readonly config: HarnessConfig;
  /** One entry per dropped or rejected key — the merge itself never throws. */
  readonly diagnostics: readonly string[];
}

export type ProjectOverlayLoadStatus = "loaded" | "rejected";

export interface ProjectOverlayLoadResult {
  readonly status: ProjectOverlayLoadStatus;
  /** Absolute path that was read (or refused). */
  readonly path: string;
  /** Raw parsed JSON when loaded; undefined when rejected. */
  readonly overlay?: Record<string, unknown>;
  /** Human-readable rejection reason; empty when loaded. */
  readonly reason: string;
}

/** Scalar keys a project overlay may set only to an equal value (no direction exists). */
const EQUAL_ONLY_KEYS = new Set(["runtimeName", "referenceRuntime"]);

/**
 * Boolean keys where `false` is the stricter value (permission/danger flags).
 * A project may flip these true→false, never false→true.
 */
const FALSE_IS_STRICTER_KEYS = new Set([
  "approvalPolicy.autoCommitPushPr",
  "approvalPolicy.allowLocalMerge",
  "approvalPolicy.allowForcePush",
  "runtimeHardening.allowDirtyWorkspace",
  "runtimeHardening.allowRiskyPaths",
  "retry.enabled"
]);

/** Boolean keys where `true` is the stricter value (required gates). */
const TRUE_IS_STRICTER_KEYS = new Set(["reviewGate.required"]);

/**
 * Positive numeric budgets where a SMALLER value is stricter.
 * A project may decrease these, never raise them.
 */
const DECREASE_ONLY_KEYS = new Set([
  "selfBuild.maxIterations",
  "runtimeHardening.plannerMaxRetries",
  "retry.maxRetries",
  "retry.baseDelayMs",
  "retry.provider.maxRetries",
  "retry.provider.maxRetryDelayMs",
  "criticPanel.maxWorkers"
]);

/**
 * String-list keys interpreted as ALLOWLISTS: a subset is stricter.
 * A project may shrink these, never grow or re-membership them.
 */
const SUBSET_ONLY_LIST_KEYS = new Set(["runtimeHardening.shellAllowlist", "runtimeHardening.secretAllowList"]);

/**
 * String-list keys interpreted as GUARD LISTS: a superset is stricter
 * (more paths treated as risky). A project may grow these, never shrink.
 */
const SUPERSET_ONLY_LIST_KEYS = new Set(["runtimeHardening.riskyPathPatterns"]);

/**
 * Top-level keys that are hard-rejected on sight: they carry secrets,
 * endpoints, provider credentials, or attach new MCP servers. A project
 * overlay has no legitimate reason to set any of them.
 */
const HARD_REJECT_TOP_LEVEL_KEYS = new Set([
  "plannerModel",
  "plannerModelFallbacks",
  "mcpServers",
  "tools",
  "providers",
  "endpoints",
  "credentials",
  "secrets",
  "vault"
]);

/** Substring patterns (case-insensitive) marking a credential/endpoint/shell-widen key at any depth. */
const HARD_REJECT_NAME_PATTERNS: readonly RegExp[] = [
  /api[_-]?key/i,
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /private[_-]?key/i,
  /base[_-]?url/i,
  /endpoint/i,
  /auth/i,
  /^allow[_-]?shell$/i,
  /shell[_-]?command/i
];

/** Subtrees whose leaf keys are credential-adjacent and always rejected. */
const HARD_REJECT_PREFIXES = ["memory.honcho.apiKeyEnvVar"];

export function applyProjectOverlay(globalConfig: HarnessConfig, projectOverlay: unknown): ProjectOverlayResult {
  const diagnostics: string[] = [];
  // Deep-clone so the operator's parsed global config is never mutated.
  const merged = JSON.parse(JSON.stringify(globalConfig)) as Record<string, unknown>;

  if (projectOverlay === null || typeof projectOverlay !== "object" || Array.isArray(projectOverlay)) {
    return { config: globalConfig, diagnostics: ["Project overlay is not a JSON object; ignored entirely."] };
  }

  mergeObject(merged, projectOverlay as Record<string, unknown>, "", diagnostics);

  return { config: merged as unknown as HarnessConfig, diagnostics };
}

function mergeObject(
  target: Record<string, unknown>,
  overlay: Record<string, unknown>,
  prefix: string,
  diagnostics: string[]
): void {
  for (const [key, value] of Object.entries(overlay)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;

    if (isHardRejected(path, key, prefix)) {
      diagnostics.push(`Rejected ${path}: secrets, endpoints, provider credentials, MCP servers, and shell-widening keys are not permitted in a project overlay.`);
      continue;
    }

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const existing = target[key];
      if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
        mergeObject(existing as Record<string, unknown>, value as Record<string, unknown>, path, diagnostics);
      } else if (existing === undefined) {
        diagnostics.push(`Dropped ${path}: unknown key is not part of the harness config contract.`);
      } else {
        diagnostics.push(`Dropped ${path}: cannot overlay an object onto a scalar value.`);
      }
      continue;
    }

    applyLeaf(target, key, path, value, diagnostics);
  }
}

function applyLeaf(
  target: Record<string, unknown>,
  key: string,
  path: string,
  value: unknown,
  diagnostics: string[]
): void {
  const current = target[key];

  if (current === undefined) {
    diagnostics.push(`Dropped ${path}: unknown key is not part of the harness config contract.`);
    return;
  }

  if (Array.isArray(current) || Array.isArray(value)) {
    applyListLeaf(target, key, path, current, value, diagnostics);
    return;
  }

  if (typeof current !== typeof value) {
    diagnostics.push(`Dropped ${path}: type mismatch with global config (${typeof current} vs ${typeof value}).`);
    return;
  }

  if (typeof value === "boolean") {
    applyBooleanLeaf(target, key, path, current as boolean, value, diagnostics);
    return;
  }

  if (typeof value === "number") {
    applyNumberLeaf(target, key, path, current as number, value, diagnostics);
    return;
  }

  if (typeof value === "string") {
    applyStringLeaf(target, key, path, current as string, value, diagnostics);
    return;
  }

  diagnostics.push(`Dropped ${path}: unsupported value kind.`);
}

function applyBooleanLeaf(
  target: Record<string, unknown>,
  key: string,
  path: string,
  current: boolean,
  value: boolean,
  diagnostics: string[]
): void {
  if (value === current) {
    return;
  }
  if (FALSE_IS_STRICTER_KEYS.has(path)) {
    if (value === false) {
      target[key] = value;
    } else {
      diagnostics.push(`Dropped ${path}: project overlay may only tighten this permission (true → false), never broaden it.`);
    }
    return;
  }
  if (TRUE_IS_STRICTER_KEYS.has(path)) {
    if (value === true) {
      target[key] = value;
    } else {
      diagnostics.push(`Dropped ${path}: project overlay may only tighten this gate (false → true), never relax it.`);
    }
    return;
  }
  // Unknown boolean: tightening direction undefined — refuse to change it.
  diagnostics.push(`Dropped ${path}: no defined tightening direction for this flag; keeping the global value.`);
}

function applyNumberLeaf(
  target: Record<string, unknown>,
  key: string,
  path: string,
  current: number,
  value: number,
  diagnostics: string[]
): void {
  if (value === current) {
    return;
  }
  if (DECREASE_ONLY_KEYS.has(path)) {
    if (value < current) {
      target[key] = value;
    } else {
      diagnostics.push(`Dropped ${path}: project overlay may only decrease this budget (${current} → ${value} rejected).`);
    }
    return;
  }
  diagnostics.push(`Dropped ${path}: no defined tightening direction for this number; keeping the global value.`);
}

function applyStringLeaf(
  target: Record<string, unknown>,
  key: string,
  path: string,
  current: string,
  value: string,
  diagnostics: string[]
): void {
  if (value === current) {
    return;
  }
  if (path === "reviewGate.provider") {
    // The review gate must stay on guru's own native panel; a project may not
    // swap in an external command provider.
    diagnostics.push(`Dropped ${path}: project overlay may not replace the review gate provider.`);
    return;
  }
  if (EQUAL_ONLY_KEYS.has(path)) {
    diagnostics.push(`Dropped ${path}: identity strings are operator-owned; keeping the global value.`);
    return;
  }
  diagnostics.push(`Dropped ${path}: no defined tightening direction for this string; keeping the global value.`);
}

function applyListLeaf(
  target: Record<string, unknown>,
  key: string,
  path: string,
  current: unknown,
  value: unknown,
  diagnostics: string[]
): void {
  if (!Array.isArray(current) || !Array.isArray(value)) {
    diagnostics.push(`Dropped ${path}: type mismatch with global config (list vs scalar).`);
    return;
  }
  if (!current.every((item) => typeof item === "string") || !value.every((item) => typeof item === "string")) {
    diagnostics.push(`Dropped ${path}: only string-list leaves may be overlaid.`);
    return;
  }

  const currentSet = new Set(current as string[]);
  const valueSet = new Set(value as string[]);

  if (SUBSET_ONLY_LIST_KEYS.has(path)) {
    if (isSubset(valueSet, currentSet)) {
      // Preserve global ordering for the surviving entries.
      target[key] = (current as string[]).filter((item) => valueSet.has(item));
    } else {
      diagnostics.push(`Dropped ${path}: project overlay may only shrink this allowlist, never add entries.`);
    }
    return;
  }
  if (SUPERSET_ONLY_LIST_KEYS.has(path)) {
    if (isSubset(currentSet, valueSet)) {
      // Keep global order first, then project additions in project order.
      const additions = (value as string[]).filter((item) => !currentSet.has(item));
      target[key] = [...(current as string[]), ...additions];
    } else {
      diagnostics.push(`Dropped ${path}: project overlay may only grow this guard list, never remove entries.`);
    }
    return;
  }
  if (areSetsEqual(currentSet, valueSet)) {
    return; // Equal membership: no-op regardless of order.
  }
  diagnostics.push(`Dropped ${path}: no defined tightening direction for this list; keeping the global value.`);
}

/**
 * List keys that hold env-var NAMES, not secret values (presence-over-value
 * per the schema contract). They have a defined tightening direction, so the
 * credential name-patterns must not reject them before the subset rule runs.
 */
const NAME_ONLY_LIST_PATHS = new Set(["runtimeHardening.secretAllowList", "runtimeHardening.shellAllowlist"]);

function isHardRejected(path: string, key: string, prefix: string): boolean {
  if (prefix === "" && HARD_REJECT_TOP_LEVEL_KEYS.has(key)) {
    return true;
  }
  if (HARD_REJECT_PREFIXES.some((rejected) => path === rejected || path.startsWith(`${rejected}.`))) {
    return true;
  }
  if (NAME_ONLY_LIST_PATHS.has(path)) {
    return false;
  }
  return HARD_REJECT_NAME_PATTERNS.some((pattern) => pattern.test(key));
}

function isSubset(candidate: ReadonlySet<string>, superset: ReadonlySet<string>): boolean {
  for (const item of candidate) {
    if (!superset.has(item)) {
      return false;
    }
  }
  return true;
}

function areSetsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && isSubset(a, b);
}

/**
 * Read a project overlay config file, refusing symlinks. A symlinked project
 * config (or a symlinked path segment, e.g. `.guru`) is rejected outright:
 * the overlay must be real project-owned state, not a pointer at operator
 * files or arbitrary filesystem locations.
 */
export function loadProjectOverlayConfig(configPath: string): ProjectOverlayLoadResult {
  const absolutePath = resolve(configPath);

  const symlinkSegment = findSymlinkedSegment(absolutePath);
  if (symlinkSegment !== undefined) {
    return {
      status: "rejected",
      path: absolutePath,
      reason: `Rejected ${absolutePath}: symlinked project config (symlink at ${symlinkSegment}); project overlays must be real files.`
    };
  }

  let rawText: string;
  try {
    rawText = readFileSync(absolutePath, "utf8");
  } catch (error) {
    return {
      status: "rejected",
      path: absolutePath,
      reason: `Failed to read project overlay at ${absolutePath}: ${formatError(error)}`
    };
  }

  try {
    const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        status: "rejected",
        path: absolutePath,
        reason: `Rejected ${absolutePath}: project overlay must be a JSON object.`
      };
    }
    return { status: "loaded", path: absolutePath, overlay: parsed as Record<string, unknown>, reason: "" };
  } catch (error) {
    return {
      status: "rejected",
      path: absolutePath,
      reason: `Failed to parse project overlay at ${absolutePath}: ${formatError(error)}`
    };
  }
}

/** Walk every existing path segment; return the first one that is a symlink. */
function findSymlinkedSegment(absolutePath: string): string | undefined {
  const { root } = parse(absolutePath);
  const segments = absolutePath.slice(root.length).split(sep).filter((segment) => segment.length > 0);

  let current = root;
  for (const segment of segments) {
    current = current === root ? `${root}${segment}` : `${current}${sep}${segment}`;
    try {
      if (lstatSync(current).isSymbolicLink()) {
        return current;
      }
    } catch {
      // Segment does not exist (or is unreadable); deeper segments and the
      // final read will surface the real error.
      return undefined;
    }
  }
  return undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
