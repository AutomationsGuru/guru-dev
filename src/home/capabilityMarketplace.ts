import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

/**
 * Capability marketplace — selective install (IDEA-F400-MKT-01).
 *
 * A THIN catalog describes capabilities the harness could add; `install` marks a
 * capability as installed against the home profile; `loadContext` returns ONLY the
 * context contributions of installed capabilities. Uninstalled entries never reach
 * the active context. This keeps the kernel small (§1.2): capability is opted into
 * through an explicit operator action rather than baked in, and a missing capability
 * remains a visible three-door decision (§1.4) instead of a silent dependency.
 *
 * The catalog is intentionally descriptive metadata only — id, name, description, a
 * BUILD/ATTACH/LEARN hint, and the context payload it contributes when installed.
 * It performs no network calls, no downloads, and no spend. "Installing" a catalog
 * entry records intent + the context it should surface; the actual capability is
 * realized elsewhere (native extension, ATTACH adapter, or a learned skill) and is
 * tracked there as the parity gap. This file is the registry of *what is on*.
 */

/** Plugin id grammar matches the broader skill id grammar for cross-registry consistency. */
export const CapabilityPluginIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Plugin id must start alphanumeric and contain only letters, numbers, dots, underscores, or hyphens.");

/**
 * The three-door resolver (§1.4). Catalog entries declare the move they would
 * resolve to, so the operator can see at install time whether they are BUILDing,
 * ATTACHing, or LEARNing — never a silent dependency.
 */
export const CapabilityMoveSchema = z.enum(["build", "attach", "learn"]);
export type CapabilityMove = z.infer<typeof CapabilityMoveSchema>;

/** A single context contribution an installed capability injects into loadContext. */
export const CapabilityContextEntrySchema = z
  .object({
    /** Free-form key the consuming loop uses to route the contribution (e.g. "skill", "tool", "prompt"). */
    kind: z.string().trim().min(1),
    /** The value contributed — a path, a tool id, a prompt fragment, etc. */
    value: z.string().trim().min(1)
  })
  .strict();
export type CapabilityContextEntry = z.infer<typeof CapabilityContextEntrySchema>;

/** One thin catalog entry: descriptive only, never executable on its own. */
export const CapabilityPluginSchema = z
  .object({
    id: CapabilityPluginIdSchema,
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    /** The three-door move this capability resolves to when installed. */
    move: CapabilityMoveSchema,
    /** Context entries contributed to loadContext when installed. */
    context: z.array(CapabilityContextEntrySchema).default([])
  })
  .strict();
export type CapabilityPlugin = z.infer<typeof CapabilityPluginSchema>;

/** Persisted record of an installed plugin. */
export const InstalledPluginSchema = CapabilityPluginSchema.extend({
  /** ISO timestamp the plugin was marked installed. */
  installedAt: z.string().trim().min(1)
}).strict();
export type InstalledPlugin = z.infer<typeof InstalledPluginSchema>;

/** The full persisted state document, versioned for forward migration. */
const InstalledStateSchema = z
  .object({
    version: z.literal(1),
    plugins: z.array(InstalledPluginSchema).default([])
  })
  .strict();

const MARKETPLACE_SUBDIRECTORY = "marketplace";
const INSTALLED_STATE_FILE = "installed.json";
const EMPTY_STATE = { version: 1 as const, plugins: [] };

/**
 * The thin default catalog. Deliberately short — breadth belongs at the extension,
 * tool, skill, provider, role, or project-harness layer (§1.2), not in a fat
 * marketplace catalog. New entries are added by editing this list (or by passing a
 * custom catalog into the store).
 */
export const DEFAULT_CAPABILITY_CATALOG: readonly CapabilityPlugin[] = [
  {
    id: "repo-skill",
    name: "Repo skills",
    description: "Surface project-owned skills from the .guru overlay into the active context.",
    move: "build",
    context: [{ kind: "skillDirectory", value: "./.guru/skills" }]
  },
  {
    id: "memory-inject",
    name: "Boot memory inject",
    description: "Inject resolved Markdown memory facts at boot.",
    move: "build",
    context: [{ kind: "bootBlock", value: "memory/inject" }]
  }
];

export interface CapabilityMarketplaceOptions {
  /** Test seam / portable-install override. Defaults to ~/.guruharness. */
  readonly homeDirectory?: string;
  /** Catalog override (tests, custom registries). Defaults to the thin catalog above. */
  readonly catalog?: readonly CapabilityPlugin[];
  /** Injected clock for deterministic installedAt timestamps in tests. */
  readonly now?: () => Date;
}

