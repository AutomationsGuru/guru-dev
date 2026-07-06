import { createHash } from "node:crypto";

import { z } from "zod";

import {
  ROLE_CORE_FLOOR,
  ROLE_READ_ONLY_FLOOR,
  RoleCapabilityModeSchema,
  RoleModelPreferenceSchema,
  RoleSlugSchema,
  type RoleProfile
} from "../roles/schema.js";

/**
 * The typed garage manifest (Garage Spine wave, ADR 2026-07-05-garage-spine,
 * THERE v2 §8 + §2.5 Article 5). A suit stops being flat string arrays and
 * becomes a set of typed LAYERS, each carrying Article-5 verification metadata
 * (hash, covering-tests ref, status, stale flag). This is the schema keystone
 * the audit named — atomic park, re-verify-before-load, red-layer skip, and the
 * v0.16 gap-record triggers all hang off this type.
 */

export const GARAGE_MANIFEST_VERSION = 1;

export const LAYER_KINDS = ["extension", "tool", "provider", "skill", "command"] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];

/** How a layer came to be in the suit — gates whether it may park (Article 5). */
export const LayerProvenanceSchema = z.enum(["floor", "observed", "built", "declared"]);
export type LayerProvenance = z.infer<typeof LayerProvenanceSchema>;

/** verified = passed its check; unverified = never checked; red = a re-verify FAILED. */
export const LayerStatusSchema = z.enum(["verified", "unverified", "red"]);
export type LayerStatus = z.infer<typeof LayerStatusSchema>;

/**
 * A stubbed gap record (THERE §6/§8/§11). v0.16 fills the machine-evaluable
 * trigger + the boot re-evaluation; here it is an inert typed slot so the
 * manifest shape is stable and park/load can carry it.
 */
export const GapRecordSchema = z
  .object({
    id: z.string().trim().min(1),
    capability: z.string().trim().min(1),
    move: z.enum(["build", "attach", "learn", "depend"]),
    note: z.string().default(""),
    /** v0.16: a machine-evaluable condition re-checked each boot. Opaque string for now. */
    trigger: z.string().default(""),
    createdAt: z.string().trim().min(1)
  })
  .strict();
export type GapRecord = z.infer<typeof GapRecordSchema>;

const layerBase = {
  /** The layer's identity within its kind (tool id, skill id, provider id, …). */
  id: z.string().trim().min(1),
  /** Content hash of the layer's identity — a mismatch means it changed → re-verify. */
  verificationHash: z.string().default(""),
  /** The check that verifies this layer (a command, or a presence-probe token). */
  coveringTestsRef: z.string().default(""),
  status: LayerStatusSchema.default("unverified"),
  provenance: LayerProvenanceSchema.default("declared"),
  staleFlag: z.boolean().default(false),
  lastVerifiedAt: z.string().nullable().default(null),
  /** Set when provenance="built": the done packet that gated the BUILD (Article 5). */
  donePacketRef: z.string().default("")
};

export const ToolLayerSchema = z.object({ kind: z.literal("tool"), ...layerBase }).strict();
export const SkillLayerSchema = z.object({ kind: z.literal("skill"), ...layerBase }).strict();
export const ExtensionLayerSchema = z.object({ kind: z.literal("extension"), ...layerBase }).strict();
export const ProviderLayerSchema = z.object({ kind: z.literal("provider"), ...layerBase }).strict();
export const CommandLayerSchema = z.object({ kind: z.literal("command"), ...layerBase }).strict();

export const GarageLayerSchema = z.discriminatedUnion("kind", [
  ToolLayerSchema,
  SkillLayerSchema,
  ExtensionLayerSchema,
  ProviderLayerSchema,
  CommandLayerSchema
]);
export type GarageLayer = z.infer<typeof GarageLayerSchema>;

