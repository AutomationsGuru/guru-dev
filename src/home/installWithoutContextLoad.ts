import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { resolveGuruHomeDirectory } from "./paths.js";

// ── Schemas ───────────────────────────────────────────────────────────

/** A single plugin entry in the marketplace catalog — thin index only. */
export const MarketplacePluginSchema = z
  .object({
    id: z.string().trim().min(1),
    summary: z.string().trim().min(1)
  })
  .strict();
export type MarketplacePlugin = z.infer<typeof MarketplacePluginSchema>;

/** A marketplace registry to register into the home profile. */
export const MarketplaceRegistrySchema = z
  .object({
    name: z.string().trim().min(1),
    plugins: z.array(MarketplacePluginSchema).min(1)
  })
  .strict();
export type MarketplaceRegistry = z.infer<typeof MarketplaceRegistrySchema>;

/** Persisted marketplace state: catalog (browsable index), installed (explicitly loaded). */
export const MarketplaceStateSchema = z
  .object({
    catalog: z.array(MarketplacePluginSchema).default([]),
    installed: z.array(z.string().trim().min(1)).default([])
  })
  .strict();
export type MarketplaceState = z.infer<typeof MarketplaceStateSchema>;

// ── Options / result ──────────────────────────────────────────────────

export interface AddMarketplaceOptions {
  /** Test seam for an alternate home root. */
  readonly homeDirectory?: string;
}

export interface AddMarketplaceResult {
  /** How many plugins are now in the catalog index. */
  readonly catalogSize: number;
  /** How many plugins are marked installed (always 0 after registration). */
  readonly installedCount: number;
  /** The full state after the operation. */
  readonly state: MarketplaceState;
}

// ── Internals ─────────────────────────────────────────────────────────

export const MARKETPLACE_STATE_FILE_NAME = "marketplace.json";

function resolveMarketplaceStatePath(homeDirectory?: string): string {
  return join(resolveGuruHomeDirectory(homeDirectory), MARKETPLACE_STATE_FILE_NAME);
}

function readMarketplaceState(filePath: string): MarketplaceState {
  if (!existsSync(filePath)) {
    return MarketplaceStateSchema.parse({});
  }

  const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  return MarketplaceStateSchema.parse(raw);
}

function writeMarketplaceState(filePath: string, state: MarketplaceState): void {
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8" });
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Register a marketplace catalog in the home profile.
 *
 * Adds plugin entries to the catalog index so they can be browsed without
 * loading anything into context. **No plugin is marked installed** — the
 * caller must explicitly install individual plugins afterward.
 *
 * This is the "install without context load" guarantee (R-WSH-NLOAD):
 * marketplace registration never silently dumps plugins into the running
 * context. The catalog grows; `installed` stays empty.
 */
export function addMarketplace(
  registry: MarketplaceRegistry,
  options: AddMarketplaceOptions = {}
): AddMarketplaceResult {
  const statePath = resolveMarketplaceStatePath(options.homeDirectory);
  const current = readMarketplaceState(statePath);

  // Merge: only add plugins whose id is not already in the catalog.
  const existingIds = new Set(current.catalog.map((p) => p.id));
  const newPlugins = registry.plugins.filter((p) => !existingIds.has(p.id));

  const state: MarketplaceState = {
    catalog: [...current.catalog, ...newPlugins],
    installed: current.installed
  };

  writeMarketplaceState(statePath, state);

  return {
    catalogSize: state.catalog.length,
    installedCount: state.installed.length,
    state
  };
}
