import { z } from "zod";

/**
 * Plugin bundle manifest schema (IDEA-F111-PLUGIN-BUNDLES-01). A bundle is a
 * versioned, self-contained manifest grouping skills, slash recipes, hooks, and
 * specialist agent defs so they validate and install into a home/project
 * overlay as one unit. The manifest carries entry CONTENT inline (no remote
 * download, no marketplace); install planning and application live in
 * `pluginBundle.ts`.
 */

export const PLUGIN_BUNDLE_MANIFEST_VERSION = 1;

/** Bundle ids double as safe path-ish slugs. */
const BundleIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "id must be a lowercase slug: /^[a-z0-9][a-z0-9._-]*$/");

/** Light semver-ish check: N.N.N with an optional -prerelease/+build suffix. */
const BundleVersionSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "version must be semver-ish: ^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$");

/**
 * A relative destination path within a bundle category dir. Forward slashes
 * only; no absolute paths, no drive letters, no `..` traversal, no empty or
 * `.` segments.
 */
export const BundleEntryPathSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, ctx) => {
    if (/^[a-zA-Z]:/.test(value) || value.startsWith("/") || value.startsWith("\\\\")) {
      ctx.addIssue({ code: "custom", message: "entry path must be relative (no absolute paths or drive letters)" });
      return;
    }
    if (value.includes("\\")) {
      ctx.addIssue({ code: "custom", message: "entry path must use forward slashes only (no backslashes)" });
      return;
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      ctx.addIssue({ code: "custom", message: "entry path may not contain empty, '.', or '..' segments" });
    }
  });
export type BundleEntryPath = z.infer<typeof BundleEntryPathSchema>;

/** One file of bundle payload: a relative target path plus its full content. */
export const PluginBundleEntrySchema = z
  .object({
    path: BundleEntryPathSchema,
    content: z.string()
  })
  .strict();
export type PluginBundleEntry = z.infer<typeof PluginBundleEntrySchema>;

export const PluginBundleSchema = z
  .object({
    id: BundleIdSchema,
    version: BundleVersionSchema,
    schemaVersion: z.literal(PLUGIN_BUNDLE_MANIFEST_VERSION),
    description: z.string().optional(),
    skills: z.array(PluginBundleEntrySchema).default([]),
    hooks: z.array(PluginBundleEntrySchema).default([]),
    commands: z.array(PluginBundleEntrySchema).default([]),
    specialists: z.array(PluginBundleEntrySchema).default([])
  })
  .strict();
export type PluginBundle = z.infer<typeof PluginBundleSchema>;
