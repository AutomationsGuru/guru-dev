import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCapabilityMarketplace,
  resolveMarketplaceDirectory,
  type CapabilityPlugin
} from '../../src/home/capabilityMarketplace.js';

const FIXED_NOW = () => new Date("2026-07-19T16:31:00.000Z");

const TEST_CATALOG: readonly CapabilityPlugin[] = [
  {
    id: "alpha",
    name: "Alpha",
    description: "First test capability.",
    move: "build",
    context: [
      { kind: "skill", value: "alpha.md" },
      { kind: "tool", value: "alpha-tool" }
    ]
  },
  {
    id: "beta",
    name: "Beta",
    description: "Second test capability.",
    move: "attach",
    context: [{ kind: "skill", value: "beta.md" }]
  },
  {
    id: "gamma",
    name: "Gamma",
    description: "Third test capability with no context payload.",
    move: "learn",
    context: []
  }
];

describe("capability marketplace selective install", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "guruharness-mkt-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("exposes the catalog as installed metadata only, without anything installed", () => {
    const store = createCapabilityMarketplace({ homeDirectory: root, catalog: TEST_CATALOG, now: FIXED_NOW });

    expect(store.listCatalog().map((plugin) => plugin.id)).toEqual(["alpha", "beta", "gamma"]);
    expect(store.listInstalled()).toEqual([]);
    expect(store.loadContext().entries).toEqual([]);
    expect(store.loadContext().contributors).toEqual([]);
  });

  it("marks a plugin installed and then includes only that plugin's context", () => {
    const store = createCapabilityMarketplace({ homeDirectory: root, catalog: TEST_CATALOG, now: FIXED_NOW });

    const result = store.install("beta");
    expect(result.status).toBe("installed");
    expect(result.plugin?.id).toBe("beta");
    expect(result.plugin?.installedAt).toBe("2026-07-19T16:31:00.000Z");

    expect(store.isInstalled("beta")).toBe(true);
    expect(store.isInstalled("alpha")).toBe(false);

    const context = store.loadContext();
    // ONLY the installed plugin contributes — alpha and gamma stay out.
    expect(context.entries).toEqual([{ kind: "skill", value: "beta.md" }]);
    expect(context.contributors).toEqual(["beta"]);
  });

  it("leaves uninstalled plugins entirely out of context even when others are installed", () => {
    const store = createCapabilityMarketplace({ homeDirectory: root, catalog: TEST_CATALOG, now: FIXED_NOW });

    store.install("alpha");

    const context = store.loadContext();
    // beta is cataloged but NOT installed, so its entry must be absent.
    expect(context.entries).toEqual([
      { kind: "skill", value: "alpha.md" },
      { kind: "tool", value: "alpha-tool" }
    ]);
    expect(context.entries.some((entry) => entry.value === "beta.md")).toBe(false);
    expect(context.contributors).toEqual(["alpha"]);
  });

  it("preserves catalog order in context regardless of install order", () => {
    const store = createCapabilityMarketplace({ homeDirectory: root, catalog: TEST_CATALOG, now: FIXED_NOW });

    store.install("beta");
    store.install("alpha");

    expect(store.loadContext().contributors).toEqual(["alpha", "beta"]);
  });

  it("reports already-installed on a second install without duplicating state", () => {
    const store = createCapabilityMarketplace({ homeDirectory: root, catalog: TEST_CATALOG, now: FIXED_NOW });

    expect(store.install("alpha").status).toBe("installed");
    expect(store.install("alpha").status).toBe("already-installed");
    expect(store.listInstalled().filter((plugin) => plugin.id === "alpha")).toHaveLength(1);
  });

  it("rejects unknown plugin ids with an explicit status and no state change", () => {
    const store = createCapabilityMarketplace({ homeDirectory: root, catalog: TEST_CATALOG, now: FIXED_NOW });

    expect(store.install("nope").status).toBe("unknown-plugin");
    expect(store.listInstalled()).toEqual([]);
  });

  it("uninstalls a plugin so its context no longer loads", () => {
    const store = createCapabilityMarketplace({ homeDirectory: root, catalog: TEST_CATALOG, now: FIXED_NOW });

    store.install("alpha");
    store.install("beta");

    const removed = store.uninstall("alpha");
    expect(removed).toEqual({ status: "uninstalled", pluginId: "alpha" });

    const context = store.loadContext();
    expect(context.contributors).toEqual(["beta"]);
    expect(context.entries).toEqual([{ kind: "skill", value: "beta.md" }]);
  });

  it("reports not-installed when uninstalling a plugin that was never installed", () => {
    const store = createCapabilityMarketplace({ homeDirectory: root, catalog: TEST_CATALOG, now: FIXED_NOW });

    expect(store.uninstall("alpha")).toEqual({ status: "not-installed", pluginId: "alpha" });
  });

  it("persists installed state to the home profile and reloads it on a fresh store", () => {
    const first = createCapabilityMarketplace({ homeDirectory: root, catalog: TEST_CATALOG, now: FIXED_NOW });
    first.install("beta");

    const statePath = first.installedStatePath;
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as { version: number; plugins: Array<{ id: string }> };
    expect(persisted.version).toBe(1);
    expect(persisted.plugins.map((plugin) => plugin.id)).toEqual(["beta"]);

    // A new store pointing at the same home sees the prior install.
    const reopened = createCapabilityMarketplace({ homeDirectory: root, catalog: TEST_CATALOG, now: FIXED_NOW });
    expect(reopened.isInstalled("beta")).toBe(true);
    expect(reopened.loadContext().contributors).toEqual(["beta"]);
  });

  it("resolves the marketplace directory under the home profile", () => {
    expect(resolveMarketplaceDirectory(root)).toBe(join(root, "marketplace"));
  });

  it("treats plugins with empty context as installable but context-neutral", () => {
    const store = createCapabilityMarketplace({ homeDirectory: root, catalog: TEST_CATALOG, now: FIXED_NOW });

    expect(store.install("gamma").status).toBe("installed");
    expect(store.isInstalled("gamma")).toBe(true);
    expect(store.loadContext().entries).toEqual([]);
    expect(store.loadContext().contributors).toEqual(["gamma"]);
  });

  it("rejects a catalog with a duplicate plugin id at construction", () => {
    const duplicateCatalog: CapabilityPlugin[] = [
      { id: "dup", name: "Dup A", description: "first", move: "build", context: [] },
      { id: "dup", name: "Dup B", description: "second", move: "learn", context: [] }
    ];
    expect(() => createCapabilityMarketplace({ homeDirectory: root, catalog: duplicateCatalog, now: FIXED_NOW })).toThrow(
      /Duplicate capability plugin id in catalog: dup/
    );
  });
});
