/**
 * Resource package schemas (Dev 4 — interface freeze skeleton, D4.5 impl).
 *
 * FR-13: resource packages containing extensions, skills, prompts, themes, with
 * install/remove/list/update/config workflows AND resource trust + scope rules.
 * Schemas + loader contract only; file-walking + package install lands in D4.5.
 *
 * Secret-safe: package entries reference PATHS/names only; never inline secrets.
 */

import { z } from "zod";

import { ResourceScopeSchema } from "./scope.js";

export const ResourcePackageKindSchema = z.enum(["extension", "skill", "prompt", "theme", "mixed"]);
export type ResourcePackageKind = z.infer<typeof ResourcePackageKindSchema>;

export const ResourcePackageTrustSchema = z.enum(["trusted", "untrusted"]);
export type ResourcePackageTrust = z.infer<typeof ResourcePackageTrustSchema>;

export const ResourcePackageEntrySchema = z
  .object({
    kind: ResourcePackageKindSchema,
    name: z.string().trim().min(1).max(120).optional(),
    /** Path/identifier referencing the resource (provenance; not a secret). */
    ref: z.string().trim().min(1).max(1024)
  })
  .strict();
export type ResourcePackageEntry = z.infer<typeof ResourcePackageEntrySchema>;

export const ResourcePackageSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).max(120),
    version: z.string().trim().min(1).max(64).optional(),
    description: z.string().trim().min(1).max(1000).optional(),
    kind: ResourcePackageKindSchema.default("mixed"),
    entries: z.array(ResourcePackageEntrySchema).default([]),
    trust: ResourcePackageTrustSchema.default("untrusted"),
    scope: ResourceScopeSchema.default("project"),
    sourcePath: z.string().trim().min(1).max(1024).optional()
  })
  .strict();
export type ResourcePackage = z.infer<typeof ResourcePackageSchema>;

export const ResourcePackageManifestSchema = z
  .object({
    packages: z.array(ResourcePackageSchema).default([])
  })
  .strict();
export type ResourcePackageManifest = z.infer<typeof ResourcePackageManifestSchema>;

/**
 * Package loader contract (impl in D4.5). Install/remove workflows are approval-gated
 * and must never copy secret-bearing files into a package.
 */
export interface PackageLoader {
  list(): Promise<ResourcePackage[]>;
  install(manifestPath: string): Promise<ResourcePackage>;
  remove(packageId: string): Promise<void>;
}
