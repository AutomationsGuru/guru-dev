import { z } from "zod";

export const ProjectHarnessAssetKindSchema = z.enum(["skills", "garage", "tools"]);
export type ProjectHarnessAssetKind = z.infer<typeof ProjectHarnessAssetKindSchema>;

export const ProjectHarnessAssetLinkSchema = z
  .object({
    kind: ProjectHarnessAssetKindSchema,
    sourcePath: z.string().trim().min(1),
    linkPath: z.string().trim().min(1),
    status: z.enum(["linked", "unavailable", "conflict"]),
    linkType: z.enum(["symbolic-link", "junction"]).optional(),
    diagnostic: z.string().trim().min(1).optional()
  })
  .strict();
export type ProjectHarnessAssetLink = z.infer<typeof ProjectHarnessAssetLinkSchema>;

export const ProjectHarnessManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectRoot: z.string().trim().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    configuration: z
      .object({
        path: z.string().trim().min(1),
        status: z.enum(["created", "existing"]),
        source: z.enum(["home-default", "fallback-default"])
      })
      .strict(),
    directories: z.array(z.string().trim().min(1)),
    assetLinks: z.array(ProjectHarnessAssetLinkSchema),
    toolIds: z.array(z.string().trim().min(1)),
    skillIds: z.array(z.string().trim().min(1)),
    diagnostics: z.array(z.string())
  })
  .strict();
export type ProjectHarnessManifest = z.infer<typeof ProjectHarnessManifestSchema>;

export const ProjectHarnessReportSchema = z
  .object({
    status: z.enum(["ready", "degraded"]),
    projectRoot: z.string().trim().min(1),
    directory: z.string().trim().min(1),
    manifestPath: z.string().trim().min(1),
    configPath: z.string().trim().min(1),
    assetLinks: z.array(ProjectHarnessAssetLinkSchema),
    diagnostics: z.array(z.string()),
    summary: z.string().trim().min(1),
    nextActions: z.array(z.string()),
    manifest: ProjectHarnessManifestSchema.optional()
  })
  .strict();
export type ProjectHarnessReport = z.infer<typeof ProjectHarnessReportSchema>;
