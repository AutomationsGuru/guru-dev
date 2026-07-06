/**
 * GuruHarness TUI runtime state — pure reducer + UX contract (Dev 4 / D4.0).
 *
 * Design:
 *  - `reduceTuiState(state, action)` is a PURE function. No I/O, no TTY, no timers.
 *    This makes the entire TUI behavior unit-testable (see tests/tui/state.test.ts)
 *    and lets any renderer backend (D4.1) consume the same projected render model.
 *  - The host owns side effects (model calls, discovery, file reads). It dispatches
 *    actions that carry already-resolved, secret-safe data INTO the state. This
 *    honors the mock-first/interface-freeze rule (build-plan §2.0): tests build
 *    state from fixtures, never real discovery.
 *  - Secret-safety (FR-21): state never holds credential values. Providers carry
 *    env-var NAMES + presence booleans only. `assertSecretSafeState` enforces the
 *    invariant and is called from tests.
 *
 * Renderer extension seam (FR-07): `MessageRenderer`, `TuiRenderer`, and the
 * register-* actions let extensions contribute message renderers, commands,
 * keybindings, and widgets without editing core TUI files.
 */

import type {
  TuiAttachment,
  TuiCommand,
  TuiCommandPalette,
  TuiKeybinding,
  TuiKeymap,
  TuiLayout,
  TuiMessageRendererDescriptor,
  TuiMessageQueueKind,
  TuiModelPicker,
  TuiPane,
  TuiProviderEntry,
  TuiRouteDetail,
  TuiRouteType,
  TuiRouterState,
  TuiSessionNode,
  TuiSessionTree,
  TuiSessionTreeNode,
  TuiState,
  TuiStatusFoot,
  TuiTokenUsage,
  TuiTranscriptEntry,
  TuiWidgetDescriptor
} from "./schemas.js";
import { assertSecretSafeStrings } from "../safety/secretSafety.js";

// ---------------------------------------------------------------------------
// Defaults (frozen UX contract)
// ---------------------------------------------------------------------------

export const DEFAULT_TUI_COMMANDS: readonly TuiCommand[] = [
  { id: "focus-transcript", label: "Focus transcript", slash: "/transcript", category: "navigation", defaultKey: "alt+1" },
  { id: "focus-composer", label: "Focus composer", slash: "/composer", category: "navigation", defaultKey: "alt+2" },
  { id: "focus-session-tree", label: "Focus session tree", slash: "/sessions", category: "navigation", defaultKey: "alt+3" },
  { id: "open-model-picker", label: "Open model picker", slash: "/models", category: "model", defaultKey: "ctrl+m" },
  { id: "open-command-palette", label: "Open command palette", slash: "/", category: "system", defaultKey: "ctrl+p" },
  { id: "open-router-panel", label: "Open router panel", slash: "/router", category: "router" },
  { id: "open-readiness-panel", label: "Open readiness panel", slash: "/readiness", category: "system" },
  { id: "cycle-thinking-level", label: "Cycle thinking level", slash: "/thinking", category: "model" },
  { id: "cycle-model", label: "Cycle model", slash: "/model-next", category: "model", defaultKey: "ctrl+tab" },
  { id: "palette-close", label: "Close command palette", category: "system" },
  { id: "palette-move-up", label: "Palette: previous", category: "navigation" },
  { id: "palette-move-down", label: "Palette: next", category: "navigation" },
  { id: "toggle-multiline", label: "Toggle multiline composer", slash: "/multiline", category: "composition" },
  { id: "queue-steering", label: "Queue steering message", category: "composition" },
  { id: "queue-follow-up", label: "Queue follow-up message", category: "composition" },
  { id: "submit-composer", label: "Submit composer", category: "composition", defaultKey: "ctrl+enter" },
  { id: "abort-turn", label: "Abort current turn", slash: "/abort", category: "composition", defaultKey: "ctrl+c" },
  { id: "fork-session", label: "Fork session", slash: "/fork", category: "session" },
  { id: "reload-resources", label: "Reload resources", slash: "/reload", category: "system" },
  { id: "exit", label: "Exit GuruHarness", slash: "/exit", category: "system", defaultKey: "ctrl+d" }
] as const;

