import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { resolveGuruHomeDirectory } from "../home/paths.js";
import { PROJECT_HARNESS_DIRECTORY_NAME } from "../project-harness/bootstrap.js";
import {
  WORKFLOW_PACK_FILE_SUFFIX,
  WorkflowPackSchema,
  type WorkflowPack
} from "./schema.js";

/**
 * Load + validate for workflow packs (IDEA-F1). Packs live in the home profile
 * (`~/.guruharness/packs/`) and the project harness (`<project>/.guru/packs/`),
 * as `*.pack.json` files. A project pack with the same `id` as a home pack
 * overrides it, but may only TIGHTEN the tool allowlist (an equal or smaller
 * set) — a project can never widen the tools a home pack granted the run.
 */

export const PACKS_DIRECTORY_NAME = "packs";

export interface WorkflowPackFieldError {
  readonly path: string;
  readonly message: string;
}

export type PackValidationResult =
  | { readonly ok: true; readonly pack: WorkflowPack }
  | { readonly ok: false; readonly errors: readonly WorkflowPackFieldError[] };

export interface LoadedWorkflowPack {
  readonly pack: WorkflowPack;
  /** Which layer supplied the effective pack (after override). */
  readonly source: "home" | "project";
  readonly path: string;
}

export interface LoadPacksReport {
  readonly packs: readonly LoadedWorkflowPack[];
  /** Files that failed to parse/validate, with their field errors. */
  readonly invalid: readonly { readonly path: string; readonly errors: readonly WorkflowPackFieldError[] }[];
  /** Project packs that tried to LOOSEN a home tool allowlist (rejected, home kept). */
  readonly rejectedProjectOverrides: readonly { readonly path: string; readonly id: string; readonly reason: string }[];
}

export interface LoadPacksOptions {
  /** Test seam / portable profile: defaults to ~/.guruharness. */
  readonly homeDirectory?: string;
  /** Project root containing `.guru/packs/`. Absent = home layer only. */
  readonly projectRoot?: string;
}

function packsDirectoryForHome(homeDirectory?: string): string {
  return join(resolveGuruHomeDirectory(homeDirectory), PACKS_DIRECTORY_NAME);
}

function packsDirectoryForProject(projectRoot: string): string {
  return join(resolve(projectRoot), PROJECT_HARNESS_DIRECTORY_NAME, PACKS_DIRECTORY_NAME);
}

/** Validate a raw JSON value against the pack schema; on success return the typed pack. */
export function validatePackData(data: unknown): PackValidationResult {
  const parsed = WorkflowPackSchema.safeParse(data);
  if (parsed.success) {
    return { ok: true, pack: parsed.data };
  }
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => ({
      path: issue.path.map((segment) => String(segment)).join(".") || "(root)",
      message: issue.message
    }))
  };
}

/** Read + validate one pack file. Never throws on bad content — returns field errors. */
export function validatePack(path: string): PackValidationResult {
  let raw: string;
  try {
    raw = readFileSync(resolve(path), "utf8");
  } catch (error) {
    return {
      ok: false,
      errors: [{ path: "(file)", message: `unreadable: ${error instanceof Error ? error.message : String(error)}` }]
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      errors: [{ path: "(file)", message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` }]
    };
  }
  return validatePackData(data);
}

function listPackFiles(directory: string): readonly string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(WORKFLOW_PACK_FILE_SUFFIX))
    .map((entry) => join(directory, entry.name))
    .sort();
}

/**
 * Project override tightening rule (per plan: project may tighten, not loosen).
 * - tools: project set must be a SUBSET of the home set when the home pack
 *   declares one; if the home pack declares none (all tools), any project set
 *   is a tightening. A project pack may not drop the restriction entirely.
 * - extensions: same subset rule.
 * Returns null when the override is acceptable.
 */
export function projectOverrideViolation(home: WorkflowPack, project: WorkflowPack): string | null {
  const tighteningError = (field: "tools" | "extensions", homeList: readonly string[] | undefined, projectList: readonly string[] | undefined): string | null => {
    if (homeList === undefined) {
      return null;
    }
    if (projectList === undefined) {
      return `${field}: project override drops the home ${field} allowlist (loosening is not allowed)`;
    }
    const homeSet = new Set(homeList);
    const extra = projectList.filter((entry) => !homeSet.has(entry));
    if (extra.length > 0) {
      return `${field}: project override adds ids not in the home allowlist: ${extra.join(", ")}`;
    }
    return null;
  };
  return tighteningError("tools", home.tools, project.tools) ?? tighteningError("extensions", home.extensions, project.extensions);
}

/**
 * Load both layers and merge: home first, project overrides by id when the
 * override only tightens allowlists. Loosening project packs are rejected and
 * reported; the home pack remains effective.
 */
export function loadPacks(options: LoadPacksOptions = {}): LoadPacksReport {
  const invalid: { path: string; errors: readonly WorkflowPackFieldError[] }[] = [];
  const rejectedProjectOverrides: { path: string; id: string; reason: string }[] = [];
  const byId = new Map<string, LoadedWorkflowPack>();

  for (const path of listPackFiles(packsDirectoryForHome(options.homeDirectory))) {
    const result = validatePack(path);
    if (!result.ok) {
      invalid.push({ path, errors: result.errors });
      continue;
    }
    byId.set(result.pack.id, { pack: result.pack, source: "home", path });
  }

  if (options.projectRoot !== undefined) {
    for (const path of listPackFiles(packsDirectoryForProject(options.projectRoot))) {
      const result = validatePack(path);
      if (!result.ok) {
        invalid.push({ path, errors: result.errors });
        continue;
      }
      const existing = byId.get(result.pack.id);
      if (existing && existing.source === "home") {
        const violation = projectOverrideViolation(existing.pack, result.pack);
        if (violation !== null) {
          rejectedProjectOverrides.push({ path, id: result.pack.id, reason: violation });
          continue;
        }
      }
      byId.set(result.pack.id, { pack: result.pack, source: "project", path });
    }
  }

  return { packs: [...byId.values()].sort((a, b) => a.pack.id.localeCompare(b.pack.id)), invalid, rejectedProjectOverrides };
}

/** Resolve one pack by id across the layers (same merge rules as loadPacks). */
export function resolvePack(id: string, options: LoadPacksOptions = {}): LoadedWorkflowPack | null {
  const report = loadPacks(options);
  return report.packs.find((loaded) => loaded.pack.id === id) ?? null;
}
