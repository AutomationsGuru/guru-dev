import { z } from "zod";

export const SkillIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Skill id must start with an alphanumeric character and contain only letters, numbers, dots, underscores, or hyphens.");

export const SkillPathSchema = z.string().trim().min(1);

export const SkillFrontmatterSchema = z.record(z.string(), z.unknown()).default({});

/**
 * A skill is either NATIVE (guru's own) or a BRIDGE — an ATTACH-class wrapper over
 * another harness's capability (e.g. a foreign-harness skill), loaded but tracked as a parity
 * gap until promoted to native (§14/§16 bridge loading; the v1.0-bar predicate).
 */
export const SkillKindSchema = z.enum(["native", "bridge"]);
export type SkillKind = z.infer<typeof SkillKindSchema>;

export const SkillManifestSchema = z
  .object({
    id: SkillIdSchema,
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    directory: SkillPathSchema,
    skillFile: SkillPathSchema,
    allowedTools: z.array(z.string().trim().min(1)).default([]),
    /** native by default; `type: bridge` in frontmatter marks an ATTACH-class bridge skill. */
    kind: SkillKindSchema.default("native"),
    /** What a bridge skill bridges (e.g. "pi") — from the `bridges` frontmatter, optional. */
    bridges: z.string().trim().min(1).optional(),
    metadata: SkillFrontmatterSchema
  })
  .strict();
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export const SkillDocumentSchema = z
  .object({
    manifest: SkillManifestSchema,
    content: z.string().min(1),
    body: z.string(),
    frontmatter: SkillFrontmatterSchema
  })
  .strict();
export type SkillDocument = z.infer<typeof SkillDocumentSchema>;

export const SkillCatalogSchema = z
  .object({
    skills: z.array(SkillManifestSchema),
    directories: z.array(SkillPathSchema),
    diagnostics: z.array(z.string())
  })
  .strict();
export type SkillCatalog = z.infer<typeof SkillCatalogSchema>;

export const SkillLoaderOptionsSchema = z
  .object({
    directories: z.array(SkillPathSchema).default([]),
    cwd: SkillPathSchema.optional(),
    skillFileName: z.string().trim().min(1).default("SKILL.md"),
    maxDepth: z.number().int().min(0).max(8).default(4)
  })
  .strict();
export type SkillLoaderOptions = z.infer<typeof SkillLoaderOptionsSchema>;

export const LoadSkillInputSchema = z
  .object({
    skillId: SkillIdSchema
  })
  .strict();
export type LoadSkillInput = z.infer<typeof LoadSkillInputSchema>;

export const ResolveSkillReferenceInputSchema = z
  .object({
    skillId: SkillIdSchema,
    reference: z.string().trim().min(1)
  })
  .strict();
export type ResolveSkillReferenceInput = z.infer<typeof ResolveSkillReferenceInputSchema>;