export const DEFAULT_TUI_KEYMAP: readonly TuiKeybinding[] = [
  { combo: "ctrl+p", commandId: "open-command-palette", scope: "global" },
  { combo: "ctrl+m", commandId: "open-model-picker", scope: "global" },
  { combo: "ctrl+tab", commandId: "cycle-model", scope: "global" },
  { combo: "ctrl+k", commandId: "open-router-panel", scope: "global" },
  { combo: "ctrl+enter", commandId: "submit-composer", scope: "composer" },
  { combo: "ctrl+c", commandId: "abort-turn", scope: "global" },
  { combo: "ctrl+d", commandId: "exit", scope: "global" },
  { combo: "escape", commandId: "palette-close", scope: "palette" },
  { combo: "alt+1", commandId: "focus-transcript", scope: "global" },
  { combo: "alt+2", commandId: "focus-composer", scope: "global" },
  { combo: "alt+3", commandId: "focus-session-tree", scope: "global" },
  { combo: "up", commandId: "palette-move-up", scope: "palette" },
  { combo: "down", commandId: "palette-move-down", scope: "palette" }
] as const;

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface CreateTuiStateOptions {
  readonly cwd: string;
  readonly sessionId?: string;
  readonly modelId?: string;
  readonly providerId?: string;
  readonly thinkingLevel?: string;
  readonly providers?: readonly TuiProviderEntry[];
  readonly commands?: readonly TuiCommand[];
  readonly keymap?: readonly TuiKeybinding[];
  readonly messageRenderers?: readonly TuiMessageRendererDescriptor[];
  readonly widgets?: readonly TuiWidgetDescriptor[];
  readonly themeId?: string;
}

export function createTuiState(options: CreateTuiStateOptions): TuiState {
  const layout: TuiLayout = {
    focusedPane: "composer",
    visiblePanes: ["transcript", "composer", "status"]
  };

  const status: TuiStatusFoot = {
    cwd: options.cwd,
    busy: false,
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
    ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
    ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {})
  };

  const picker: TuiModelPicker = {
    providers: options.providers !== undefined ? [...options.providers] : [],
    expandedProviderIds: [],
    query: "",
    ...(options.providerId !== undefined ? { selectedProviderId: options.providerId } : {}),
    ...(options.modelId !== undefined ? { selectedModelId: options.modelId } : {})
  };

  const sessionTree: TuiSessionTree =
    options.sessionId !== undefined
      ? {
          nodes: {
            [options.sessionId]: {
              id: options.sessionId,
              createdAt: "1970-01-01T00:00:00.000Z",
              ...(options.modelId !== undefined ? { modelId: options.modelId } : {})
            }
          },
          activeSessionId: options.sessionId,
          expandedIds: [options.sessionId]
        }
      : { nodes: {}, expandedIds: [] };

  const palette: TuiCommandPalette = { open: false, query: "", matchedCommandIds: [], selectedIndex: 0 };

  return {
    layout,
    transcript: { entries: [] },
    composer: { draft: "", multiline: true, attachments: [], queued: [], externalEditorOpen: false },
    status,
    modelPicker: picker,
    sessionTree,
    palette,
    commands: dedupCommands([...DEFAULT_TUI_COMMANDS, ...(options.commands ?? [])]),
    keymap: dedupKeybindings([...DEFAULT_TUI_KEYMAP, ...(options.keymap ?? [])]),
    messageRenderers: [...(options.messageRenderers ?? [])],
    widgets: [...(options.widgets ?? [])],
    ...(options.themeId !== undefined ? { themeId: options.themeId } : {}),
    ready: false
  };
}

// ---------------------------------------------------------------------------
// Actions (discriminated union — the frozen UX command set)
// ---------------------------------------------------------------------------

