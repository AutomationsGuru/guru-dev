import { z } from "zod";

import type { SkillCatalog, SkillManifest } from "./schemas.js";

/**
 * Skill promotion stages (zagens review K4 — the "draft→promote safe skill flywheel").
 *
 * A skill is either `draft` or `promoted`. Only `promoted` skills auto-load into the
 * session catalog; drafts are discoverable (listed, loadable by id) but excluded from
 * auto-injection until an operator promotes them.
 *
 * This module is the *manifest-side* stage resolver: it reads the stage from the
 * skill's own frontmatter metadata (`stage: draft|promoted`), defaulting to `promoted`
 * when unset so existing skills keep loading. It is deliberately disjoint from the
 * garage-side stage store (`src/garage/skillPromotionStages.ts`, F164), which owns
 * operator-controlled promotion state; a session catalog filter composes the two by
 * ANDing them (manifest-promoted AND store-promoted).
 *
 * No auto-promote: this module never writes a stage. Promotion is an operator act.
 */

export const SkillStageSchema = z.enum(["draft", "promoted"]);
export type SkillStage = z.infer<typeof SkillStageSchema>;

/**
 * The stage of one skill, resolved from its manifest metadata.
 *
 * Reads `metadata.stage` (the skill file's frontmatter `stage:` key):
 * - `"draft"` → draft (excluded from auto-load)
 * - `"promoted"` or unset / any other value → promoted (existing behavior preserved)
 *
 * The fallback is `promoted` on purpose: skills written before stages existed must
 * keep auto-loading; opting into draft is explicit.
 */
export function stageOf(skill: SkillManifest): SkillStage {
  const raw = skill.metadata["stage"];

  if (typeof raw !== "string") {
    return "promoted";
  }

  const parsed = SkillStageSchema.safeParse(raw.trim().toLowerCase());

  return parsed.success ? parsed.data : "promoted";
}

/** True when the skill auto-loads into the session catalog (stage === "promoted"). */
export function isAutoLoad(skill: SkillManifest): boolean {
  return stageOf(skill) === "promoted";
}

/** The skills in a catalog that auto-load into the session (promoted only), id-sorted as the catalog is. */
export function listAutoLoad(catalog: SkillCatalog): SkillManifest[] {
  return catalog.skills.filter(isAutoLoad);
}

/** The skills in a catalog held back as drafts (do not auto-load), id-sorted as the catalog is. */
export function listDrafts(catalog: SkillCatalog): SkillManifest[] {
  return catalog.skills.filter((skill) => stageOf(skill) === "draft");
}
