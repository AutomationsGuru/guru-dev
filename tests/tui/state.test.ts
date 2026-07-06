/**
 * Tests for the GuruHarness TUI state model (Dev 4 / D4.0).
 *
 * The reducer is pure, so these tests run headless (no TTY). They freeze the
 * UX contract: layout focus, transcript, composer queueing, model picker
 * filter/select, session fork tree, command palette, keybinding resolution,
 * the extension registration seam, schema strictness, and the FR-21
 * secret-safety invariant.
 */

import { describe, expect, it } from "vitest";

import { TuiProviderEntrySchema, TuiStateSchema } from "../../src/tui/schemas.js";
import {
  DEFAULT_TUI_COMMANDS,
  assertSecretSafeState,
  buildSessionForest,
  createTuiState,
  directFirstRank,
  filterProviders,
  projectRenderModel,
  reduceTuiState,
  resolveKeybinding
} from "../../src/tui/state.js";
import type { TuiProviderEntry } from "../../src/tui/schemas.js";

function fixtureProvider(overrides: Partial<TuiProviderEntry> = {}): TuiProviderEntry {
  const base = TuiProviderEntrySchema.parse({
    providerId: "minimax",
    displayName: "MiniMax",
    group: "direct",
    status: "active",
    requiredEnvNames: ["MINIMAX_API_KEY"],
    presentEnvNames: ["MINIMAX_API_KEY"],
    credentialSourceTypes: ["process-env"],
    models: [
      {
        modelId: "minimax-m3",
        label: "MiniMax M3",
        aliases: ["router-minimax-m3"],
        routeType: "direct-api",
        capabilities: ["text", "tools", "long-context"],
        limits: { contextWindow: 1000000, maxOutputTokens: 16384 },
        status: "active",
        caveats: []
      }
    ],
    docs: ["https://example.invalid/docs/minimax"],
    lastCheckedAt: "2026-06-23T00:00:00.000Z"
  });
  return { ...base, ...overrides };
}

describe("createTuiState", () => {
  it("seeds defaults: layout, palette, default commands + keymap", () => {
    const state = createTuiState({ cwd: "D:/repo" });
    expect(state.layout.focusedPane).toBe("composer");
    expect(state.layout.visiblePanes).toEqual(["transcript", "composer", "status"]);
    expect(state.ready).toBe(false);
    expect(state.palette.open).toBe(false);
    expect(state.commands.map((command) => command.id)).toEqual(
      expect.arrayContaining(DEFAULT_TUI_COMMANDS.map((command) => command.id))
    );
    expect(state.keymap.some((binding) => binding.combo === "ctrl+p")).toBe(true);
  });

  it("seeds an active session node when sessionId is provided", () => {
    const state = createTuiState({ cwd: "D:/repo", sessionId: "s1", modelId: "minimax-m3" });
    expect(state.sessionTree.activeSessionId).toBe("s1");
    expect(state.sessionTree.nodes["s1"]?.modelId).toBe("minimax-m3");
    expect(state.status.modelId).toBe("minimax-m3");
  });

  it("dedups provided commands and keybindings against defaults", () => {
    const state = createTuiState({
      cwd: "D:/repo",
      commands: [{ id: "open-command-palette", label: "Override", category: "system" }],
      keymap: [{ combo: "Ctrl+P", commandId: "custom", scope: "global" }]
    });
    const paletteCommand = state.commands.find((command) => command.id === "open-command-palette");
    // First-seen wins for commands, so default is retained.
    expect(paletteCommand?.label).toBe("Open command palette");
    // Keybinding dedup is by normalized combo+scope; provided overrides default.
    const binding = state.keymap.find((entry) => entry.combo.toLowerCase() === "ctrl+p");
    expect(binding?.commandId).toBe("custom");
  });

  it("produces a state that parses against the strict TuiStateSchema", () => {
    const state = createTuiState({ cwd: "D:/repo", providers: [fixtureProvider()] });
    expect(() => TuiStateSchema.parse(state)).not.toThrow();
  });
});