export type TuiAction =
  // layout
  | { readonly type: "focus-pane"; readonly pane: TuiPane }
  | { readonly type: "toggle-pane-visible"; readonly pane: TuiPane }
  // readiness / providers / router (host-resolved, secret-safe)
  | { readonly type: "mark-ready"; readonly ready: boolean }
  | { readonly type: "refresh-providers"; readonly providers: readonly TuiProviderEntry[] }
  | { readonly type: "set-router"; readonly router: TuiRouterState }
  // transcript
  | { readonly type: "append-entry"; readonly entry: TuiTranscriptEntry }
  | { readonly type: "toggle-entry-collapse"; readonly entryId: string }
  // composer
  | { readonly type: "composer-type"; readonly text: string }
  | { readonly type: "composer-clear" }
  | { readonly type: "composer-toggle-multiline" }
  | { readonly type: "composer-attach"; readonly attachment: TuiAttachment }
  | { readonly type: "composer-detach"; readonly ref: string }
  | { readonly type: "composer-queue"; readonly kind: TuiMessageQueueKind; readonly text: string }
  | { readonly type: "composer-dequeue"; readonly index: number }
  | { readonly type: "composer-open-external-editor" }
  | { readonly type: "composer-close-external-editor" }
  | { readonly type: "submit-composer" }
  | { readonly type: "abort-turn" }
  // status
  | { readonly type: "set-busy"; readonly busy: boolean }
  | { readonly type: "set-model"; readonly modelId: string; readonly providerId?: string }
  | { readonly type: "set-thinking"; readonly level: string }
  | { readonly type: "update-usage"; readonly usage: TuiTokenUsage }
  // model picker
  | { readonly type: "picker-set-query"; readonly query: string }
  | { readonly type: "picker-expand-provider"; readonly providerId: string }
  | { readonly type: "picker-collapse-provider"; readonly providerId: string }
  | { readonly type: "picker-select-provider"; readonly providerId: string }
  | { readonly type: "picker-select-model"; readonly providerId: string; readonly modelId: string }
  | { readonly type: "cycle-model"; readonly scope: "provider" | "all"; readonly direction: 1 | -1 }
  // route detail / router panel
  | { readonly type: "show-route-detail"; readonly detail: TuiRouteDetail }
  | { readonly type: "hide-route-detail" }
  | { readonly type: "open-router-panel" }
  | { readonly type: "open-readiness-panel" }
  // session tree
  | { readonly type: "session-fork"; readonly newSessionId: string; readonly parentId: string; readonly label?: string }
  | { readonly type: "session-switch"; readonly sessionId: string }
  | { readonly type: "session-toggle-expand"; readonly sessionId: string }
  // command palette
  | { readonly type: "palette-open" }
  | { readonly type: "palette-close" }
  | { readonly type: "palette-set-query"; readonly query: string }
  | { readonly type: "palette-move"; readonly delta: number }
  | { readonly type: "palette-run-selected" }
  // extension seam
  | { readonly type: "register-command"; readonly command: TuiCommand }
  | { readonly type: "register-keybinding"; readonly keybinding: TuiKeybinding }
  | { readonly type: "register-message-renderer"; readonly descriptor: TuiMessageRendererDescriptor }
  | { readonly type: "register-widget"; readonly descriptor: TuiWidgetDescriptor }
  | { readonly type: "set-theme"; readonly themeId: string };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function reduceTuiState(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "focus-pane":
      return focusPane(state, action.pane);

    case "toggle-pane-visible":
      return { ...state, layout: { ...state.layout, visiblePanes: toggleInList(state.layout.visiblePanes, action.pane) } };

    case "mark-ready":
      return { ...state, ready: action.ready };

    case "refresh-providers":
      return { ...state, modelPicker: { ...state.modelPicker, providers: [...action.providers] } };

    case "set-router":
      return { ...state, router: action.router };

    case "append-entry":
      return { ...state, transcript: { entries: [...state.transcript.entries, action.entry] } };

    case "toggle-entry-collapse":
      return {
        ...state,
        transcript: {
          entries: state.transcript.entries.map((entry) =>
            entry.id === action.entryId ? { ...entry, collapsed: !entry.collapsed } : entry
          )
        }
      };

    case "composer-type":
      return { ...state, composer: { ...state.composer, draft: action.text } };

    case "composer-clear":
      return { ...state, composer: { ...state.composer, draft: "", attachments: [] } };

    case "composer-toggle-multiline":
      return { ...state, composer: { ...state.composer, multiline: !state.composer.multiline } };

    case "composer-attach":
      return { ...state, composer: { ...state.composer, attachments: [...state.composer.attachments, action.attachment] } };

    case "composer-detach":
      return {
        ...state,
        composer: { ...state.composer, attachments: state.composer.attachments.filter((attachment) => attachment.ref !== action.ref) }
      };

    case "composer-queue":
      return {
        ...state,
        composer: { ...state.composer, queued: [...state.composer.queued, { kind: action.kind, text: action.text }] }
      };

    case "composer-dequeue": {
      const next = state.composer.queued.filter((_, index) => index !== action.index);
      return { ...state, composer: { ...state.composer, queued: next } };
    }

    case "composer-open-external-editor":
      return { ...state, composer: { ...state.composer, externalEditorOpen: true } };

    case "composer-close-external-editor":
      return { ...state, composer: { ...state.composer, externalEditorOpen: false } };

    case "submit-composer": {
      // FR-15 message queue: a submit during an active turn is a steering
      // (interrupt) message; when idle it is a follow-up. The host observes the
      // queued kind and dispatches the turn as a side effect.
      if (state.composer.draft.trim().length === 0) {
        return state;
      }
      const kind: TuiMessageQueueKind = state.status.busy ? "steering" : "follow-up";
      return reduceTuiState(state, { type: "composer-queue", kind, text: state.composer.draft });
    }

    case "abort-turn":
      return { ...state, status: { ...state.status, busy: false } };

    case "set-busy":
      return { ...state, status: { ...state.status, busy: action.busy } };

    case "set-model":
      return {
        ...state,
        status: {
          ...state.status,
          modelId: action.modelId,
          ...(action.providerId !== undefined ? { providerId: action.providerId } : {})
        },
        modelPicker: {
          ...state.modelPicker,
          selectedModelId: action.modelId,
          ...(action.providerId !== undefined ? { selectedProviderId: action.providerId } : {})
        }
      };

    case "set-thinking":
      return { ...state, status: { ...state.status, thinkingLevel: action.level } };

    case "update-usage":
      return { ...state, status: { ...state.status, usage: action.usage } };

    case "picker-set-query":
      return { ...state, modelPicker: { ...state.modelPicker, query: action.query } };

    case "picker-expand-provider":
      return {
        ...state,
        modelPicker: { ...state.modelPicker, expandedProviderIds: addUnique(state.modelPicker.expandedProviderIds, action.providerId) }
      };

    case "picker-collapse-provider":
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          expandedProviderIds: state.modelPicker.expandedProviderIds.filter((id) => id !== action.providerId)
        }
      };

    case "picker-select-provider":
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          selectedProviderId: action.providerId,
          expandedProviderIds: addUnique(state.modelPicker.expandedProviderIds, action.providerId)
        }
      };

    case "picker-select-model":
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          selectedProviderId: action.providerId,
          selectedModelId: action.modelId
        }
      };

    case "cycle-model": {
      // FR-15 scoped model cycling. Resolve an ordered model list within the
      // scope, advance by direction, and reselect. Pure: reads modelPicker.providers.
      const models: Array<{ readonly providerId: string; readonly modelId: string }> = [];
      if (action.scope === "provider") {
        const selectedProviderId = state.modelPicker.selectedProviderId;
        const provider =
          selectedProviderId !== undefined
            ? state.modelPicker.providers.find((entry) => entry.providerId === selectedProviderId)
            : undefined;
        if (provider !== undefined) {
          for (const model of provider.models) {
            models.push({ providerId: provider.providerId, modelId: model.modelId });
          }
        }
      } else {
        for (const provider of state.modelPicker.providers) {
          for (const model of provider.models) {
            models.push({ providerId: provider.providerId, modelId: model.modelId });
          }
        }
      }
      if (models.length === 0) {
        return state;
      }
      const current = models.findIndex(
        (entry) =>
          entry.modelId === state.modelPicker.selectedModelId && entry.providerId === state.modelPicker.selectedProviderId
      );
      const start = current < 0 ? 0 : current;
      const next = (((start + action.direction) % models.length) + models.length) % models.length;
      const picked = models[next];
      if (picked === undefined) {
        return state;
      }
      return reduceTuiState(state, { type: "set-model", modelId: picked.modelId, providerId: picked.providerId });
    }

    case "show-route-detail":
      return focusPane({ ...state, routeDetail: action.detail }, "provider-detail");

    case "hide-route-detail": {
      const { routeDetail: _omit, ...rest } = state;
      void _omit;
      return rest;
    }

    case "open-router-panel":
      return focusPane(state, "router-panel");

    case "open-readiness-panel":
      return focusPane(state, "readiness-panel");

    case "session-fork": {
      // Refuse to fork from a non-existent parent (would orphan the node);
      // no-op like session-switch's missing-id guard.
      const parent = state.sessionTree.nodes[action.parentId];
      if (parent === undefined) {
        return state;
      }
      const nodes = { ...state.sessionTree.nodes };
      const newNode: TuiSessionNode = {
        id: action.newSessionId,
        parentId: action.parentId,
        createdAt: "1970-01-01T00:00:00.000Z",
        ...(parent?.modelId !== undefined ? { modelId: parent.modelId } : {}),
        ...(action.label !== undefined ? { label: action.label } : {})
      };
      nodes[action.newSessionId] = newNode;
      return {
        ...state,
        sessionTree: {
          nodes,
          activeSessionId: action.newSessionId,
          expandedIds: addUnique(state.sessionTree.expandedIds, action.parentId)
        }
      };
    }

    case "session-switch":
      return state.sessionTree.nodes[action.sessionId] !== undefined
        ? { ...state, sessionTree: { ...state.sessionTree, activeSessionId: action.sessionId } }
        : state;

    case "session-toggle-expand":
      return {
        ...state,
        sessionTree: {
          ...state.sessionTree,
          expandedIds: toggleInList(state.sessionTree.expandedIds, action.sessionId)
        }
      };

    case "palette-open": {
      const matched = matchCommands(state.commands, "");
      return {
        ...state,
        palette: { open: true, query: "", matchedCommandIds: matched, selectedIndex: 0 }
      };
    }

    case "palette-close":
      return { ...state, palette: { ...state.palette, open: false, query: "", matchedCommandIds: [], selectedIndex: 0 } };

    case "palette-set-query": {
      const matched = matchCommands(state.commands, action.query);
      return {
        ...state,
        palette: { ...state.palette, query: action.query, matchedCommandIds: matched, selectedIndex: 0 }
      };
    }

    case "palette-move": {
      const count = state.palette.matchedCommandIds.length;
      if (count === 0) {
        return state;
      }
      const raw = state.palette.selectedIndex + action.delta;
      const next = ((raw % count) + count) % count;
      return { ...state, palette: { ...state.palette, selectedIndex: next } };
    }

    case "palette-run-selected": {
      const id = state.palette.matchedCommandIds[state.palette.selectedIndex];
      if (id === undefined) {
        return state;
      }
      // Record the chosen command (host observable) and close the palette; the
      // host performs the bound action as a side effect.
      return { ...state, palette: { ...state.palette, open: false, lastRunCommandId: id } };
    }

    case "register-command":
      return { ...state, commands: dedupCommands([...state.commands, action.command]) };

    case "register-keybinding":
      return { ...state, keymap: dedupKeybindings([...state.keymap, action.keybinding]) };

    case "register-message-renderer":
      return { ...state, messageRenderers: [...state.messageRenderers, action.descriptor] };

    case "register-widget":
      return { ...state, widgets: [...state.widgets, action.descriptor] };

    case "set-theme":
      return { ...state, themeId: action.themeId };

    default: {
      const exhaustive: never = action;
      void exhaustive;
      return state;
    }
  }
}

