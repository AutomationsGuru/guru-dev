/**
 * GuruHarness TUI state model + UX contract (Dev 4 / D4.0).
 *
 * This module freezes the TUI's data shapes BEFORE any real terminal renderer is
 * built (D4.1). It is intentionally renderer-agnostic and dependency-free: the
 * reducer in `./state.ts` is a pure function over these schemas, so the whole
 * surface is unit-testable without a TTY.
 *
 * Contract sources:
 *  - FR-15 (TUI parity) in requirements/2026-06-23-functional-requirements-pi-litellm-parity.md
 *  - 2026-06-23-crush-inspired-tui-provider-discovery.md (status vocabulary §1.3,
 *    capability badges §1.2, provider discovery shape §3.1, required surfaces §2)
 *  - 2026-06-23-four-agentic-developer-build-plan.md §1.3/§2.0 (interface freeze +
 *    mock-first: TUI consumes Dev 2 `ProviderAvailability` via a TUI-owned view-model)
 *
 * Secret-safety rule (FR-21, crush doc §3.2): provider/model state carries env-var
 * NAMES and presence booleans only. No token/key/credential VALUES, hashes,
 * prefixes, suffixes, or lengths are ever stored here.
 *
 * All object schemas are `.strict()` to match repo convention (see src/core/types.ts).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitive vocabularies (frozen by the Crush TUI requirement)
// ---------------------------------------------------------------------------

/**
 * Provider/model availability vocabulary. Frozen — see crush doc §1.3.
 * Do NOT rename values; the model picker, status badges, and discovery consumers
 * all key off these literals.
 */
export const TuiRouteStatusSchema = z.enum([
  "active",
  "ready-unverified",
  "missing-key",
  "needs-login",
  "router-offline",
  "pending-quota",
  "works-with-caveat",
  "delegated",
  "excluded-by-policy"
]);
export type TuiRouteStatus = z.infer<typeof TuiRouteStatusSchema>;

/**
 * Capability badges shown on model rows. Frozen — see crush doc §1.2.
 */
export const TuiCapabilitySchema = z.enum([
  "text",
  "vision",
  "tools",
  "web",
  "reasoning",
  "long-context",
  "router",
  "direct",
  "oauth",
  "api-key",
  "local"
]);
export type TuiCapability = z.infer<typeof TuiCapabilitySchema>;

/**
 * How a credential was observed (presence only). Frozen — crush doc §3.1.
 * Mirrors Dev 2 `ProviderAvailability.credentialSourceTypes`.
 */
export const TuiCredentialSourceTypeSchema = z.enum([
  "process-env",
  "user-env",
  "env-file",
  "auth-file",
  "oauth-cache",
  "adc",
  "router",
  "none"
]);
export type TuiCredentialSourceType = z.infer<typeof TuiCredentialSourceTypeSchema>;

/**
 * Provider grouping used by the model picker (providers grouped first).
 * Frozen — crush doc §3.1.
 */
export const TuiProviderGroupSchema = z.enum([
  "direct",
  "oauth",
  "api-key",
  "router",
  "provider-cli",
  "local",
  "mcp"
]);
export type TuiProviderGroup = z.infer<typeof TuiProviderGroupSchema>;

/**
 * Route type (direct-first routing policy). Frozen — FR-03 / build-plan D2.0.
 * `operator-provider-plan-auth` and `native-cli` must NOT be routed through the
 * LiteLLM bridge (those are client-locked plan/OAuth tokens, not API keys).
 */
export const TuiRouteTypeSchema = z.enum([
  "direct-api",
  "operator-provider-plan-auth",
  "native-cli",
  "router-bridge",
  "delegated",
  "deferred",
  "excluded"
]);
export type TuiRouteType = z.infer<typeof TuiRouteTypeSchema>;

/**
 * A credential/env-var NAME or alias label (not a value). Intentionally permissive
 * (length-bounded string) so real provider names/aliases are not rejected; it does
 * NOT structurally forbid values. The name-only guarantee is a runtime contract
 * enforced by `assertSecretSafeState` in state.ts, which scans the credential-
 * metadata fields for known secret shapes. Do not assume type-level safety here.
 */
