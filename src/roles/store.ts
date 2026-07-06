import type { RoleProfile } from "./schema.js";
import type { FileMemoryStore } from "../memory/store.js";
import { factName, listManifests, loadManifest, parkManifest } from "../garage/store.js";
import { manifestToRoleProfile, roleProfileToManifest } from "../garage/manifest.js";

/**
 * Role persistence — now a thin RoleProfile-facing adapter over the typed
 * garage manifest (Garage Spine wave, ADR 2026-07-05-garage-spine). The
 * canonical stored form is a GarageManifest (see src/garage/); these helpers
 * keep the existing RoleProfile-based consumers (suit assembly, resolver
 * context, boot memory) working while the persistence + verification live in
 * the garage. Old flat-RoleProfile facts still load (back-compat in the loader).
 */

/** Days since the suit was last parked (from the fact's updatedAt), or undefined. */
export function roleAgeDays(memory: FileMemoryStore, slug: string, now: () => Date = () => new Date()): number | undefined {
  const fact = memory.get(factName(slug));
  if (!fact.found || !fact.fact) {
    return undefined;
  }
  const parked = Date.parse(fact.fact.updatedAt);
  return Number.isFinite(parked) ? Math.max(0, Math.floor((now().getTime() - parked) / 86_400_000)) : undefined;
}

/** Garage staleness threshold: parked layers older than this re-verify before load. */
export const ROLE_STALE_AFTER_DAYS = 14;

/**
 * Records a path-outcome for a suited session (garage learning): what route/
 * tools a worn suit actually used, appended to a per-role `path-outcome` fact —
 * the food the look-ahead engine eats later (which paths win, per role).
 */
export function recordPathOutcome(
  memory: FileMemoryStore,
  slug: string,
  outcome: { readonly routeId: string; readonly turns: number; readonly toolsUsed: readonly string[] }
): string {
  const line = `- ${new Date().toISOString().slice(0, 10)}: route ${outcome.routeId} · ${outcome.turns} turn(s) · tools: ${outcome.toolsUsed.length > 0 ? outcome.toolsUsed.join(", ") : "none"}`;
  const result = memory.remember({
    name: `path-outcomes-${slug}`,
    title: `Path outcomes: ${slug}`,
    description: `What worked for the ${slug} suit, session by session (garage learning)`,
    body: line,
    type: "path-outcome",
    edit: "append",
    confidence: 1
  });
  return result.summary;
}

/** Load a suit as a RoleProfile (down-projected from its manifest; red layers dropped). */
export function loadRole(memory: FileMemoryStore, slug: string): RoleProfile | undefined {
  const manifest = loadManifest(memory, slug);
  return manifest ? manifestToRoleProfile(manifest) : undefined;
}

export function listRoles(memory: FileMemoryStore): readonly RoleProfile[] {
  return listManifests(memory).map((manifest) => manifestToRoleProfile(manifest));
}

/** Park a RoleProfile by migrating it onto the typed manifest. Returns the write summary. */
export function parkRole(memory: FileMemoryStore, profile: RoleProfile): string {
  return parkManifest(memory, roleProfileToManifest(profile)).summary;
}