// ---------------------------------------------------------------------------
// Keybinding resolution
// ---------------------------------------------------------------------------

export function normalizeCombo(raw: string): string {
  return raw.trim().toLowerCase();
}

export function paneScope(pane: TuiPane): TuiKeybinding["scope"] {
  switch (pane) {
    case "composer":
      return "composer";
    case "model-picker":
      return "picker";
    case "command-palette":
      return "palette";
    case "transcript":
      return "transcript";
    default:
      return "global";
  }
}

/**
 * Resolve a key combo to a command id for the current focused pane. Scope-specific
 * bindings win; otherwise a global binding is used.
 */
export function resolveKeybinding(state: TuiState, combo: string): string | undefined {
  const normalized = normalizeCombo(combo);
  const scope = paneScope(state.layout.focusedPane);
  const scoped = state.keymap.find((binding) => normalizeCombo(binding.combo) === normalized && binding.scope === scope);
  if (scoped !== undefined) {
    return scoped.commandId;
  }
  const global = state.keymap.find((binding) => normalizeCombo(binding.combo) === normalized && binding.scope === "global");
  return global?.commandId;
}

// ---------------------------------------------------------------------------
// Render-model projection (what a renderer consumes)
// ---------------------------------------------------------------------------

export interface TuiRenderModel {
  readonly layout: TuiLayout;
  readonly visibleProviders: readonly TuiProviderEntry[];
  readonly sessionForest: readonly TuiSessionTreeNode[];
  readonly routeDetail?: TuiRouteDetail;
  readonly paletteOpen: boolean;
  readonly paletteCommands: readonly TuiCommand[];
  readonly paletteSelectedIndex: number;
  readonly ready: boolean;
  readonly status: TuiStatusFoot;
  readonly router?: TuiRouterState;
  readonly themeId?: string;
}

