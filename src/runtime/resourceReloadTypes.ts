import { z } from "zod";

import type { SkillCatalog, SkillLoaderOptions } from "../skills/schemas.js";
import type { ThemeTokens } from "../tui/theme.js";
import type { ExtensionHost } from "../extensions/host.js";

/**
 * Resource reload targets for the unified /reload command.
 *
 * The reload seam is intentionally narrow: skills, theme, and extension
 * registrations. It does NOT reload the harness runtime, session, or policy
 * without explicit re-initialization.
 */
export const ResourceReloadTargetSchema = z.enum(["skills", "theme", "extensions"]);
export type ResourceReloadTarget = z.infer<typeof ResourceReloadTargetSchema>;

export interface ResourceReloadSummary {
  readonly target: ResourceReloadTarget;
  /**
   * Whether the reload completed and produced fresh state.
   * A target may fail closed (false) rather than leave stale state in place.
   */
  readonly ok: boolean;
  /** Human-readable summary suitable for TUI/RPC status. */
  readonly message: string;
  /**
   * Target-specific count: skills count, theme token count, or extension
   * tool/command/route counts.
   */
  readonly count: number;
  /**
   * Extra target-specific diagnostics (duplicate ids, missing directories,
   * invalid theme files, etc.).
   */
  readonly diagnostics: readonly string[];
}

export interface ResourceReloadResult {
  /** One summary per requested target, in input order. */
  readonly summaries: readonly ResourceReloadSummary[];
  /** True when every requested target reported ok. */
  readonly ok: boolean;
}

export interface ResourceReloadContext {
  /** Skill discovery options (directories, cwd, file name, max depth). */
  readonly skillLoaderOptions?: Partial<SkillLoaderOptions>;
  /** Theme file path; defaults to ~/.guruharness/theme.json when omitted. */
  readonly themeFilePath?: string;
  /**
   * Extension host seam. When provided, extension reload calls start() to
   * rebuild registrations from a clean slate.
   */
  readonly extensionHost?: ExtensionHost;
}

/** A reloaded theme snapshot: tokens, source, and any diagnostic. */
export interface ResourceReloadThemeSnapshot {
  readonly tokens: ThemeTokens;
  readonly name: string;
  readonly source: "file" | "defaults";
  readonly diagnostics: readonly string[];
}

/** A reloaded skills snapshot: catalog and any diagnostic. */
export interface ResourceReloadSkillsSnapshot {
  readonly catalog: SkillCatalog;
  readonly diagnostics: readonly string[];
}

/** A reloaded extensions snapshot: counts of live registrations. */
export interface ResourceReloadExtensionsSnapshot {
  readonly commands: number;
  readonly routes: number;
  readonly toolFactories: number;
  readonly diagnostics: readonly string[];
}