export const TuiNameSchema = z.string().trim().min(1).max(256);
export type TuiName = z.infer<typeof TuiNameSchema>;

// ---------------------------------------------------------------------------
// Provider / model view-model (consumes Dev 2 ProviderAvailability)
// ---------------------------------------------------------------------------

export const TuiCostSchema = z
  .object({
    /** Free-form human hint, e.g. "paid", "plan-included", "credit-metered". Never a key. */
    lane: z.string().trim().min(1).max(64),
    /** Optional per-1M-token hint if known. Numbers only, no billing secrets. */
    inputPerMillionUsd: z.number().nonnegative().optional(),
    outputPerMillionUsd: z.number().nonnegative().optional()
  })
  .strict();
export type TuiCost = z.infer<typeof TuiCostSchema>;

export const TuiModelLimitsSchema = z
  .object({
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional()
  })
  .strict();
export type TuiModelLimits = z.infer<typeof TuiModelLimitsSchema>;

export const TuiModelEntrySchema = z
  .object({
    modelId: z.string().trim().min(1),
    label: z.string().trim().min(1),
    /** Router aliases that resolve to this model, e.g. ["router-minimax-m3"]. Names only. */
    aliases: z.array(TuiNameSchema).default([]),
    routeType: TuiRouteTypeSchema,
    capabilities: z.array(TuiCapabilitySchema).default([]),
    limits: TuiModelLimitsSchema.optional(),
    cost: TuiCostSchema.optional(),
    status: TuiRouteStatusSchema,
    /** Short, safe caveat text (e.g. "low max tokens"). Never a secret. */
    caveats: z.array(z.string().trim().min(1).max(200)).default([]),
    /** Last smoke sentinel marker, e.g. "ok"/"pending"/"failing". Not a token. */
    verificationMarker: z.string().trim().min(1).max(32).optional()
  })
  .strict();
export type TuiModelEntry = z.infer<typeof TuiModelEntrySchema>;

/**
 * A provider row in the picker. This is the TUI-owned view-model that Dev 2's
 * `ProviderAvailability` (src/providers/*, crush doc §3.1) maps INTO.
 * Frozen here so D4.2 can build the picker against a fixture before Dev 2 lands.
 */
export const TuiProviderEntrySchema = z
  .object({
    providerId: z.string().trim().min(1),
    displayName: z.string().trim().min(1),
    group: TuiProviderGroupSchema,
    status: TuiRouteStatusSchema,
    /** Required credential NAMES (env vars / auth files). Never values. */
    requiredEnvNames: z.array(TuiNameSchema).default([]),
    /** Which of the required names were observed present. Names only. */
    presentEnvNames: z.array(TuiNameSchema).default([]),
    credentialSourceTypes: z.array(TuiCredentialSourceTypeSchema).default([]),
    models: z.array(TuiModelEntrySchema).default([]),
    /** Docs links/paths shown in the setup hint. */
    docs: z.array(z.string().trim().min(1).max(512)).default([]),
    /** One safe next action, env/auth names only (crush doc §1.5). */
    safeSetupHint: z.string().trim().min(1).max(400).optional(),
    /** ISO-8601 timestamp of last discovery pass. */
    lastCheckedAt: z.string().trim().min(1)
  })
  .strict();
export type TuiProviderEntry = z.infer<typeof TuiProviderEntrySchema>;

// ---------------------------------------------------------------------------
// Model picker + route detail panels (crush doc §2.2/§2.3)
// ---------------------------------------------------------------------------

export const TuiModelPickerSchema = z
  .object({
    /** Providers available to render (refreshed by the host from discovery). */
    providers: z.array(TuiProviderEntrySchema).default([]),
    /** Provider rows currently expanded to reveal nested models. */
    expandedProviderIds: z.array(z.string().trim().min(1)).default([]),
    /** Active search/filter query (free text, user-typed). */
    query: z.string().max(200).default(""),
    selectedProviderId: z.string().trim().min(1).optional(),
    selectedModelId: z.string().trim().min(1).optional()
  })
  .strict();
export type TuiModelPicker = z.infer<typeof TuiModelPickerSchema>;