/** Build the read-only projection a renderer paints. Pure. */
export function projectRenderModel(state: TuiState): TuiRenderModel {
  const paletteCommands = state.palette.matchedCommandIds
    .map((id) => state.commands.find((command) => command.id === id))
    .filter((command): command is TuiCommand => command !== undefined);

  const model: TuiRenderModel = {
    layout: state.layout,
    visibleProviders: filterProviders(state.modelPicker.providers, state.modelPicker.query).map((provider) => ({
      ...provider,
      models: [...provider.models].sort((a, b) => directFirstRank(a.routeType) - directFirstRank(b.routeType))
    })),
    sessionForest: buildSessionForest(state.sessionTree),
    paletteOpen: state.palette.open,
    paletteCommands,
    paletteSelectedIndex: state.palette.selectedIndex,
    ready: state.ready,
    status: state.status,
    ...(state.routeDetail !== undefined ? { routeDetail: state.routeDetail } : {}),
    ...(state.router !== undefined ? { router: state.router } : {}),
    ...(state.themeId !== undefined ? { themeId: state.themeId } : {})
  };
  return model;
}

const ROUTE_TYPE_RANK: Readonly<Record<TuiRouteType, number>> = {
  "direct-api": 0,
  "operator-provider-plan-auth": 1,
  "native-cli": 2,
  "router-bridge": 3,
  delegated: 4,
  deferred: 5,
  excluded: 6
};

