/**
 * Restore package manifest schemas (Dev 4 — interface freeze skeleton, D4.6 impl).
 *
 * FR-22 (restore, inventory, and documentation parity): GuruHarness ships a non-secret
 * restore package analogous to a reference harness's. Schemas + writer contract only; the inventory
 * generator + secret scanner land in D4.6.
 *
 * Secret-safety is structural + verified: manifests carry env-var NAMES and PATHS only,
 * and every generated manifest MUST include a `secretScan` block. The D4.6 writer must
 * refuse to emit a package whose `secretScan.leakedSecretCount > 0`.
 */

import { z } from "zod";

export const InventoryEntryKindSchema = z.enum([
  "component",
  "config",
  "connection",
  "extension",
  "tool",
  "skill",
  "prompt",
  "theme",
  "doc",
  "script"
]);
export type InventoryEntryKind = z.infer<typeof InventoryEntryKindSchema>;

export const InventoryEntryStatusSchema = z.enum(["present", "missing", "degraded", "excluded"]);
export type InventoryEntryStatus = z.infer<typeof InventoryEntryStatusSchema>;

export const InventoryEntrySchema = z
  .object({
    id: z.string().trim().min(1),
    kind: InventoryEntryKindSchema,
    /** Provenance path (never a secret). */
    path: z.string().trim().min(1).max(1024).optional(),
    status: InventoryEntryStatusSchema.default("present"),
    note: z.string().trim().min(1).max(400).optional()
  })
  .strict();
export type InventoryEntry = z.infer<typeof InventoryEntrySchema>;

/** Config summary: env var NAMES + source PATHS only (FR-21). */
export const ConfigSummarySchema = z
  .object({
    envNames: z.array(z.string().trim().min(1).max(256)).default([]),
    sourcePaths: z.array(z.string().trim().min(1).max(1024)).default([])
  })
  .strict();
export type ConfigSummary = z.infer<typeof ConfigSummarySchema>;

/** Mandatory secret-scan evidence attached to every generated manifest. */
export const SecretScanSchema = z
  .object({
    scannedAt: z.string().trim().min(1),
    scanner: z.string().trim().min(1).max(64),
    leakedSecretCount: z.number().int().min(0).default(0),
    findings: z.array(z.string().trim().min(1).max(400)).default([])
  })
  .strict();
export type SecretScan = z.infer<typeof SecretScanSchema>;

export const RestoreManifestSchema = z
  .object({
    version: z.string().trim().min(1).max(64),
    generatedAt: z.string().trim().min(1),
    harness: z.string().trim().min(1).max(120).default("GuruHarness"),
    components: z.array(InventoryEntrySchema).default([]),
    configSummary: ConfigSummarySchema.default({ envNames: [], sourcePaths: [] }),
    /** Provider/router/MCP connections: names + endpoints only, no keys. */
    connections: z.array(InventoryEntrySchema).default([]),
    skillsIndex: z.array(InventoryEntrySchema).default([]),
    toolsIndex: z.array(InventoryEntrySchema).default([]),
    secretScan: SecretScanSchema
  })
  .strict();
export type RestoreManifest = z.infer<typeof RestoreManifestSchema>;

/**
 * Restore package writer contract (impl in D4.6). `generate()` builds the manifest;
 * `write()` serializes it to disk and MUST refuse if the secret scan is non-clean.
 */
export interface RestorePackageWriter {
  generate(): Promise<RestoreManifest>;
  write(targetDir: string): Promise<RestoreManifest>;
}