/** Route detail panel payload (crush doc §2.3). */
export const TuiRouteDetailSchema = z
  .object({
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    routeType: TuiRouteTypeSchema,
    endpoint: z.string().trim().min(1).max(512).optional(),
    credentialSourceType: TuiCredentialSourceTypeSchema,
    capabilities: z.array(TuiCapabilitySchema).default([]),
    limits: TuiModelLimitsSchema.optional(),
    cost: TuiCostSchema.optional(),
    verificationMarker: z.string().trim().min(1).max(32).optional(),
    docs: z.array(z.string().trim().min(1).max(512)).default([]),
    caveats: z.array(z.string().trim().min(1).max(200)).default([])
  })
  .strict();
export type TuiRouteDetail = z.infer<typeof TuiRouteDetailSchema>;

/** Router panel state (crush doc §2.4 / FR-04). Names + booleans only. */
export const TuiRouterStateSchema = z
  .object({
    healthy: z.boolean(),
    healthEndpoint: z.string().trim().min(1).max(512).optional(),
    configPath: z.string().trim().min(1).max(512).optional(),
    aliasCount: z.number().int().nonnegative(),
    /** Required env NAMES the router config references that are missing. */
    missingEnvNames: z.array(TuiNameSchema).default([]),
    lastSmokeSentinel: z.string().trim().min(1).max(32).optional()
  })
  .strict();
export type TuiRouterState = z.infer<typeof TuiRouterStateSchema>;

// ---------------------------------------------------------------------------
// Transcript, tool cards, composer, status/footer (FR-15)
// ---------------------------------------------------------------------------

export const TuiTranscriptEntryKindSchema = z.enum([
  "user-text",
  "assistant-text",
  "assistant-thinking",
  "tool-call",
  "tool-result",
  "image",
  "attachment",
  "system",
  "custom"
]);
export type TuiTranscriptEntryKind = z.infer<typeof TuiTranscriptEntryKindSchema>;

export const TuiTranscriptEntrySchema = z
  .object({
    id: z.string().trim().min(1),
    kind: TuiTranscriptEntryKindSchema,
    text: z.string().max(200000).optional(),
    /** For tool-call/tool-result kinds: links to the card id. */
    toolCardId: z.string().trim().min(1).optional(),
    /** Image/attachment path or reference label (not file contents). */
    attachmentRef: z.string().trim().min(1).max(512).optional(),
    modelId: z.string().trim().min(1).optional(),
    thinkingLevel: z.string().trim().min(1).max(32).optional(),
    createdAt: z.string().trim().min(1),
    /** UI collapse state for long tool/thinking blocks. */
    collapsed: z.boolean().default(false)
  })
  .strict();
export type TuiTranscriptEntry = z.infer<typeof TuiTranscriptEntrySchema>;

export const TuiTranscriptSchema = z
  .object({
    entries: z.array(TuiTranscriptEntrySchema).default([])
  })
  .strict();
export type TuiTranscript = z.infer<typeof TuiTranscriptSchema>;

export const TuiToolCardStatusSchema = z.enum(["pending", "running", "success", "warning", "error", "aborted"]);
export type TuiToolCardStatus = z.infer<typeof TuiToolCardStatusSchema>;

export const TuiToolCardSchema = z
  .object({
    id: z.string().trim().min(1),
    toolName: z.string().trim().min(1),
    /** Short, secret-sanitized argument summary (host responsibility). */
    argsSummary: z.string().max(4000).default(""),
    status: TuiToolCardStatusSchema,
    /** Short, secret-sanitized result summary (host responsibility). */
    resultSummary: z.string().max(20000).optional(),
    startedAt: z.string().trim().min(1).optional(),
    endedAt: z.string().trim().min(1).optional(),
    collapsed: z.boolean().default(false)
  })
  .strict();
export type TuiToolCard = z.infer<typeof TuiToolCardSchema>;

export const TuiMessageQueueKindSchema = z.enum(["steering", "follow-up"]);
export type TuiMessageQueueKind = z.infer<typeof TuiMessageQueueKindSchema>;

export const TuiAttachmentSchema = z
  .object({
    /** Path or label only — never inlined file bytes. */
    ref: z.string().trim().min(1).max(512),
    kind: z.enum(["file", "image"]).default("file")
  })
  .strict();
