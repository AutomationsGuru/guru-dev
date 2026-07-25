import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import { isPathInside } from "./loader.js";
import type { SkillCatalog, SkillManifest } from "./schemas.js";

/**
 * Skill provenance (IDEA-F14-SKILL-PROV-01, R-AS-SKILL-GATE residual).
 *
 * Every discovered skill records where it came from: the source root class
 * (trust tier), the exact skill file path, and a content hash. The trust tier
 * decides whether the model may invoke the skill by default:
 *
 * - `builtin`  — shipped with the harness (the bundled `skills/` tree).
 * - `home`     — the operator's reusable home profile (`~/.guruharness`).
 * - `project`  — the current project's own `.guru` overlay.
 * - `external` — anything else (extra roots from config / env). External
 *   skills are NOT model-invocable until the operator approves the exact
 *   content hash; a content change invalidates the approval (fail-closed).
 *
 * Approval state lives in a small flat file (`skills/approvals.json` under an
 * operator-owned root) keyed by skill id — presence of a matching hash is the
 * only signal; this module never reads skill content for anything but hashing
 * and never stores secrets.
 */

export const SkillTrustTierSchema = z.enum(["builtin", "home", "project", "external"]);
export type SkillTrustTier = z.infer<typeof SkillTrustTierSchema>;

/** Approvals file location, relative to the chosen approvals root. */
export const SKILL_APPROVALS_RELATIVE_PATH = join("skills", "approvals.json");
export const SKILL_APPROVALS_VERSION = 1;

export const SkillProvenanceSchema = z
  .object({
    tier: SkillTrustTierSchema,
    /** Absolute path of the SKILL.md this provenance was computed from. */
    skillFile: z.string().trim().min(1),
    /** Absolute path of the trusted root that classified this skill (absent for external). */
    sourceRoot: z.string().trim().min(1).optional(),
    /** sha256 of the skill file bytes at annotation time. */
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    /** True when a recorded operator approval matches the current content hash. */
    approved: z.boolean()
  })
  .strict();
export type SkillProvenance = z.infer<typeof SkillProvenanceSchema>;

/** A skill manifest carrying its provenance record. */
export type ProvenanceAnnotatedManifest = SkillManifest & { readonly provenance: SkillProvenance };

export interface ProvenanceAnnotatedCatalog extends Omit<SkillCatalog, "skills"> {
  readonly skills: ProvenanceAnnotatedManifest[];
}

export interface SkillTrustRoots {
  /** The harness's own bundled skills tree (highest trust). */
  readonly bundledRoot?: string;
  /** The operator home profile root (e.g. ~/.guruharness or its skills dir). */
  readonly homeRoot?: string;
  /** The current project overlay root (e.g. <project>/.guru or its skills dir). */
  readonly projectRoot?: string;
}

export interface AnnotateProvenanceOptions extends SkillTrustRoots {
  /** Root holding the approvals file; omit to treat every external skill as unapproved. */
  readonly approvalsRoot?: string;
}

const SkillApprovalRecordSchema = z
  .object({
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    approvedAt: z.string().trim().min(1)
  })
  .strict();
export type SkillApprovalRecord = z.infer<typeof SkillApprovalRecordSchema>;

const SkillApprovalsFileSchema = z
  .object({
    version: z.literal(SKILL_APPROVALS_VERSION),
    approvals: z.record(z.string(), SkillApprovalRecordSchema).default({})
  })
  .strict();

export type SkillApprovalStore = Readonly<Record<string, SkillApprovalRecord>>;

/**
 * Classify one skill directory against the trusted roots. The first matching
 * root in builtin → home → project order wins, so a bundled tree nested inside
 * the home profile still classifies as builtin. Anything unmatched is external.
 */
export function resolveSkillTrustTier(options: SkillTrustRoots & { readonly skillDirectory: string }): SkillTrustTier {
  return matchTrustedRoot(options)?.tier ?? "external";
}