export const GarageManifestSchema = z
  .object({
    manifestVersion: z.number().int().positive(),
    slug: RoleSlugSchema,
    label: z.string().trim().min(1).max(80),
    capabilityMode: RoleCapabilityModeSchema.default("all"),
    layers: z.array(GarageLayerSchema).default([]),
    modelPreference: RoleModelPreferenceSchema.default({ requires: ["chat", "tools"] }),
    gapRecords: z.array(GapRecordSchema).default([]),
    wornCount: z.number().int().nonnegative().default(0),
    lastWornAt: z.string().nullable().default(null),
    /** Boot session number when last strapped on (§4 Phase 2: "last worn N sessions ago"). */
    lastWornSession: z.number().int().nonnegative().nullable().default(null),
    notes: z.string().max(2000).default("")
  })
  .strict();
export type GarageManifest = z.infer<typeof GarageManifestSchema>;

/** Deterministic content hash of a layer's identity (kind + id + covering ref). */
export function computeLayerHash(layer: Pick<GarageLayer, "kind" | "id" | "coveringTestsRef">): string {
  return createHash("sha256").update(`${layer.kind} ${layer.id} ${layer.coveringTestsRef}`).digest("hex").slice(0, 16);
}

const FLOOR_IDS = new Set<string>([...ROLE_CORE_FLOOR, ...ROLE_READ_ONLY_FLOOR]);

/**
 * Migrate a flat RoleProfile onto the typed manifest. tools/skills/extensions/
 * mcpServers become layers of their kind; verifiedTools become tool layers with
 * provenance "observed" + status "verified" (verified-by-use). The core floor is
 * not enumerated (it is implicit in assembly).
 */
export function roleProfileToManifest(profile: RoleProfile, now: () => Date = () => new Date()): GarageManifest {
  const verified = new Set(profile.verifiedTools);
  const layers: GarageLayer[] = [];
  const seenTool = new Set<string>();
  const stamp = now().toISOString();

  const toolLayer = (id: string, observed: boolean): GarageLayer => ({
    kind: "tool",
    id,
    coveringTestsRef: "presence",
    verificationHash: computeLayerHash({ kind: "tool", id, coveringTestsRef: "presence" }),
    status: observed ? "verified" : "unverified",
    provenance: observed ? "observed" : "declared",
    staleFlag: false,
    lastVerifiedAt: observed ? stamp : null,
    donePacketRef: ""
  });

  for (const id of [...profile.tools, ...profile.verifiedTools]) {
    if (FLOOR_IDS.has(id) || seenTool.has(id)) {
      continue;
    }
    seenTool.add(id);
    layers.push(toolLayer(id, verified.has(id)));
  }
  const simpleLayer = (kind: LayerKind, id: string): GarageLayer => ({
    kind,
    id,
    coveringTestsRef: "presence",
    verificationHash: computeLayerHash({ kind, id, coveringTestsRef: "presence" }),
    status: "unverified",
    provenance: "declared",
    staleFlag: false,
    lastVerifiedAt: null,
    donePacketRef: ""
  });
  for (const id of profile.skills) layers.push(simpleLayer("skill", id));
  for (const id of profile.extensions) layers.push(simpleLayer("extension", id));
  for (const id of profile.mcpServers) layers.push(simpleLayer("provider", id));

  return GarageManifestSchema.parse({
    manifestVersion: GARAGE_MANIFEST_VERSION,
    slug: profile.slug,
    label: profile.label,
    capabilityMode: profile.capabilityMode,
    layers,
    modelPreference: profile.modelPreference,
    gapRecords: [],
    wornCount: profile.wornCount,
    lastWornAt: null,
    notes: profile.notes
  });
}

/**
 * Down-project a manifest to a RoleProfile for the existing consumers. RED
 * layers are dropped (never offered); tool layers with status "verified" feed
 * verifiedTools, the rest feed tools.
 */