describe("layout", () => {
  it("focus-pane focuses and makes the pane visible", () => {
    const state = createTuiState({ cwd: "D:/repo" });
    const next = reduceTuiState(state, { type: "focus-pane", pane: "model-picker" });
    expect(next.layout.focusedPane).toBe("model-picker");
    expect(next.layout.visiblePanes).toContain("model-picker");
  });

  it("toggle-pane-visible adds and removes a pane", () => {
    let state = createTuiState({ cwd: "D:/repo" });
    state = reduceTuiState(state, { type: "toggle-pane-visible", pane: "session-tree" });
    expect(state.layout.visiblePanes).toContain("session-tree");
    state = reduceTuiState(state, { type: "toggle-pane-visible", pane: "session-tree" });
    expect(state.layout.visiblePanes).not.toContain("session-tree");
  });
});

describe("transcript", () => {
  it("appends entries and toggles collapse", () => {
    let state = createTuiState({ cwd: "D:/repo" });
    state = reduceTuiState(state, {
      type: "append-entry",
      entry: { id: "e1", kind: "assistant-text", text: "hi", createdAt: "2026-06-23T00:00:00.000Z", collapsed: false }
    });
    expect(state.transcript.entries).toHaveLength(1);
    state = reduceTuiState(state, { type: "toggle-entry-collapse", entryId: "e1" });
    expect(state.transcript.entries[0]?.collapsed).toBe(true);
  });
});

describe("composer", () => {
  it("types, attaches, detaches, and clears", () => {
    let state = createTuiState({ cwd: "D:/repo" });
    state = reduceTuiState(state, { type: "composer-type", text: "hello" });
    expect(state.composer.draft).toBe("hello");
    state = reduceTuiState(state, { type: "composer-attach", attachment: { ref: "D:/repo/a.ts", kind: "file" } });
    expect(state.composer.attachments).toHaveLength(1);
    state = reduceTuiState(state, { type: "composer-detach", ref: "D:/repo/a.ts" });
    expect(state.composer.attachments).toHaveLength(0);
    state = reduceTuiState(state, { type: "composer-clear" });
    expect(state.composer.draft).toBe("");
  });

  it("submit queues a follow-up when draft is non-empty and is a no-op when empty", () => {
    let state = createTuiState({ cwd: "D:/repo" });
    state = reduceTuiState(state, { type: "submit-composer" });
    expect(state.composer.queued).toHaveLength(0);
    state = reduceTuiState(state, { type: "composer-type", text: "go" });
    state = reduceTuiState(state, { type: "submit-composer" });
    expect(state.composer.queued).toEqual([{ kind: "follow-up", text: "go" }]);
  });

  it("submit queues steering when busy and follow-up when idle", () => {
    let state = createTuiState({ cwd: "D:/repo" });
    state = reduceTuiState(state, { type: "set-busy", busy: true });
    state = reduceTuiState(state, { type: "composer-type", text: "stop now" });
    state = reduceTuiState(state, { type: "submit-composer" });
    expect(state.composer.queued[state.composer.queued.length - 1]).toEqual({ kind: "steering", text: "stop now" });
  });

  it("queues explicit steering vs follow-up and dequeues by index", () => {
    let state = createTuiState({ cwd: "D:/repo" });
    state = reduceTuiState(state, { type: "composer-queue", kind: "steering", text: "stop" });
    state = reduceTuiState(state, { type: "composer-queue", kind: "follow-up", text: "then x" });
    state = reduceTuiState(state, { type: "composer-dequeue", index: 0 });
    expect(state.composer.queued).toEqual([{ kind: "follow-up", text: "then x" }]);
  });
});

describe("status", () => {
  it("set-model updates status and picker together", () => {
    const state = createTuiState({ cwd: "D:/repo" });
    const next = reduceTuiState(state, { type: "set-model", modelId: "m1", providerId: "p1" });
    expect(next.status.modelId).toBe("m1");
    expect(next.status.providerId).toBe("p1");
    expect(next.modelPicker.selectedModelId).toBe("m1");
    expect(next.modelPicker.selectedProviderId).toBe("p1");
  });
});