export type TuiAttachment = z.infer<typeof TuiAttachmentSchema>;

export const TuiComposerSchema = z
  .object({
    draft: z.string().max(200000).default(""),
    multiline: z.boolean().default(true),
    attachments: z.array(TuiAttachmentSchema).default([]),
    /** Pending queued messages not yet sent (steering interrupts, follow-up waits). */
    queued: z
      .array(
        z
          .object({
            kind: TuiMessageQueueKindSchema,
            text: z.string().min(1).max(200000)
          })
          .strict()
      )
      .default([]),
    /** Non-empty when an external editor session is open. */
    externalEditorOpen: z.boolean().default(false)
  })
  .strict();
export type TuiComposer = z.infer<typeof TuiComposerSchema>;

export const TuiTokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    contextWindow: z.number().int().positive().optional(),
    /** Accumulated cost hint in USD (numbers only, no billing secrets). */
    costUsd: z.number().nonnegative().optional()
  })
  .strict();
export type TuiTokenUsage = z.infer<typeof TuiTokenUsageSchema>;

export const TuiStatusFootSchema = z
  .object({
    cwd: z.string().trim().min(1).max(1024),
    sessionId: z.string().trim().min(1).max(128).optional(),
    modelId: z.string().trim().min(1).max(128).optional(),
    providerId: z.string().trim().min(1).max(128).optional(),
    thinkingLevel: z.string().trim().min(1).max(32).optional(),
    usage: TuiTokenUsageSchema.optional(),
    /** True while an assistant turn is streaming. */
    busy: z.boolean().default(false)
  })
  .strict();
export type TuiStatusFoot = z.infer<typeof TuiStatusFootSchema>;

// ---------------------------------------------------------------------------
// Session tree (flat, parentId-based — faithful to FR-14 append-only JSONL)
// ---------------------------------------------------------------------------

export const TuiSessionNodeSchema = z
  .object({
    id: z.string().trim().min(1),
    parentId: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().min(1).max(2000).optional(),
    modelId: z.string().trim().min(1).max(128).optional(),
    thinkingLevel: z.string().trim().min(1).max(32).optional(),
    createdAt: z.string().trim().min(1)
  })
  .strict();
export type TuiSessionNode = z.infer<typeof TuiSessionNodeSchema>;

export const TuiSessionTreeSchema = z
  .object({
    /** Flat node map keyed by session id (avoids recursive Zod; matches FR-14). */
    nodes: z.record(z.string(), TuiSessionNodeSchema).default({}),
    activeSessionId: z.string().trim().min(1).optional(),
    expandedIds: z.array(z.string().trim().min(1)).default([])
  })
  .strict();
export type TuiSessionTree = z.infer<typeof TuiSessionTreeSchema>;

/**
 * A projected child for rendering, built from the flat session map by
 * `buildSessionForest` in state.ts. This is a render-only projection — it is never
 * persisted or validated, so it is a plain TS interface (recursive interfaces are
 * fine in TS) rather than a recursive Zod schema (which TS cannot infer).
 */
export interface TuiSessionTreeNode {
  readonly node: TuiSessionNode;
  readonly children: readonly TuiSessionTreeNode[];
}

// ---------------------------------------------------------------------------
// Commands, keybindings, palette (FR-15 slash completion + keybinding config)
// ---------------------------------------------------------------------------

export const TuiCommandCategorySchema = z.enum([
  "navigation",
  "composition",
  "model",
  "session",
  "tools",
  "router",
  "system",
  "extension"
]);
export type TuiCommandCategory = z.infer<typeof TuiCommandCategorySchema>;

export const TuiCommandSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(400).optional(),
    /** Slash invocation, e.g. "/models". */
    slash: z.string().trim().min(1).max(64).optional(),
    category: TuiCommandCategorySchema,
    /** Default keybinding combo, e.g. "ctrl+p". Optional; may be unset. */
    defaultKey: z.string().trim().min(1).max(32).optional()
  })
  .strict();
export type TuiCommand = z.infer<typeof TuiCommandSchema>;