/** Direct-first ordering rank for a route type (lower = more preferred). crush §1.2/§6. */
export function directFirstRank(routeType: TuiRouteType): number {
  return ROUTE_TYPE_RANK[routeType];
}

/** Case-insensitive filter over provider/model display names + capability badges. */
export function filterProviders(providers: readonly TuiProviderEntry[], query: string): readonly TuiProviderEntry[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) {
    return providers;
  }
  return providers.filter((provider) => {
    if (provider.displayName.toLowerCase().includes(trimmed) || provider.providerId.toLowerCase().includes(trimmed)) {
      return true;
    }
    return provider.models.some(
      (model) =>
        model.label.toLowerCase().includes(trimmed) ||
        model.modelId.toLowerCase().includes(trimmed) ||
        model.capabilities.some((capability) => capability === trimmed)
    );
  });
}

/** Build a nested forest from the flat parentId-based session map (FR-14). */
export function buildSessionForest(tree: TuiSessionTree): readonly TuiSessionTreeNode[] {
  const childrenOf = new Map<string | undefined, TuiSessionNode[]>();
  for (const node of Object.values(tree.nodes)) {
    const key = node.parentId;
    const bucket = childrenOf.get(key);
    if (bucket === undefined) {
      childrenOf.set(key, [node]);
    } else {
      bucket.push(node);
    }
  }
  const build = (parent: string | undefined): TuiSessionTreeNode[] => {
    const kids = childrenOf.get(parent) ?? [];
    return kids.map((node) => ({ node, children: build(node.id) }));
  };
  return build(undefined);
}

// ---------------------------------------------------------------------------
// Renderer extension seam (FR-07)
// ---------------------------------------------------------------------------