describe("model picker", () => {
  it("expands, collapses, and selects providers/models", () => {
    let state = createTuiState({ cwd: "D:/repo", providers: [fixtureProvider()] });
    state = reduceTuiState(state, { type: "picker-expand-provider", providerId: "minimax" });
    expect(state.modelPicker.expandedProviderIds).toContain("minimax");
    state = reduceTuiState(state, { type: "picker-select-model", providerId: "minimax", modelId: "minimax-m3" });
    expect(state.modelPicker.selectedModelId).toBe("minimax-m3");
    state = reduceTuiState(state, { type: "picker-collapse-provider", providerId: "minimax" });
    expect(state.modelPicker.expandedProviderIds).not.toContain("minimax");
  });

  it("filterProviders matches name, model, and capability", () => {
    const minimax = fixtureProvider();
    const sakana = fixtureProvider({
      providerId: "sakana",
      displayName: "Sakana",
      models: [
        {
          modelId: "fugu",
          label: "Fugu",
          aliases: [],
          routeType: "direct-api",
          capabilities: ["text"],
          status: "active",
          caveats: []
        }
      ]
    });
    const providers = [minimax, sakana];
    expect(filterProviders(providers, "minimax")).toHaveLength(1);
    expect(filterProviders(providers, "minimax-m3")).toHaveLength(1);
    expect(filterProviders(providers, "fugu")).toHaveLength(1);
    expect(filterProviders(providers, "vision")).toHaveLength(0);
    expect(filterProviders(providers, "")).toHaveLength(2);
  });

  it("show-route-detail focuses the provider-detail pane; hide-route-detail removes it", () => {
    let state = createTuiState({ cwd: "D:/repo" });
    state = reduceTuiState(state, {
      type: "show-route-detail",
      detail: {
        providerId: "minimax",
        modelId: "minimax-m3",
        routeType: "direct-api",
        credentialSourceType: "process-env",
        capabilities: ["text"],
        docs: [],
        caveats: []
      }
    });
    expect(state.routeDetail?.modelId).toBe("minimax-m3");
    expect(state.layout.focusedPane).toBe("provider-detail");
    state = reduceTuiState(state, { type: "hide-route-detail" });
    expect(state.routeDetail).toBeUndefined();
  });
});

describe("session tree", () => {
  it("fork creates a child node, activates it, and expands the parent", () => {
    let state = createTuiState({ cwd: "D:/repo", sessionId: "root" });
    state = reduceTuiState(state, { type: "session-fork", newSessionId: "child", parentId: "root", label: "fork-1" });
    expect(state.sessionTree.nodes["child"]?.parentId).toBe("root");
    expect(state.sessionTree.nodes["child"]?.label).toBe("fork-1");
    expect(state.sessionTree.activeSessionId).toBe("child");
    expect(state.sessionTree.expandedIds).toContain("root");
  });

  it("buildSessionForest nests children under parents", () => {
    let state = createTuiState({ cwd: "D:/repo", sessionId: "root" });
    state = reduceTuiState(state, { type: "session-fork", newSessionId: "b", parentId: "root" });
    state = reduceTuiState(state, { type: "session-fork", newSessionId: "c", parentId: "root" });
    const forest = buildSessionForest(state.sessionTree);
    expect(forest).toHaveLength(1);
    expect(forest[0]?.node.id).toBe("root");
    expect(forest[0]?.children.map((entry) => entry.node.id).sort()).toEqual(["b", "c"]);
  });

  it("session-switch is a no-op for unknown ids", () => {
    const state = createTuiState({ cwd: "D:/repo", sessionId: "root" });
    const next = reduceTuiState(state, { type: "session-switch", sessionId: "missing" });
    expect(next.sessionTree.activeSessionId).toBe("root");
  });

  it("session-fork is a no-op when the parent is missing (no orphaned node)", () => {
    const state = createTuiState({ cwd: "D:/repo", sessionId: "root" });
    const next = reduceTuiState(state, { type: "session-fork", newSessionId: "orphan", parentId: "ghost" });
    expect(next).toBe(state);
    expect(next.sessionTree.nodes["orphan"]).toBeUndefined();
  });
});