export function manifestToRoleProfile(manifest: GarageManifest): RoleProfile {
  const live = manifest.layers.filter((layer) => layer.status !== "red");
  const tools: string[] = [];
  const verifiedTools: string[] = [];
  const skills: string[] = [];
  const extensions: string[] = [];
  const mcpServers: string[] = [];
  for (const layer of live) {
    if (layer.kind === "tool") {
      (layer.status === "verified" ? verifiedTools : tools).push(layer.id);
    } else if (layer.kind === "skill") {
      skills.push(layer.id);
    } else if (layer.kind === "extension") {
      extensions.push(layer.id);
    } else if (layer.kind === "provider") {
      mcpServers.push(layer.id);
    }
  }
  return {
    slug: manifest.slug,
    label: manifest.label,
    capabilityMode: manifest.capabilityMode,
    tools,
    skills,
    extensions,
    mcpServers,
    modelPreference: manifest.modelPreference,
    verifiedTools,
    wornCount: manifest.wornCount,
    notes: manifest.notes
  };
}

export interface ParkPreconditionResult {
  readonly parkable: GarageLayer[];
  readonly rejected: { readonly layer: GarageLayer; readonly reason: string }[];
}

/**
 * Verified-only park precondition (Article 5): a layer BUILT by the resolver
 * must carry its done packet reference to park. Observed / floor / declared
 * layers park freely (observed = verified-by-use). Returns the parkable set +
 * the rejected set (with reasons) for the receipt.
 */
export function partitionParkableLayers(layers: readonly GarageLayer[]): ParkPreconditionResult {
  const parkable: GarageLayer[] = [];
  const rejected: { layer: GarageLayer; reason: string }[] = [];
  for (const layer of layers) {
    if (layer.provenance === "built" && layer.donePacketRef.trim().length === 0) {
      rejected.push({ layer, reason: "BUILT layer lacks its done packet — the garage refuses ungated capability" });
      continue;
    }
    parkable.push(layer);
  }
  return { parkable, rejected };
}

export interface ReverifyDeps {
  readonly now: () => Date;
  /** Age in days beyond which a layer must re-verify before loading. */
  readonly staleAfterDays: number;
  /** Presence/covering-test probe: true = still good, false = red (skip). */
  readonly verifyLayer: (layer: GarageLayer) => boolean;
}

export interface ReverifyResult {
  readonly manifest: GarageManifest;
  readonly loaded: number;
  readonly reverified: number;
  readonly skippedRed: GarageLayer[];
  readonly fastPath: boolean;
}

function isStale(layer: GarageLayer, deps: ReverifyDeps): boolean {
  if (layer.staleFlag) {
    return true;
  }
  if (!layer.lastVerifiedAt) {
    return true;
  }
  const verifiedAt = Date.parse(layer.lastVerifiedAt);
  if (!Number.isFinite(verifiedAt)) {
    return true;
  }
  const ageDays = (deps.now().getTime() - verifiedAt) / 86_400_000;
  return ageDays > deps.staleAfterDays;
}

/**
 * Re-verify-before-load (§8): a layer that is already verified, fresh, and
 * hash-matched loads on the ungated FAST PATH. A stale / hash-mismatched /
 * unverified layer runs its verify probe first — pass refreshes it, fail marks
 * it RED and it is skipped (never loaded). Returns the reconciled manifest.
 */
export function reverifyForLoad(manifest: GarageManifest, deps: ReverifyDeps): ReverifyResult {
  const stamp = deps.now().toISOString();
  const skippedRed: GarageLayer[] = [];
  let reverified = 0;
  let loaded = 0;

  const layers = manifest.layers.map((layer): GarageLayer => {
    const hashMatches = layer.verificationHash === computeLayerHash(layer);
    // status !== "verified" already covers "red" and "unverified".
    const needsReverify = layer.status !== "verified" || !hashMatches || isStale(layer, deps);
    if (!needsReverify) {
      loaded += 1;
      return layer;
    }
    reverified += 1;
    const ok = deps.verifyLayer(layer);
    if (!ok) {
      skippedRed.push(layer);
      return { ...layer, status: "red", staleFlag: false };
    }
    loaded += 1;
    return {
      ...layer,
      status: "verified",
      staleFlag: false,
      lastVerifiedAt: stamp,
      verificationHash: computeLayerHash(layer)
    };
  });

  return {
    manifest: { ...manifest, layers },
    loaded,
    reverified,
    skippedRed,
    fastPath: reverified === 0
  };
}