/** A custom transcript-entry renderer contributed by an extension. */
export interface MessageRenderer {
  readonly descriptor: TuiMessageRendererDescriptor;
  /** Returns true if this renderer should handle the entry. */
  supports(entry: TuiTranscriptEntry): boolean;
  /** Produce a secret-safe, renderable string/lines payload. Pure. */
  render(entry: TuiTranscriptEntry): string;
}

/**
 * Abstract terminal backend (D4.1 picks a concrete impl). D4.0 freezes the seam
 * so the state model and picker can be built and tested against any backend.
 */
export interface TuiRenderer {
  readonly id: string;
  /** Paint the projected model. Pure input; the backend owns stdout/raw-mode. */
  render(model: TuiRenderModel): void;
}

// ---------------------------------------------------------------------------
// Secret-safety invariant (FR-21) — core moved to src/safety/secretSafety.ts
// (2026-07-04); this module keeps the TUI-shaped wrapper for compatibility.
// ---------------------------------------------------------------------------

/**
 * Gathers every credential/infrastructure METADATA string in the state (provider
 * names, env names, endpoints, docs links, aliases, caveats, router fields). These
 * are the fields that must NEVER carry a secret value. Conversation content
 * (transcript/composer/tool summaries) is intentionally excluded — users may
 * legitimately discuss keys in conversation.
 */
function gatherSecretHaystack(state: TuiState): string[] {
  const out: string[] = [];
  for (const provider of state.modelPicker.providers) {
    out.push(provider.providerId, provider.displayName, provider.safeSetupHint ?? "");
    out.push(...provider.requiredEnvNames, ...provider.presentEnvNames, ...provider.docs);
    for (const model of provider.models) {
      out.push(model.modelId, model.label, model.verificationMarker ?? "", model.cost?.lane ?? "");
      out.push(...model.aliases, ...model.caveats);
    }
  }
  if (state.routeDetail !== undefined) {
    out.push(state.routeDetail.endpoint ?? "");
    out.push(...state.routeDetail.docs, ...state.routeDetail.caveats);
  }
  if (state.router !== undefined) {
    out.push(state.router.healthEndpoint ?? "", state.router.configPath ?? "");
    out.push(...state.router.missingEnvNames);
  }
  return out;
}

/**
 * Asserts the credential-metadata fields contain no obvious secret values.
 * Defense-in-depth: the structural rule (names + booleans only) is the primary
 * guarantee; this catches values that slipped into a name/endpoint/docs field.
 * Throws on the first suspected leak.
 */
export function assertSecretSafeState(state: TuiState): void {
  assertSecretSafeStrings(gatherSecretHaystack(state), "TUI state");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function focusPane(state: TuiState, pane: TuiPane): TuiState {
  const visible = state.layout.visiblePanes.includes(pane) ? state.layout.visiblePanes : [...state.layout.visiblePanes, pane];
  return { ...state, layout: { focusedPane: pane, visiblePanes: visible } };
}

function toggleInList<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function addUnique<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? [...list] : [...list, value];
}

function dedupCommands(commands: readonly TuiCommand[]): TuiCommand[] {
  const seen = new Set<string>();
  const out: TuiCommand[] = [];
  for (const command of commands) {
    if (!seen.has(command.id)) {
      seen.add(command.id);
      out.push(command);
    }
  }
  return out;
}

function dedupKeybindings(bindings: readonly TuiKeybinding[]): TuiKeybinding[] {
  // Keybindings are user/extension-overridable: last registration for a given
  // combo+scope wins (so a default key can be remapped). Insertion order of the
  // first occurrence is preserved for stable rendering.
  const byKey = new Map<string, TuiKeybinding>();
  for (const binding of bindings) {
    const key = `${normalizeCombo(binding.combo)}@${binding.scope}`;
    byKey.set(key, binding);
  }
  return [...byKey.values()];
}

function matchCommands(commands: readonly TuiCommand[], query: string): string[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) {
    return commands.map((command) => command.id);
  }
  return commands
    .filter(
      (command) =>
        command.id.toLowerCase().includes(trimmed) ||
        command.label.toLowerCase().includes(trimmed) ||
        (command.slash?.toLowerCase().includes(trimmed) ?? false)
    )
    .map((command) => command.id);
}
