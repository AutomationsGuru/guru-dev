import type { FileMemoryStore } from "../memory/store.js";
import { RoleProfileSchema } from "../roles/schema.js";
import {
  GarageManifestSchema,
  partitionParkableLayers,
  roleProfileToManifest,
  type GarageManifest,
  type GarageLayer
} from "./manifest.js";

/**
 * Garage persistence (Garage Spine wave, ADR 2026-07-05-garage-spine). The
 * canonical stored suit is now a typed {@link GarageManifest}, parked as JSON
 * inside the same `loadout` memory fact roles have always used — so the memory
 * organ's atomic writes (tmp+rename) and secret-scrub gate are reused, and old
 * flat-RoleProfile facts still load (back-compat, no migration pass).
 */

export const ROLE_FACT_PREFIX = "role-";

export function factName(slug: string): string {
  return `${ROLE_FACT_PREFIX}${slug}`;
}

function verificationTally(layers: readonly GarageLayer[]): string {
  const verified = layers.filter((layer) => layer.status === "verified").length;
  const unverified = layers.filter((layer) => layer.status === "unverified").length;
  const red = layers.filter((layer) => layer.status === "red").length;
  return `${verified} verified / ${unverified} unverified / ${red} red`;
}

function renderManifestBody(manifest: GarageManifest, rejected: readonly { layer: GarageLayer; reason: string }[]): string {
  return [
    `Suit for **${manifest.label}** — worn ${manifest.wornCount} time(s) · ${manifest.layers.length} layer(s) · ${verificationTally(manifest.layers)}.`,
    "",
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
    "",
    rejected.length > 0 ? `_Rejected at park (verified-only): ${rejected.map((entry) => `${entry.layer.kind}:${entry.layer.id}`).join(", ")}._` : "",
    manifest.notes.length > 0 ? manifest.notes : "_No notes yet — they accrue as the suit is worn._"
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function extractJsonBlock(body: string): string | undefined {
  const match = /```json\n([\s\S]*?)\n```/u.exec(body);
  return match?.[1];
}

export interface ParkReceipt {
  readonly status: "parked" | "blocked";
  readonly stored: number;
  readonly rejected: number;
  readonly gaps: number;
  readonly verificationStatus: string;
  readonly rejectedLayers: readonly { readonly kind: string; readonly id: string; readonly reason: string }[];
  readonly summary: string;
}

/**
 * Park a suit as a typed manifest. Two-phase: the manifest is VALIDATED
 * (schema parse) and the verified-only precondition applied BEFORE any write —
 * a bad build or an ungated BUILT layer never touches disk; the memory store's
 * atomic rename then commits, so a torn write leaves the prior manifest intact.
 */
export function parkManifest(memory: FileMemoryStore, input: GarageManifest): ParkReceipt {
  // Phase 1 — validate the full manifest (throws before any write on a bad build).
  const validated = GarageManifestSchema.parse(input);

  // Verified-only precondition (Article 5): drop BUILT layers lacking a done packet.
  const { parkable, rejected } = partitionParkableLayers(validated.layers);
  const committed = GarageManifestSchema.parse({ ...validated, layers: parkable });

  // Phase 2 — atomic commit via the memory organ (writeAtomic = tmp+rename).
  const result = memory.remember({
    name: factName(committed.slug),
    title: `Suit: ${committed.label}`,
    description: `${committed.capabilityMode} manifest — ${committed.layers.length} layer(s), ${committed.gapRecords.length} gap(s), worn ${committed.wornCount}x`,
    body: renderManifestBody(committed, rejected),
    type: "loadout",
    edit: "replace",
    confidence: 1
  });

  return {
    status: result.status === "blocked" ? "blocked" : "parked",
    stored: committed.layers.length,
    rejected: rejected.length,
    gaps: committed.gapRecords.length,
    verificationStatus: verificationTally(committed.layers),
    rejectedLayers: rejected.map((entry) => ({ kind: entry.layer.kind, id: entry.layer.id, reason: entry.reason })),
    summary: result.summary
  };
}

/**
 * Load a suit's manifest. Back-compat: a fact holding manifest JSON parses as a
 * manifest; a legacy fact holding RoleProfile JSON converts via the adapter.
 */
export function loadManifest(memory: FileMemoryStore, slug: string, now: () => Date = () => new Date()): GarageManifest | undefined {
  const fact = memory.get(factName(slug));
  if (!fact.found || !fact.body) {
    return undefined;
  }
  const raw = extractJsonBlock(fact.body);
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed && typeof parsed === "object" && "manifestVersion" in (parsed as Record<string, unknown>)) {
    const manifest = GarageManifestSchema.safeParse(parsed);
    return manifest.success ? manifest.data : undefined;
  }
  // Legacy flat RoleProfile → typed manifest.
  const legacy = RoleProfileSchema.safeParse(parsed);
  return legacy.success ? roleProfileToManifest(legacy.data, now) : undefined;
}

export function listManifests(memory: FileMemoryStore, now: () => Date = () => new Date()): readonly GarageManifest[] {
  const manifests: GarageManifest[] = [];
  for (const entry of memory.list()) {
    if (entry.fact.type === "loadout" && entry.fact.name.startsWith(ROLE_FACT_PREFIX)) {
      const manifest = loadManifest(memory, entry.fact.name.slice(ROLE_FACT_PREFIX.length), now);
      if (manifest) {
        manifests.push(manifest);
      }
    }
  }
  return manifests;
}
