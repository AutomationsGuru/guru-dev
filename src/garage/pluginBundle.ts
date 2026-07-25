import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { PluginBundleSchema, type PluginBundle } from "./pluginBundleSchema.js";

/**
 * Plugin bundle validation + install planning (IDEA-F111-PLUGIN-BUNDLES-01).
 * A validated bundle installs into a home/project overlay root as
 * `<overlayRoot>/<categoryDir>/<entry.path>` with all-or-nothing conflict
 * detection: without `force`, any pre-existing target aborts the whole install
 * and nothing is written. Pure planning ({@link planInstall}) touches no disk
 * state beyond existence probes; {@link applyInstall} performs the writes.
 */

export const BUNDLE_CATEGORIES = ["skills", "hooks", "commands", "specialists"] as const;
export type BundleCategory = (typeof BUNDLE_CATEGORIES)[number];

/** Category → overlay subdirectory. Plain same-named dirs for now. */
export const BUNDLE_CATEGORY_DIRS: Record<BundleCategory, string> = {
  skills: "skills",
  hooks: "hooks",
  commands: "commands",
  specialists: "specialists"
};

export type ValidateBundleResult = { ok: true; bundle: PluginBundle } | { ok: false; errors: string[] };

/** Safe-parse wrapper: flattens zod issues into `path: message` strings. Never throws on bad input. */
export function validateBundle(input: unknown): ValidateBundleResult {
  const parsed = PluginBundleSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, bundle: parsed.data };
  }
  const errors = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  return { ok: false, errors };
}

export type InstallEntryStatus = "create" | "conflict";

export interface InstallPlanEntry {
  readonly category: BundleCategory;
  /** The bundle-relative source path (entry.path in the manifest). */
  readonly sourcePath: string;
  /** Absolute install target under the overlay root. */
  readonly targetPath: string;
  readonly status: InstallEntryStatus;
}

export interface InstallPlan {
  readonly overlayRoot: string;
  readonly entries: InstallPlanEntry[];
  /** Conflicting target paths (subset of entries with status "conflict"). */
  readonly conflicts: string[];
}

/** Defence in depth on top of schema validation: a target must stay under the overlay root. */
function resolveTarget(overlayRoot: string, entryPath: string): string {
  const target = resolve(overlayRoot, entryPath);
  if (target !== overlayRoot && !target.startsWith(overlayRoot + sep)) {
    throw new Error(`bundle entry path escapes overlay root: ${entryPath}`);
  }
  return target;
}

/** Pure install plan: probes existence only, never writes. */
export function planInstall(bundle: PluginBundle, overlayRoot: string): InstallPlan {
  const root = resolve(overlayRoot);
  const entries: InstallPlanEntry[] = [];
  for (const category of BUNDLE_CATEGORIES) {
    for (const entry of bundle[category]) {
      const targetPath = resolveTarget(root, `${BUNDLE_CATEGORY_DIRS[category]}/${entry.path}`);
      entries.push({
        category,
        sourcePath: entry.path,
        targetPath,
        status: existsSync(targetPath) ? "conflict" : "create"
      });
    }
  }
  entries.sort((a, b) => {
    const cat = BUNDLE_CATEGORIES.indexOf(a.category) - BUNDLE_CATEGORIES.indexOf(b.category);
    return cat !== 0 ? cat : a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0;
  });
  return { overlayRoot: root, entries, conflicts: entries.filter((e) => e.status === "conflict").map((e) => e.targetPath) };
}

export interface ApplyInstallOptions {
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

export interface InstallResultBase {
  readonly plan: InstallPlan;
  /** Absolute paths of conflicting targets. */
  readonly conflicts: string[];
  /** Absolute paths written (or that would be written on dry-run). */
  readonly written: string[];
}

export interface InstallResultInstalled extends InstallResultBase {
  readonly status: "installed";
  /** Conflicting targets overwritten because force was set. */
  readonly overwritten: string[];
}

export interface InstallResultDryRun extends InstallResultBase {
  readonly status: "dry-run";
  readonly overwritten: string[];
}

export interface InstallResultConflict extends InstallResultBase {
  readonly status: "conflict";
  /** Human-readable error listing every conflicting path. */
  readonly error: string;
}

export type InstallResult = InstallResultInstalled | InstallResultDryRun | InstallResultConflict;

/**
 * Apply a bundle to an overlay root. Conflict policy: if any target already
 * exists and `force` is not set, the result is `conflict`, the error lists
 * every conflicting path, and NOTHING is written (all-or-nothing). `dryRun`
 * reports the plan without touching disk and takes precedence over force.
 */
export function applyInstall(bundle: PluginBundle, overlayRoot: string, options: ApplyInstallOptions = {}): InstallResult {
  const { dryRun = false, force = false } = options;
  const plan = planInstall(bundle, overlayRoot);
  const targets = plan.entries.map((e) => e.targetPath);

  if (plan.conflicts.length > 0 && !force && !dryRun) {
    return {
      status: "conflict",
      plan,
      conflicts: plan.conflicts,
      written: [],
      error: `plugin bundle "${bundle.id}" install blocked — ${plan.conflicts.length} conflicting path(s) already exist (use force to overwrite): ${plan.conflicts.join(", ")}`
    };
  }

  if (dryRun) {
    return { status: "dry-run", plan, conflicts: plan.conflicts, written: targets, overwritten: plan.conflicts };
  }

  const contents = new Map<string, string>();
  for (const category of BUNDLE_CATEGORIES) {
    for (const entry of bundle[category]) {
      contents.set(`${category}/${entry.path}`, entry.content);
    }
  }
  for (const entry of plan.entries) {
    const content = contents.get(`${entry.category}/${entry.sourcePath}`);
    if (content === undefined) {
      throw new Error(`plan/source mismatch for ${entry.category}:${entry.sourcePath}`);
    }
    if (!isAbsolute(entry.targetPath)) {
      throw new Error(`target path is not absolute: ${entry.targetPath}`);
    }
    mkdirSync(dirname(entry.targetPath), { recursive: true });
    writeFileSync(entry.targetPath, content, "utf8");
  }

  return { status: "installed", plan, conflicts: plan.conflicts, written: targets, overwritten: plan.conflicts };
}
