import { z } from "zod";

import {
  SkillLoaderOptionsSchema,
  SkillManifestSchema,
  type SkillDocument,
  type SkillLoaderOptions,
  type SkillManifest
} from "./schemas.js";
import { discoverSkills, loadSkill } from "./loader.js";

/**
 * Progressive skill disclosure (IDEA-F401-PROG-01, requirement R-WSH-PROG).
 *
 * A skill catalog is cheap to *browse* and expensive to *carry*: each skill's full
 * body is the token cost. Progressive disclosure splits the two — the thin view a
 * model sees while deciding is just name + description (no body, no content), and
 * the full body loads exactly once, when the skill is activated, then is cached so
 * a second activation never re-reads from disk.
 *
 * The thin view's *shape* is enforced by a strict zod schema, not by convention:
 * the body/content are structurally absent, so no caller and no future edit can
 * accidentally leak the full body into the browse path. That keeps the disclosure
 * boundary real (code, not prose).
 */

/**
 * The thin view schema is `strict()` so it can *certify* a thin view's output:
 * nothing beyond id/name/description may be present. `toThinView` projects a
 * manifest down to those three keys and then `SkillThinViewSchema.parse` enforces
 * that the projection leaked no extra field — the disclosure boundary is checked
 * in code, not assumed.
 */
export const SkillThinViewSchema = SkillManifestSchema.pick({
  id: true,
  name: true,
  description: true
}).strict();
export type SkillThinView = z.infer<typeof SkillThinViewSchema>;

export const SkillThinCatalogSchema = z.array(SkillThinViewSchema);
export type SkillThinCatalog = readonly SkillThinView[];

/**
 * Project a full manifest down to the thin view and certify the projection: only
 * id + name + description survive, and the strict schema rejects anything beyond
 * that. This is the structural guarantee that the body/content/skillFile never
 * ride along on the browse path.
 */
export function toThinView(manifest: SkillManifest): SkillThinView {
  return SkillThinViewSchema.parse({
    id: manifest.id,
    name: manifest.name,
    description: manifest.description
  });
}

/**
 * The result of activating a skill: the full `SkillDocument` (manifest + content +
 * body + frontmatter) plus whether this activation was served from the cache or
 * freshly loaded from disk. `fromCache` makes the disclosure observable in tests
 * and logs without exposing any secret.
 */
export interface ActivationResult {
  readonly skill: SkillDocument;
  readonly fromCache: boolean;
}

/**
 * A progressive-disclosure controller bound to one set of loader options. The
 * per-instance cache (`Map<skillId, SkillDocument>`) means loader options stay
 * pinned to the skills they describe and two independent controllers never share a
 * cache. The cache grows only as skills are activated and never invalidates on its
 * own — a fresh controller re-derives from the filesystem, which is the cheap
 * browse path anyway.
 */
export class ProgressiveSkillDisclosure {
  private readonly options: SkillLoaderOptions;
  private readonly cache = new Map<string, SkillDocument>();

  constructor(options: Partial<SkillLoaderOptions> = {}) {
    this.options = SkillLoaderOptionsSchema.parse(options);
  }

  /**
   * Thin catalog: every discovered skill reduced to id + name + description.
   * The full body is never read or returned here — discovery itself only parses
   * frontmatter + a title/first-paragraph fallback, so the browse path stays light.
   */
  listThin(): SkillThinCatalog {
    const catalog = discoverSkills(this.options);
    return catalog.skills.map((manifest) => toThinView(manifest));
  }

  /**
   * Activate a skill: load its full document (body included) and cache it. The
   * first activation reads from disk; every later activation for the same id is
   * served from the cache (`fromCache: true`) with no filesystem read.
   *
   * Throws when the skill id is not in the catalog — activation is a deliberate
   * move against a known skill, never a silent fallthrough.
   */
  activate(skillId: string): ActivationResult {
    const cached = this.cache.get(skillId);
    if (cached) {
      return { skill: cached, fromCache: true };
    }

    const skill = loadSkill({ ...this.options, skillId });
    this.cache.set(skillId, skill);
    return { skill, fromCache: false };
  }

  /** Whether a skill's full body is already cached (activated at least once). */
  isCached(skillId: string): boolean {
    return this.cache.has(skillId);
  }

  /** The skill ids currently holding a cached full body (observability, no values). */
  cachedSkillIds(): readonly string[] {
    return [...this.cache.keys()];
  }
}