describe("command palette", () => {
  it("opens with all commands, filters by query, wraps selection, and closes on run", () => {
    let state = createTuiState({ cwd: "D:/repo" });
    state = reduceTuiState(state, { type: "palette-open" });
    expect(state.palette.open).toBe(true);
    expect(state.palette.matchedCommandIds.length).toBeGreaterThan(0);
    state = reduceTuiState(state, { type: "palette-set-query", query: "model" });
    expect(state.palette.matchedCommandIds).toContain("open-model-picker");
    const count = state.palette.matchedCommandIds.length;
    state = reduceTuiState(state, { type: "palette-move", delta: -1 });
    expect(state.palette.selectedIndex).toBe(count - 1);
    state = reduceTuiState(state, { type: "palette-run-selected" });
    expect(state.palette.open).toBe(false);
    expect(state.palette.lastRunCommandId).toBeDefined();
  });

  it("default keymap only references commands that exist in the default command set", () => {
    const state = createTuiState({ cwd: "D:/repo" });
    const commandIds = new Set(state.commands.map((command) => command.id));
    for (const binding of state.keymap) {
      expect(commandIds.has(binding.commandId)).toBe(true);
    }
  });
});

describe("keybindings", () => {
  it("resolves scope-specific bindings over global", () => {
    const state = createTuiState({ cwd: "D:/repo" });
    // Focused pane is composer; ctrl+enter is composer-scoped.
    expect(resolveKeybinding(state, "CTRL+Enter")).toBe("submit-composer");
    // ctrl+p has no composer-scoped binding; falls back to global.
    expect(resolveKeybinding(state, "ctrl+p")).toBe("open-command-palette");
    // Unknown combo resolves to undefined.
    expect(resolveKeybinding(state, "f4")).toBeUndefined();
  });
});

describe("extension seam", () => {
  it("registers commands, keybindings, renderers, and widgets additively", () => {
    let state = createTuiState({ cwd: "D:/repo" });
    state = reduceTuiState(state, {
      type: "register-command",
      command: { id: "ext-do-thing", label: "Do thing", category: "extension", slash: "/thing" }
    });
    state = reduceTuiState(state, {
      type: "register-keybinding",
      keybinding: { combo: "f6", commandId: "ext-do-thing", scope: "global" }
    });
    state = reduceTuiState(state, {
      type: "register-message-renderer",
      descriptor: { id: "diff-renderer", label: "Diff", supportedKinds: ["assistant-text"], priority: 10 }
    });
    state = reduceTuiState(state, {
      type: "register-widget",
      descriptor: { id: "usage-widget", label: "Usage", pane: "status", priority: 100 }
    });
    expect(state.commands.some((command) => command.id === "ext-do-thing")).toBe(true);
    expect(resolveKeybinding(state, "f6")).toBe("ext-do-thing");
    expect(state.messageRenderers).toHaveLength(1);
    expect(state.widgets).toHaveLength(1);
  });
});

describe("render projection", () => {
  it("projects filtered providers, nested session forest, and palette commands", () => {
    let state = createTuiState({ cwd: "D:/repo", sessionId: "root", providers: [fixtureProvider()] });
    state = reduceTuiState(state, { type: "mark-ready", ready: true });
    state = reduceTuiState(state, { type: "picker-set-query", query: "minimax" });
    const model = projectRenderModel(state);
    expect(model.ready).toBe(true);
    expect(model.visibleProviders).toHaveLength(1);
    expect(model.sessionForest[0]?.node.id).toBe("root");
  });
});