export interface CapabilityMarketplaceStore {
  readonly homeDirectory: string;
  readonly installedStatePath: string;
  /** The catalog this store resolves ids against (frozen at construction). */
  readonly catalog: readonly CapabilityPlugin[];
  listCatalog(): readonly CapabilityPlugin[];
  listInstalled(): readonly InstalledPlugin[];
  isInstalled(pluginId: string): boolean;
  install(pluginId: string): InstallResult;
  uninstall(pluginId: string): UninstallResult;
  /** Context contributions from installed plugins only. */
  loadContext(): LoadedContext;
}

export type InstallStatus = "installed" | "already-installed" | "unknown-plugin";

export interface InstallResult {
  readonly status: InstallStatus;
  readonly plugin?: InstalledPlugin;
}

export type UninstallStatus = "uninstalled" | "not-installed";

export interface UninstallResult {
  readonly status: UninstallStatus;
  readonly pluginId: string;
}

export interface LoadedContext {
  /** Flat, ordered context entries from installed plugins (catalog order). */
  readonly entries: readonly CapabilityContextEntry[];
  /** Plugin ids that contributed entries, in order. */
  readonly contributors: readonly string[];
}

/** Resolve the marketplace directory under a home profile without creating it. */
export function resolveMarketplaceDirectory(homeDirectory?: string): string {
  return join(resolve(homeDirectory ?? join(homedir(), ".guruharness")), MARKETPLACE_SUBDIRECTORY);
}

export function createCapabilityMarketplace(options: CapabilityMarketplaceOptions = {}): CapabilityMarketplaceStore {
  const homeDirectory = resolve(options.homeDirectory ?? join(homedir(), ".guruharness"));
  const catalog = freezeCatalog(options.catalog ?? DEFAULT_CAPABILITY_CATALOG);
  const installedStatePath = join(homeDirectory, MARKETPLACE_SUBDIRECTORY, INSTALLED_STATE_FILE);
  const now = options.now ?? (() => new Date());

  return {
    homeDirectory,
    installedStatePath,
    catalog,

    listCatalog() {
      return catalog;
    },

    listInstalled() {
      return readInstalledState(installedStatePath).plugins;
    },

    isInstalled(pluginId) {
      return readInstalledState(installedStatePath).plugins.some((plugin) => plugin.id === pluginId);
    },

    install(pluginId) {
      const plugin = catalog.find((entry) => entry.id === pluginId);
      if (!plugin) {
        return { status: "unknown-plugin" };
      }

      const state = readInstalledState(installedStatePath);
      if (state.plugins.some((existing) => existing.id === pluginId)) {
        return { status: "already-installed" };
      }

      const installed: InstalledPlugin = { ...plugin, installedAt: now().toISOString() };
      const nextState = { ...state, plugins: [...state.plugins, installed] };
      writeInstalledState(installedStatePath, nextState);
      return { status: "installed", plugin: installed };
    },

    uninstall(pluginId) {
      const state = readInstalledState(installedStatePath);
      if (!state.plugins.some((existing) => existing.id === pluginId)) {
        return { status: "not-installed", pluginId };
      }
      const nextState = { ...state, plugins: state.plugins.filter((existing) => existing.id !== pluginId) };
      writeInstalledState(installedStatePath, nextState);
      return { status: "uninstalled", pluginId };
    },

    loadContext() {
      const installed = readInstalledState(installedStatePath).plugins;
      // Catalog order is authoritative so context is stable regardless of install order.
      const installedById = new Map(installed.map((plugin) => [plugin.id, plugin]));
      const entries: CapabilityContextEntry[] = [];
      const contributors: string[] = [];
      for (const entry of catalog) {
        if (!installedById.has(entry.id)) {
          continue;
        }
        for (const contextEntry of entry.context) {
          entries.push(contextEntry);
        }
        contributors.push(entry.id);
      }
      return { entries, contributors };
    }
  };
}

/** Validate and freeze a caller-provided catalog; default catalog is already valid. */
function freezeCatalog(catalog: readonly CapabilityPlugin[]): readonly CapabilityPlugin[] {
  const parsed = z.array(CapabilityPluginSchema).parse(catalog);
  const ids = new Set<string>();
  for (const plugin of parsed) {
    if (ids.has(plugin.id)) {
      throw new Error(`Duplicate capability plugin id in catalog: ${plugin.id}`);
    }
    ids.add(plugin.id);
  }
  return parsed;
}

function readInstalledState(path: string): z.infer<typeof InstalledStateSchema> {
  if (!existsSync(path)) {
    return { version: 1, plugins: [] };
  }
  const rawText = readFileSync(path, "utf8");
  // Tolerate a UTF-8 BOM (the Windows Notepad default) the same way config load does.
  const rawJson = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
  const parsed = InstalledStateSchema.safeParse(JSON.parse(rawJson) as unknown);
  if (!parsed.success) {
    // A corrupt install state must never silently enrich context with garbage.
    throw new Error(`Capability marketplace installed state at ${path} failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

function writeInstalledState(path: string, state: z.infer<typeof InstalledStateSchema>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8" });
}

export { EMPTY_STATE };