export const TuiCommandPaletteSchema = z
  .object({
    open: z.boolean().default(false),
    query: z.string().max(200).default(""),
    /** Command ids currently matched + selectable. */
    matchedCommandIds: z.array(z.string().trim().min(1)).default([]),
    selectedIndex: z.number().int().nonnegative().default(0),
    /** Last command id the user ran from the palette (host observable signal). */
    lastRunCommandId: z.string().trim().min(1).max(80).optional()
  })
  .strict();
export type TuiCommandPalette = z.infer<typeof TuiCommandPaletteSchema>;

export const TuiKeybindingScopeSchema = z.enum(["global", "transcript", "composer", "picker", "palette"]);
export type TuiKeybindingScope = z.infer<typeof TuiKeybindingScopeSchema>;

export const TuiKeybindingSchema = z
  .object({
    /** Normalized combo, lowercased, e.g. "ctrl+k", "alt+enter", "escape". */
    combo: z.string().trim().min(1).max(32),
    commandId: z.string().trim().min(1),
    scope: TuiKeybindingScopeSchema.default("global"),
    description: z.string().trim().min(1).max(200).optional()
  })
  .strict();
export type TuiKeybinding = z.infer<typeof TuiKeybindingSchema>;

export const TuiKeymapSchema = z.array(TuiKeybindingSchema).default([]);
export type TuiKeymap = z.infer<typeof TuiKeymapSchema>;

// ---------------------------------------------------------------------------
// Layout / panes / renderer extension seam (FR-07)
// ---------------------------------------------------------------------------

export const TuiPaneSchema = z.enum([
  "transcript",
  "composer",
  "status",
  "model-picker",
  "provider-detail",
  "session-tree",
  "command-palette",
  "router-panel",
  "readiness-panel"
]);
export type TuiPane = z.infer<typeof TuiPaneSchema>;

export const TuiLayoutSchema = z
  .object({
    focusedPane: TuiPaneSchema.default("composer"),
    /** Panes currently visible/active. */
    visiblePanes: z.array(TuiPaneSchema).default([
      "transcript",
      "composer",
      "status"
    ])
  })
  .strict();
export type TuiLayout = z.infer<typeof TuiLayoutSchema>;

/**
 * Descriptor for a registered message renderer (FR-07 extension seam).
 * The actual render function lives in code (see MessageRenderer interface in
 * state.ts); this schema captures the registry metadata so it can be surfaced,
 * ordered by priority, and matched to entry kinds.
 */
export const TuiMessageRendererDescriptorSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1).max(80),
    supportedKinds: z.array(TuiTranscriptEntryKindSchema).default([]),
    priority: z.number().int().min(0).default(100)
  })
  .strict();
export type TuiMessageRendererDescriptor = z.infer<typeof TuiMessageRendererDescriptorSchema>;

/** Descriptor for an extension-contributed overlay/widget (FR-07). */
export const TuiWidgetDescriptorSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1).max(80),
    pane: TuiPaneSchema,
    priority: z.number().int().min(0).default(100)
  })
  .strict();
export type TuiWidgetDescriptor = z.infer<typeof TuiWidgetDescriptorSchema>;

export const TuiStateSchema = z
  .object({
    layout: TuiLayoutSchema,
    transcript: TuiTranscriptSchema,
    composer: TuiComposerSchema,
    status: TuiStatusFootSchema,
    modelPicker: TuiModelPickerSchema,
    routeDetail: TuiRouteDetailSchema.optional(),
    router: TuiRouterStateSchema.optional(),
    sessionTree: TuiSessionTreeSchema,
    palette: TuiCommandPaletteSchema,
    /** Commands registered (built-ins + extension contributions). */
    commands: z.array(TuiCommandSchema).default([]),
    keymap: TuiKeymapSchema,
    /** Registered renderer/widget descriptors (extension seam metadata). */
    messageRenderers: z.array(TuiMessageRendererDescriptorSchema).default([]),
    widgets: z.array(TuiWidgetDescriptorSchema).default([]),
    /** Active theme id (resolved via src/resources/themes.ts). */
    themeId: z.string().trim().min(1).max(80).optional(),
    /** False until the launch-time readiness scan completes (crush doc §1.1). */
    ready: z.boolean().default(false)
  })
  .strict();
export type TuiState = z.infer<typeof TuiStateSchema>;