/** Compute the provenance record for one manifest (reads the skill file bytes once). */
export function skillProvenanceForManifest(
  manifest: SkillManifest,
  roots: SkillTrustRoots & { readonly approvals?: SkillApprovalStore } = {}
): SkillProvenance {
  const match = matchTrustedRoot({ ...roots, skillDirectory: manifest.directory });
  const contentHash = hashSkillFile(manifest.skillFile);
  const approval = roots.approvals?.[manifest.id];

  return SkillProvenanceSchema.parse({
    tier: match?.tier ?? "external",
    skillFile: resolve(manifest.skillFile),
    ...(match ? { sourceRoot: match.root } : {}),
    contentHash,
    approved: approval?.contentHash === contentHash
  });
}

/**
 * Annotate a discovered catalog with provenance. Pure read: never mutates the
 * input catalog, never writes to disk. Approvals are consulted by skill id and
 * only count when the recorded hash matches the current content hash.
 */
export function annotateCatalogWithProvenance(catalog: SkillCatalog, options: AnnotateProvenanceOptions = {}): ProvenanceAnnotatedCatalog {
  const approvals = readSkillApprovals(options.approvalsRoot);

  return {
    ...catalog,
    skills: catalog.skills.map((skill) => ({
      ...skill,
      provenance: skillProvenanceForManifest(skill, { ...options, approvals })
    }))
  };
}

/** sha256 over the exact skill file bytes, in `sha256:<hex>` form. */
export function hashSkillFile(skillFile: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(skillFile)).digest("hex")}`;
}

/**
 * Read the approvals store under `approvalsRoot`. Missing or malformed files
 * fail closed to an empty store (no skill is approved) — a corrupted approvals
 * file must never widen trust.
 */
export function readSkillApprovals(approvalsRoot?: string): SkillApprovalStore {
  if (!approvalsRoot) {
    return {};
  }

  const approvalsPath = join(approvalsRoot, SKILL_APPROVALS_RELATIVE_PATH);
  if (!existsSync(approvalsPath)) {
    return {};
  }

  try {
    const parsed = SkillApprovalsFileSchema.parse(JSON.parse(readFileSync(approvalsPath, "utf8")));
    return parsed.approvals;
  } catch {
    return {};
  }
}

export interface RecordSkillApprovalOptions {
  readonly approvalsRoot: string;
  readonly skillId: string;
  readonly contentHash: string;
  /** ISO timestamp; injectable for determinism, defaults to now. */
  readonly approvedAt?: string;
}

/**
 * Record operator approval for one skill id at one exact content hash. The
 * store is rewritten whole (the file is tiny — one record per approved skill);
 * a later content change still invalidates the grant because evaluation
 * compares the recorded hash against the current one.
 */
export function recordSkillApproval(options: RecordSkillApprovalOptions): SkillApprovalRecord {
  const record = SkillApprovalRecordSchema.parse({
    contentHash: options.contentHash,
    approvedAt: options.approvedAt ?? new Date().toISOString()
  });

  const approvalsPath = join(options.approvalsRoot, SKILL_APPROVALS_RELATIVE_PATH);
  const existing = readSkillApprovals(options.approvalsRoot);

  mkdirSync(dirname(approvalsPath), { recursive: true });
  writeFileSync(
    approvalsPath,
    `${JSON.stringify({ version: SKILL_APPROVALS_VERSION, approvals: { ...existing, [options.skillId]: record } }, null, 2)}\n`,
    "utf8"
  );

  return record;
}

function matchTrustedRoot(
  options: SkillTrustRoots & { readonly skillDirectory: string }
): { readonly tier: Exclude<SkillTrustTier, "external">; readonly root: string } | undefined {
  const skillDirectory = resolve(options.skillDirectory);

  for (const candidate of [
    { tier: "builtin" as const, root: options.bundledRoot },
    { tier: "home" as const, root: options.homeRoot },
    { tier: "project" as const, root: options.projectRoot }
  ]) {
    if (candidate.root && isPathInside(skillDirectory, candidate.root)) {
      return { tier: candidate.tier, root: resolve(candidate.root) };
    }
  }

  return undefined;
}
