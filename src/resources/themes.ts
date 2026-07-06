/**
 * Theme token schemas (Dev 4 — interface freeze skeleton, D4.5 impl).
 *
 * FR-13: theme selection and color tokens, with resource trust + scope rules.
 * Schemas + loader contract only; the token resolver (incl. `inherits` chaining)
 * lands in D4.5. The TUI references an active theme id via `TuiState.themeId`.
 *
 * Secret-safe: token values are color names/hex; never credential material.
 */

import { z } from "zod";

import { ResourceScopeSchema } from "./scope.js";

export const ThemeTokenSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    /** Color name or hex, e.g. "#1f1f28" or "bright-white". */
    value: z.string().trim().min(1).max(64)
  })
  .strict();
export type ThemeToken = z.infer<typeof ThemeTokenSchema>;

export const ThemeSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).max(120),
    isDark: z.boolean().default(true),
    tokens: z.array(ThemeTokenSchema).default([]),
    /** Optional parent theme id to inherit unresolved tokens from. */
    inherits: z.string().trim().min(1).max(120).optional(),
    trust: z.enum(["trusted", "untrusted"]).default("untrusted"),
    scope: ResourceScopeSchema.default("project")
  })
  .strict();
export type Theme = z.infer<typeof ThemeSchema>;

export const ThemeRegistrySchema = z
  .object({
    themes: z.array(ThemeSchema).default([]),
    activeThemeId: z.string().trim().min(1).optional()
  })
  .strict();
export type ThemeRegistry = z.infer<typeof ThemeRegistrySchema>;

/** Theme loader contract (impl in D4.5). */
export interface ThemeLoader {
  list(): Promise<Theme[]>;
  resolve(id?: string): Promise<Theme | undefined>;
}
