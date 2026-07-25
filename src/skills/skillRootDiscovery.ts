import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { discoverSkills } from "./loader.js";

/**
 * Skill root discovery + trust gate (IDEA-F318-SKILL-TRUST-01 / R-OH-SKILL-TRUST).
 *
 * Skills resolve from ordered roots of two origins:
 *   - {@link SkillRootOrigin.home} — the reusable home profile; always trusted.
 *   - {@link SkillRootOrigin.project} — a per-project `<project>/.guru`-style root.
 *
 * Project roots are gated: they are omitted from the load set when
 * `allowProjectSkills === false` OR `projectTrusted !== true`. There is NO
 * fail-open default — an undefined `projectTrusted` is treated as untrusted, so
 * an unconfigured/unknown tree can never silently inject project skills. This is
 * the hard-edge enforcement for the security non-goal "Fail-open project skills
 * on untrusted trees" (ideation REVIEW 2026-07-19, Phase 6).
 *
 * This module composes the existing {@link discoverSkills} seam — it does not
 * edit core skill loading — and surfaces root-level trust diagnostics so the
 * gate is observable, not silent.
 */

export const SKILL_ROOT_TRUST_REASON = {
  /** Project skills disabled by policy (`allowProjectSkills: false`). */
  allowProjectSkillsFalse: "allowProjectSkills=false",
  /** Project root not explicitly trusted (`projectTrusted` is not `true`). */
  untrusted: "untrusted"
} as const;
export type SkillRootTrustReason = (typeof SKILL_ROOT_TRUST_REASON)[keyof typeof SKILL_ROOT_TRUST_REASON];

export const SkillRootOrigin = {
  home: "home",
  project: "project"
} as const;
export type SkillRootOrigin = (typeof SkillRootOrigin)[keyof typeof SkillRootOrigin];

export interface SkillRoot {
  /** Absolute, resolved path of the root directory. */
  readonly path: string;
  /** Whether this root contributes skills (home) or is gated (project). */
  readonly origin: SkillRootOrigin;
  /** Skill ids discovered beneath this root (sorted, after the loader's own dedup). */
  readonly skillIds: readonly string[];
}

export interface GatedSkillRoot extends SkillRoot {
  /** Why this root was excluded from the load set. */
  readonly reason: SkillRootTrustReason;
}

export interface SkillRootDiscoveryResult {
  /** Ordered candidate roots, home-first then project, with per-root skill ids. */
  readonly roots: readonly SkillRoot[];
  /** Roots that survived the trust gate and contribute skills. */
  readonly loadSet: readonly SkillRoot[];
  /** Project roots excluded by the trust gate. */
  readonly gatedRoots: readonly GatedSkillRoot[];
  /** Human-readable trust/gate diagnostics. */
  readonly diagnostics: readonly string[];
  /** Convenience: every skill id across the load set (de-duplicated, sorted). */
  readonly skillIds: () => readonly string[];
}

export interface SkillRootDiscoveryOptions {
  /** Ordered trusted home roots (e.g. `~/.guruharness`). Always loaded. */
  readonly homeRoots: readonly string[];
  /** Ordered project roots (e.g. `<project>/.guru`). Loaded only when trusted. */
  readonly projectRoots: readonly string[];
  /**
   * Operator policy to allow project-root skills at all. When `false`, every
   * project root is gated regardless of trust. Defaults to `false` (deny) so the
   * gate is closed until an operator opts in.
   */
  readonly allowProjectSkills?: boolean;
  /**
   * Whether the project tree is trusted. Only the explicit value `true` opens
   * the gate; `undefined`/`false` keep project roots gated (no fail-open).
   */
  readonly projectTrusted?: boolean;
  /** Working directory used when resolving relative roots. */
  readonly cwd?: string;
  /** Skill manifest file name passed through to the loader. */
  readonly skillFileName?: string;
  /** Max recursion depth passed through to the loader. */
  readonly maxDepth?: number;
}

export function discoverSkillRoots(options: SkillRootDiscoveryOptions): SkillRootDiscoveryResult {
  const cwd = options.cwd ?? process.cwd();
  const allowProjectSkills = options.allowProjectSkills === true;
  const projectTrusted = options.projectTrusted === true;

  const roots: SkillRoot[] = [];
  const loadSet: SkillRoot[] = [];
  const gatedRoots: GatedSkillRoot[] = [];
  const diagnostics: string[] = [];

  for (const rawHome of options.homeRoots) {
    const root = resolveRoot(rawHome, cwd, SkillRootOrigin.home);
    if (!root) {
      continue;
    }
    roots.push(root);
    loadSet.push(root);
  }

  for (const rawProject of options.projectRoots) {
    const root = resolveRoot(rawProject, cwd, SkillRootOrigin.project);
    if (!root) {
      continue;
    }
    roots.push(root);

    const gate = gateProjectRoot(allowProjectSkills, projectTrusted);
    if (gate) {
      const gated: GatedSkillRoot = { ...root, reason: gate };
      gatedRoots.push(gated);
      diagnostics.push(`Project skill root gated (${gate}): ${root.path}`);
      continue;
    }

    loadSet.push(root);
  }

  const loadSetIds = uniqueSorted(loadSet.flatMap((root) => root.skillIds));

  return {
    roots,
    loadSet,
    gatedRoots,
    diagnostics,
    skillIds: () => loadSetIds
  };
}

/**
 * Evaluate the project trust gate. Returns the reason when the root must be
 * gated, or `undefined` when it is allowed. A project root is allowed ONLY when
 * project skills are permitted AND the tree is explicitly trusted — anything
 * else (including an undefined/unknown trust value) gates the root.
 */
function gateProjectRoot(allowProjectSkills: boolean, projectTrusted: boolean): SkillRootTrustReason | undefined {
  if (!allowProjectSkills) {
    return SKILL_ROOT_TRUST_REASON.allowProjectSkillsFalse;
  }

  if (!projectTrusted) {
    return SKILL_ROOT_TRUST_REASON.untrusted;
  }

  return undefined;
}

function resolveRoot(
  rawRoot: string,
  cwd: string,
  origin: SkillRootOrigin
): SkillRoot | undefined {
  const path = resolve(cwd, rawRoot);

  if (!existsSync(path)) {
    return undefined;
  }

  if (!statSync(path).isDirectory()) {
    return undefined;
  }

  const catalog = discoverSkills({ directories: [path], skillFileName: "SKILL.md", maxDepth: 4 });
  const skillIds = uniqueSorted(catalog.skills.map((skill) => skill.id));

  return { path, origin, skillIds };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
