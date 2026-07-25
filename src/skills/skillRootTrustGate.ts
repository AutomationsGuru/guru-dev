import { discoverSkills } from "./loader.js";
import type { SkillCatalog } from "./schemas.js";

/**
 * Skill root trust gate (IDEA-F487-SKTRUST-01; ideation R-OH-SKILL-TRUST — the
 * "skip project skills when allow_project_skills=false" half of the predicate).
 *
 * This module is the **trust-gate decision primitive**: given an ordered list of
 * skill roots (each tagged with an origin and, for project roots, a trust flag)
 * and the operator policy flags, it admits each root into the load set or gates
 * it with a reason — before any skill from a gated root can reach the model. The
 * sibling `skillRootDiscovery.ts` (IDEA-F318) resolves the candidate roots; this
 * module owns the gate decision and the admitted skill-id enumeration.
 *
 * Constitution (vision §3.4 no out-of-scope crossing; ideation Phase-6 non-goal
 * "Fail-open project skills on untrusted trees"): the gate is **fail-closed** in
 * code, not prose. `allowProjectSkills` defaults to `false`, and an
 * `undefined`/`false` `trusted` is treated as untrusted — an unconfigured project
 * tree can never silently inject skills.
 *
 * Composes the frozen seam: per-root skill enumeration delegates to the existing
 * `discoverSkills` loader (`./loader.js`). This module adds no weight to core
 * skill loading, does not edit `schemas.ts` or `loader.ts`, and introduces no new
 * runtime dependency (vision §1.2/§1.3; seam-break / weight drift avoided).
 */

/** Where a skill root comes from. */
export type SkillRootOrigin = "home" | "project";

/**
 * A candidate skill root.
 *
 * - `home` roots are the reusable home profile; they are **always trusted** and
 *   the `trusted` flag is ignored for them.
 * - `project` roots are gated: a project root is admitted only when policy
 *   allows project skills **and** the root is explicitly trusted.
 */
export interface SkillRoot {
  /** Absolute or cwd-relative path to the root directory. */
  readonly path: string;
  readonly origin: SkillRootOrigin;
  /** Project-root trust. Ignored for `home` roots; defaults to `false`. */
  readonly trusted?: boolean;
}

/** Operator policy flags controlling the trust gate. */
export interface SkillRootTrustFlags {
  /**
   * Whether skills from `project` roots may be admitted at all. Defaults to
   * `false` (deny-default; no fail-open).
   */
  readonly allowProjectSkills?: boolean;
}

/** Why a project root was excluded from the load set. */
export type SkillRootGateReason = "allowProjectSkills=false" | "untrusted";

/** A project root that the gate excluded, with the reason and a diagnostic. */
export interface GatedSkillRoot {
  readonly path: string;
  readonly reason: SkillRootGateReason;
  readonly diagnostic: string;
}

/** The outcome of running the trust gate over a set of candidate roots. */
export interface SkillRootTrustResult {
  /** Roots admitted to the load set, in their original (home-first) order. */
  readonly loadSet: readonly SkillRoot[];
  /** Project roots excluded by the gate, with reason + diagnostic. */
  readonly gatedRoots: readonly GatedSkillRoot[];
  /** Human-readable gate + enumeration diagnostics. */
  readonly diagnostics: readonly string[];
  /**
   * De-duplicated (first-wins), sorted skill ids across the admitted roots.
   * Gated roots contribute no ids.
   */
  skillIds(): string[];
}

/**
 * Run the skill-root trust gate.
 *
 * Admits every `home` root. Admits a `project` root only when
 * `flags.allowProjectSkills === true` **and** `root.trusted === true`; otherwise
 * records it in `gatedRoots` with a reason and omits its skills. Returns a
 * `skillIds()` view over the admitted roots only.
 *
 * Per-root enumeration is non-fatal: an admitted root that cannot be enumerated
 * (missing directory, read error) records a diagnostic and contributes no skill
 * ids rather than throwing — the rest of the load set stays usable.
 */
export function discoverTrustedSkillRoots(
  options: { roots: readonly SkillRoot[]; flags?: SkillRootTrustFlags } | readonly SkillRoot[]
): SkillRootTrustResult {
  const { roots, allowProjectSkills } = normalizeOptions(options);

  const loadSet: SkillRoot[] = [];
  const gatedRoots: GatedSkillRoot[] = [];
  const diagnostics: string[] = [];
  const seenIds = new Set<string>();
  const admittedIds: string[] = [];

  for (const root of roots) {
    const gateReason = gateReasonFor(root, allowProjectSkills);
    if (gateReason) {
      const diagnostic = formatGateDiagnostic(root, gateReason);
      gatedRoots.push({ path: root.path, reason: gateReason, diagnostic });
      diagnostics.push(diagnostic);
      continue;
    }

    loadSet.push(root);

    // Per-root enumeration is non-fatal: a missing or unreadable root yields no
    // ids but surfaces the loader's own diagnostics, so one bad root never takes
    // down the whole load set (mirrors the loader's diagnostic-on-missing behavior).
    let ids: string[];
    let rootDiagnostics: string[];
    try {
      ({ ids, diagnostics: rootDiagnostics } = enumerateSkillIds(root));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push(`Skill root enumeration failed for ${root.path}: ${message}`);
      continue;
    }

    diagnostics.push(...rootDiagnostics);
    for (const id of ids) {
      if (!seenIds.has(id)) {
        seenIds.add(id);
        admittedIds.push(id);
      }
    }
  }

  admittedIds.sort((a, b) => a.localeCompare(b));

  return {
    loadSet,
    gatedRoots,
    diagnostics,
    skillIds: () => [...admittedIds]
  };
}

/** `discover(roots, flags)` — the plan's literal signature, delegating to the gate. */
export const discover = discoverTrustedSkillRoots;

function normalizeOptions(
  options: { roots: readonly SkillRoot[]; flags?: SkillRootTrustFlags } | readonly SkillRoot[]
): { roots: readonly SkillRoot[]; allowProjectSkills: boolean } {
  if (!Array.isArray(options) && typeof options === "object" && "roots" in options) {
    return {
      roots: options.roots,
      allowProjectSkills: options.flags?.allowProjectSkills === true
    };
  }
  return { roots: options as readonly SkillRoot[], allowProjectSkills: false };
}

/**
 * The gate reason for a root, or `undefined` when the root is admitted.
 *
 * Home roots are always admitted. Project roots require both the policy allow
 * and explicit trust; the policy check wins ordering so the reason reflects the
 * binding decision (a policy deny reports `allowProjectSkills=false` even when
 * the root is also untrusted).
 */
function gateReasonFor(root: SkillRoot, allowProjectSkills: boolean): SkillRootGateReason | undefined {
  if (root.origin === "home") {
    return undefined;
  }

  if (!allowProjectSkills) {
    return "allowProjectSkills=false";
  }

  if (root.trusted !== true) {
    return "untrusted";
  }

  return undefined;
}

function formatGateDiagnostic(root: SkillRoot, reason: SkillRootGateReason): string {
  return `Skill root gated (${reason}): ${root.path}`;
}

/**
 * Enumerate the skill ids discovered under a root, along with any loader
 * diagnostics (e.g. "Skill directory not found"). A hard read error throws; the
 * caller catches it so enumeration stays non-fatal at the gate level.
 */
function enumerateSkillIds(root: SkillRoot): { ids: string[]; diagnostics: string[] } {
  const catalog: SkillCatalog = discoverSkills({ directories: [root.path] });
  return {
    ids: catalog.skills.map((skill) => skill.id),
    diagnostics: [...catalog.diagnostics]
  };
}