describe("secret safety (FR-21)", () => {
  it("passes for a clean fixture provider", () => {
    const state = createTuiState({ cwd: "D:/repo", providers: [fixtureProvider()] });
    expect(() => assertSecretSafeState(state)).not.toThrow();
  });

  it("throws when a provider hint contains an obvious key value", () => {
    const leaking = fixtureProvider({ safeSetupHint: "set MINIMAX_API_KEY=sk-livekey1234567890abcdef" });
    const state = createTuiState({ cwd: "D:/repo", providers: [leaking] });
    expect(() => assertSecretSafeState(state)).toThrow(/secret-safety/);
  });

  it("catches a token embedded in a provider docs link", () => {
    const leaking = fixtureProvider({ docs: ["https://api.example.invalid/v1?api_key=sk-live1234567890abcdef"] });
    const state = createTuiState({ cwd: "D:/repo", providers: [leaking] });
    expect(() => assertSecretSafeState(state)).toThrow(/secret-safety/);
  });
});

describe("model cycling + direct-first ranking", () => {
  const twoModelProvider = TuiProviderEntrySchema.parse({
    providerId: "p",
    displayName: "P",
    group: "direct",
    status: "active",
    requiredEnvNames: [],
    presentEnvNames: [],
    credentialSourceTypes: [],
    models: [
      { modelId: "a", label: "A", aliases: [], routeType: "router-bridge", capabilities: ["text"], status: "active", caveats: [] },
      { modelId: "b", label: "B", aliases: [], routeType: "direct-api", capabilities: ["text"], status: "active", caveats: [] }
    ],
    docs: [],
    lastCheckedAt: "2026-06-23T00:00:00.000Z"
  });

  it("cycle-model advances within the provider scope and wraps", () => {
    let state = createTuiState({ cwd: "D:/repo", providers: [twoModelProvider], providerId: "p", modelId: "a" });
    state = reduceTuiState(state, { type: "cycle-model", scope: "provider", direction: 1 });
    expect(state.modelPicker.selectedModelId).toBe("b");
    state = reduceTuiState(state, { type: "cycle-model", scope: "provider", direction: 1 });
    expect(state.modelPicker.selectedModelId).toBe("a");
  });

  it("directFirstRank orders direct-api before router-bridge in the projection", () => {
    expect(directFirstRank("direct-api")).toBeLessThan(directFirstRank("router-bridge"));
    const state = createTuiState({ cwd: "D:/repo", providers: [twoModelProvider] });
    const provider = projectRenderModel(state).visibleProviders[0];
    expect(provider?.models.map((model) => model.modelId)).toEqual(["b", "a"]);
  });
});

describe("behavior coverage", () => {
  it("abort-turn clears busy but preserves the queued messages", () => {
    let state = createTuiState({ cwd: "D:/repo" });
    state = reduceTuiState(state, { type: "composer-queue", kind: "follow-up", text: "x" });
    state = reduceTuiState(state, { type: "set-busy", busy: true });
    state = reduceTuiState(state, { type: "abort-turn" });
    expect(state.status.busy).toBe(false);
    expect(state.composer.queued).toHaveLength(1);
  });

  it("picker-select-provider selects and auto-expands the provider", () => {
    const state = createTuiState({ cwd: "D:/repo", providers: [fixtureProvider()] });
    const next = reduceTuiState(state, { type: "picker-select-provider", providerId: "minimax" });
    expect(next.modelPicker.selectedProviderId).toBe("minimax");
    expect(next.modelPicker.expandedProviderIds).toContain("minimax");
  });

  it("refresh-providers, set-theme, and panel focus mutate state", () => {
    let state = createTuiState({ cwd: "D:/repo", providers: [fixtureProvider()] });
    state = reduceTuiState(state, { type: "refresh-providers", providers: [] });
    expect(state.modelPicker.providers).toHaveLength(0);
    state = reduceTuiState(state, { type: "set-theme", themeId: "dark-1" });
    expect(state.themeId).toBe("dark-1");
    state = reduceTuiState(state, { type: "open-router-panel" });
    expect(state.layout.focusedPane).toBe("router-panel");
    state = reduceTuiState(state, { type: "open-readiness-panel" });
    expect(state.layout.focusedPane).toBe("readiness-panel");
  });
});
