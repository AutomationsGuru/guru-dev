import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureGuruHome } from '../../src/home/paths.js';
import {
  addMarketplace,
  MarketplaceRegistrySchema,
  MarketplacePluginSchema,
  MarketplaceStateSchema,
  MARKETPLACE_STATE_FILE_NAME,
  type MarketplaceRegistry,
  type MarketplaceState
} from '../../src/home/installWithoutContextLoad.js';

// ── Helpers ───────────────────────────────────────────────────────────

function setupTempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "guruharness-mkt-"));
  ensureGuruHome({ homeDirectory: root });
  return root;
}

function readPersistedState(homeRoot: string): MarketplaceState {
  const path = join(homeRoot, MARKETPLACE_STATE_FILE_NAME);
  return MarketplaceStateSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

const SAMPLE_REGISTRY: MarketplaceRegistry = MarketplaceRegistrySchema.parse({
  name: "community-tools",
  plugins: [
    { id: "shell-linter", summary: "Shell script linting via shellcheck" },
    { id: "git-helpers", summary: "Git workflow automation helpers" },
    { id: "web-fetch", summary: "Fetch and parse web pages" }
  ]
});

const SECOND_REGISTRY: MarketplaceRegistry = MarketplaceRegistrySchema.parse({
  name: "security-pack",
  plugins: [
    { id: "secret-scanner", summary: "Scan code for leaked secrets" },
    { id: "git-helpers", summary: "Git workflow automation helpers (overlap)" }
  ]
});

// ── Schema tests ──────────────────────────────────────────────────────

describe("MarketplacePluginSchema", () => {
  it("accepts a valid plugin entry", () => {
    const parsed = MarketplacePluginSchema.parse({ id: "web-fetch", summary: "Fetch and parse web pages" });
    expect(parsed).toEqual({ id: "web-fetch", summary: "Fetch and parse web pages" });
  });

  it("rejects an empty id", () => {
    expect(() => MarketplacePluginSchema.parse({ id: "", summary: "Some tool" })).toThrow();
  });

  it("rejects an empty summary", () => {
    expect(() => MarketplacePluginSchema.parse({ id: "tool-1", summary: "" })).toThrow();
  });

  it("rejects extra properties (strict)", () => {
    expect(() => MarketplacePluginSchema.parse({ id: "tool-1", summary: "desc", extra: true })).toThrow();
  });
});

describe("MarketplaceRegistrySchema", () => {
  it("accepts a valid registry with at least one plugin", () => {
    const parsed = MarketplaceRegistrySchema.parse(SAMPLE_REGISTRY);
    expect(parsed.name).toBe("community-tools");
    expect(parsed.plugins).toHaveLength(3);
  });

  it("rejects an empty name", () => {
    expect(() =>
      MarketplaceRegistrySchema.parse({ name: "", plugins: [{ id: "a", summary: "b" }] })
    ).toThrow();
  });

  it("rejects an empty plugins array", () => {
    expect(() =>
      MarketplaceRegistrySchema.parse({ name: "empty", plugins: [] })
    ).toThrow();
  });

  it("rejects extra properties (strict)", () => {
    expect(() =>
      MarketplaceRegistrySchema.parse({ name: "x", plugins: [{ id: "a", summary: "b" }], extra: 1 })
    ).toThrow();
  });
});

describe("MarketplaceStateSchema", () => {
  it("provides defaults for an empty object", () => {
    const parsed = MarketplaceStateSchema.parse({});
    expect(parsed.catalog).toEqual([]);
    expect(parsed.installed).toEqual([]);
  });

  it("rejects extra properties (strict)", () => {
    expect(() =>
      MarketplaceStateSchema.parse({ catalog: [], installed: [], extra: true })
    ).toThrow();
  });
});

// ── addMarketplace tests ──────────────────────────────────────────────

describe("addMarketplace", () => {
  it("populates the catalog and leaves installed empty (R-WSH-NLOAD core contract)", () => {
    const root = setupTempHome();

    try {
      const result = addMarketplace(SAMPLE_REGISTRY, { homeDirectory: root });

      // Core contract: catalog size > 0, installed = 0
      expect(result.catalogSize).toBeGreaterThan(0);
      expect(result.catalogSize).toBe(3);
      expect(result.installedCount).toBe(0);
      expect(result.state.installed).toEqual([]);

      // Catalog contains the registered plugins
      const ids = result.state.catalog.map((p) => p.id);
      expect(ids).toContain("shell-linter");
      expect(ids).toContain("git-helpers");
      expect(ids).toContain("web-fetch");

      // Persisted to disk
      const persisted = readPersistedState(root);
      expect(persisted.catalog).toHaveLength(3);
      expect(persisted.installed).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves a fresh installed=[] persisted on disk", () => {
    const root = setupTempHome();

    try {
      addMarketplace(SAMPLE_REGISTRY, { homeDirectory: root });

      const persisted = readPersistedState(root);
      expect(persisted.catalog.length).toBeGreaterThan(0);
      expect(persisted.installed).toEqual([]);
      expect(persisted.installed).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deduplicates plugins by id when the same registry is added twice", () => {
    const root = setupTempHome();

    try {
      const first = addMarketplace(SAMPLE_REGISTRY, { homeDirectory: root });
      expect(first.catalogSize).toBe(3);

      const second = addMarketplace(SAMPLE_REGISTRY, { homeDirectory: root });
      expect(second.catalogSize).toBe(3); // no new entries
      expect(second.installedCount).toBe(0);

      const persisted = readPersistedState(root);
      expect(persisted.catalog).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("merges plugins from different registries, deduplicating overlapping ids", () => {
    const root = setupTempHome();

    try {
      const first = addMarketplace(SAMPLE_REGISTRY, { homeDirectory: root });
      expect(first.catalogSize).toBe(3);

      const second = addMarketplace(SECOND_REGISTRY, { homeDirectory: root });
      // SECOND_REGISTRY has "secret-scanner" (new) and "git-helpers" (overlap)
      expect(second.catalogSize).toBe(4);
      expect(second.installedCount).toBe(0);

      const persisted = readPersistedState(root);
      expect(persisted.catalog).toHaveLength(4);
      expect(persisted.installed).toEqual([]);

      const ids = persisted.catalog.map((p) => p.id);
      expect(ids).toContain("shell-linter");
      expect(ids).toContain("git-helpers");
      expect(ids).toContain("web-fetch");
      expect(ids).toContain("secret-scanner");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("works without an explicit homeDirectory (uses default home)", () => {
    // This test verifies the function runs with the default home directory
    // resolution. We don't assert on disk state since the default home is
    // the real ~/.guruharness — we only verify it doesn't throw and returns
    // the expected shape.
    const result = addMarketplace(SAMPLE_REGISTRY);
    expect(result.catalogSize).toBeGreaterThanOrEqual(3);
    expect(result.installedCount).toBeGreaterThanOrEqual(0);
    expect(result.state.catalog.length).toBe(result.catalogSize);
    expect(result.state.installed.length).toBe(result.installedCount);
  });

  it("returns correct result shape with all fields present", () => {
    const root = setupTempHome();

    try {
      const result = addMarketplace(SAMPLE_REGISTRY, { homeDirectory: root });

      expect(result).toHaveProperty("catalogSize");
      expect(result).toHaveProperty("installedCount");
      expect(result).toHaveProperty("state");
      expect(result.state).toHaveProperty("catalog");
      expect(result.state).toHaveProperty("installed");
      expect(typeof result.catalogSize).toBe("number");
      expect(typeof result.installedCount).toBe("number");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes the marketplace state file to the home directory", () => {
    const root = setupTempHome();

    try {
      addMarketplace(SAMPLE_REGISTRY, { homeDirectory: root });

      const statePath = join(root, MARKETPLACE_STATE_FILE_NAME);
      expect(existsSync(statePath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads existing state and appends to it on subsequent registrations", () => {
    const root = setupTempHome();

    try {
      addMarketplace(SAMPLE_REGISTRY, { homeDirectory: root });

      // Register a single-plugin registry
      const thirdRegistry: MarketplaceRegistry = MarketplaceRegistrySchema.parse({
        name: "extra",
        plugins: [{ id: "extra-tool", summary: "An extra tool" }]
      });

      const result = addMarketplace(thirdRegistry, { homeDirectory: root });
      expect(result.catalogSize).toBe(4); // 3 original + 1 new
      expect(result.installedCount).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
