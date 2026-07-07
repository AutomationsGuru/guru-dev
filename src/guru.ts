#!/usr/bin/env node

/**
 * `guru` — the interactive GuruHarness surface (interactive REPL).
 *
 * Launches a live harness session, connects a real model over a direct-first route
 * from the provider catalog, and exposes slash commands: /help /status /model /models
 * /sessions /skills /settings /login /tools /clear /exit. Non-slash input is a real
 * chat turn against the connected route (direct-first; never the LiteLLM router).
 *
 * Honesty rules: credential presence is reported by env NAME only; routes without a
 * usable credential connect only after the operator fixes the env; nothing fakes a
 * model response. Secret values are never printed.
 */

import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";

import { getRuntimeInfo, loadHarnessConfig } from "./index.js";
import { createHarnessRuntime, type HarnessRuntime } from "./runtime/session.js";
import type { HarnessSession } from "./runtime/schemas.js";
import { createDirectProviderCatalog } from "./providers/catalog.js";
import { scanProviderReadiness, type ProviderAvailability } from "./providers/discovery.js";
import { planRoute } from "./providers/routePlanner.js";
import type { ProviderRouteDescriptor } from "./providers/schemas.js";
import { DirectChatError, isChatCapableFamily, registerCredentialVault, resolveRouteCredential, type ChatTurnMessage, type DirectChatResult } from "./model/directChat.js";
import { openVault, type Vault } from "./safety/vault.js";
import { registerSecretValue } from "./safety/secretSafety.js";
import { directAgentTurn, type AgentToolEvent } from "./model/agentTurn.js";
import { isOperatorAuthRoute, resolveOperatorAuthPresence, getOperatorAuthSpec } from "./model/operatorAuth.js";
import type { ToolDefinition } from "./tools/registry.js";
import { DEFAULT_ANSI_THEME, bold, colorize, dim, STATUS_COLOR } from "./tui/ansi.js";
import { mapRoutesToProviders, renderProviderPicker, renderReadinessSummary, summarizeReadiness } from "./tui/providerPicker.js";
import { deriveConversationTitle } from "./guru/conversationStore.js";
import { createSessionLogStore, type ReconstructedSession, type SessionLineage, type SessionLogStore } from "./guru/sessionLog.js";
import { importExternalSession, type ForeignHarness } from "./guru/importSession.js";
import { detectSuitIntent, formatTodayLine } from "./guru/launchContext.js";
import { buildSessionTree, type TreeFilter } from "./guru/sessionTree.js";
import { createFileMemoryStore } from "./memory/store.js";
import { mergeScopedBootInjection } from "./memory/inject.js";
import { buildRecallIndex, queryRecall } from "./memory/recall.js";
import { createScopedMemory, MEMORY_SCOPES, type MemoryScope } from "./memory/scopes.js";
import { citeLearning, decaySweep, extractLearnings, gateLearning, promoteSweep, type Learning } from "./garage/flywheel.js";
import { loadLearnings, migrateRoleLearnings, pruneLearning, storeLearning } from "./garage/flywheelStore.js";
import { describeLoginFlow, formatExpiry } from "./model/loginFlow.js";
import { isTokenNearExpiry, loginViaLoopback, OAuthRefreshError, readCodexCacheToken, refreshOAuthToken, resolveOAuthConfig } from "./model/oauth/openaiCodexLogin.js";
import { loginViaXaiDeviceCode, readGrokCacheToken, refreshXaiToken, resolveXaiOAuthConfig } from "./model/oauth/xaiGrokLogin.js";
import { registerOAuthTokenAccessor } from "./model/oauth/tokenRegistry.js";
import { readVaultOAuthToken, writeVaultOAuthToken } from "./model/oauth/vaultTokens.js";
import { slugifyRole, type RoleProfile } from "./roles/schema.js";
import { listRoles, roleAgeDays, recordPathOutcome, ROLE_STALE_AFTER_DAYS } from "./roles/store.js";
import { assembleSuit, verifyModelForRole } from "./roles/assemble.js";
import { listManifests, loadManifest, parkManifest } from "./garage/store.js";
import { execFileSync, spawnSync } from "node:child_process";
import { AgentSession } from "./session/agentSession.js";
import { runRpcMode } from "./surfaces/rpc.js";
import { runBootRitual, type BootRitualHooks, type PhaseOutput } from "./boot/ritual.js";
import { incrementSessionCounter } from "./boot/sessionCounter.js";
import { evaluateAndClose, loadGapRecords, makeGapRecord, saveGapRecords, upsertGapRecords } from "./garage/gapRecords.js";
import { bridgeBadge, bridgeGapId, bridgeGapRecords, bridgeManifests, promoteBridgeSkillFile } from "./skills/bridge.js";
import { resolveCapabilityGap, type NeverStuckMove } from "./selfbuild/resolver.js";
import { computeLayerHash, manifestToRoleProfile, reverifyForLoad, roleProfileToManifest, type GarageLayer } from "./garage/manifest.js";
import { getSharedSwarmManager } from "./swarm/manager.js";
import { setResolverContext } from "./selfbuild/resolverTool.js";
import { createLookAheadEngine, type LookAheadEngine } from "./lookahead/engine.js";
import { createForkEnumerator } from "./lookahead/forks.js";
import { createMandateStore, type MandateStore } from "./mandates/store.js";
import { evaluateToolMandate, MANDATE_READ_ONLY_TOOLS } from "./mandates/evaluate.js";
import { HARD_EDGE_VERBS, type MandateState, type MandateVerb } from "./mandates/schema.js";
import { resolveApproval, type ApprovalChoice, type ApprovalRequest } from "./mandates/approval.js";
import {
  estimateTranscriptTokens,
  runCompaction,
  shouldCompact,
  SUMMARY_ENTRY_PREFIX,
  type BeforeCompactHook,
  type CompactHook,
  type CompactionConfig,
  type CompactionState,
  type SummarizeRequest,
  type TranscriptEntry
} from "./compaction/index.js";
import type { RetryConfig } from "./model/retryPolicy.js";
import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import { createPainter, loadTheme, type Painter } from "./tui/theme.js";
import { renderSplash } from "./tui/splash.js";
import { badge, compactMark, GLYPHS, renderTable, roundedBox, spinnerFrame, visibleWidth } from "./tui/components.js";
import { createMenuState, enterDrill, menuReduce, refilter, selectedItem, type MenuItem, type MenuKey, type MenuState } from "./tui/menu.js";
import { composerTopRule, composerHintLine } from "./tui/composer.js";
import {
  charDisplayWidth,
  createEditorState,
  editorReduce,
  editorText,
  isMultiline,
  promptWidth,
  renderEditorFrame,
  stringDisplayWidth,
  withBufferText
} from "./tui/editor.js";
import { completePathToken, filterFiles, scanRepoFiles, type PathCompletion, type RepoFileScan } from "./tui/filePicker.js";
import { expandReferences } from "./tui/references.js";
import { discoverPromptTemplates, expandTemplate, type PromptTemplate } from "./prompts/templates.js";
import { createKeyDecoder } from "./tui/keys.js";
import type { EditorKey } from "./tui/editor.js";

const loadedTheme = loadTheme();
const paint: Painter = createPainter({ tokens: loadedTheme.tokens, name: loadedTheme.name });

// Legacy surfaces (provider picker, readiness, scattered colorize/dim calls) speak
// the named-color AnsiTheme. Map those names onto the BRAND tokens so every legacy
// surface converges on the design system: green→success, yellow→warning, red→error,
// cyan→info, magenta→accent2. At level none all codes blank (§7: NO_COLOR/non-TTY).
function buildBrandAnsiTheme(): typeof DEFAULT_ANSI_THEME {
  if (paint.level === "none") {
    return {
      reset: "",
      dim: "",
      bold: "",
      fg: Object.fromEntries(Object.keys(DEFAULT_ANSI_THEME.fg).map((key) => [key, ""])) as typeof DEFAULT_ANSI_THEME.fg
    };
  }
  return {
    reset: "\x1b[0m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    fg: {
      default: "",
      bright: paint.open("fgBright"),
      green: paint.open("success"),
      yellow: paint.open("warning"),
      red: paint.open("error"),
      cyan: paint.open("info"),
      magenta: paint.open("accent2"),
      blue: paint.open("info"),
      white: paint.open("fg")
    }
  };
}
const theme = buildBrandAnsiTheme();

interface GuruState {
  runtime: HarnessRuntime;
  session: HarnessSession | null;
  sessionTools: readonly ToolDefinition[];
  routes: readonly ProviderRouteDescriptor[];
  availability: readonly ProviderAvailability[];
  connectedRoute: ProviderRouteDescriptor | null;
  modelIdOverride: string | null;
  history: ChatTurnMessage[];
  usage: { inputTokens: number; outputTokens: number; turns: number; lastInputTokens: number };
  /** Verbs the operator approved "always" this session (per-call approval, v0.22). */
  sessionApprovals: Set<MandateVerb>;
  mandateStore: MandateStore;
  mandate: MandateState;
  yolo: boolean;
  activeRole: RoleProfile | null;
  toolsUsed: Set<string>;
  lookahead: LookAheadEngine;
  busy: boolean;
  /** The encrypted credential vault (env-var alternative). Mutated by /keys. */
  vault: Vault;
  store: SessionLogStore;
  conversationId: string;
  createdAt: string;
  /** Session tree (§6): this session's lineage back to a parent (null = a root). */
  lineage: SessionLineage | null;
  /** Assistant turns since this branch was entered — gates branch-summary generation. */
  turnsThisBranch: number;
  /** Append-only bookkeeping: last meta signature written, last compaction count logged. */
  lastMetaSig: string;
  lastCompactionCount: number;
  compaction: GuruCompactionState;
  /** Turn-loop retry policy (ADR 2026-07-05) — wired into every directAgentTurn. */
  retryConfig: RetryConfig;
  /** Discovered prompt templates (Composer Completion wave); refreshed at boot/reload. */
  promptTemplates: readonly PromptTemplate[];
  /** Monotonic boot session number (Boot Ritual wave) — the flywheel's real decay clock. */
  sessionNumber: number;
  /** The unified turn engine (Engine Extraction v0.18b): the TUI drives THIS. */
  agentSession: AgentSession | null;
}

/** Retry indicator (checklist P0): attempt N/M · delay · reason, compaction-style. */
function printRetryIndicator(info: { attempt: number; maxAttempts: number; delayMs: number; reason: string }): void {
  print(
    `  ${paint.fg("warning", "↻")} ${paint.fg("muted", `retrying… attempt ${info.attempt}/${info.maxAttempts} · in ${(info.delayMs / 1000).toFixed(1)}s (${info.reason})`)}`
  );
}

/** REPL-side compaction state (Runtime Survival wave, ADR 2026-07-04). */
interface GuruCompactionState {
  config: CompactionConfig;
  /** File ops tracked at the executeTool seam — cumulative across compactions. */
  files: { readFiles: Set<string>; modifiedFiles: Set<string> };
  last: CompactionState | null;
  running: boolean;
  /** ADR degrade path: after a failed/no-op compaction THIS turn sends slice(-13). */
  sendLegacyWindowThisTurn: boolean;
  /** Anti-thrash: estimate at the last no-op threshold attempt; retry only on growth. */
  noopEstimate: number | null;
}

const SYSTEM_PROMPT =
  "You are GuruHarness, a repo-aware agent harness running in the user's terminal. You have registered tools — USE them to answer questions about the repository, environment, skills, memory, or readiness instead of guessing. Answer concisely and honestly about what is and is not implemented.";

/**
 * Memory organ (Foundation Wave PR 2): guru's own handle on the global file
 * memory. Boot injection (push-recall) appends the derived index to the system
 * prompt; /remember updates it live so the current session sees new facts too.
 */
const guruMemoryStore = createFileMemoryStore();
/**
 * The scoped-memory organ (§7): global (the store above — garage/gaps live here),
 * plus a space store for the session repo and a role store for the worn suit, both
 * bound lazily (setRepoRoot at session start, setRole at suit-up/park). Boot
 * injection merges across the active scopes; /remember + the flywheel address one.
 */
const scopedMemory = createScopedMemory(guruMemoryStore);
let bootMemoryBlock = "";
/** Learning ids injected into THIS session's boot block — the CITE candidates. */
let injectedLearningIds: readonly string[] = [];

function systemPrompt(): string {
  // §17 scenario 14: the model always knows the actual date (point-in-time context).
  return `${SYSTEM_PROMPT}\n\n${formatTodayLine(new Date())}${bootMemoryBlock}`;
}

/**
 * Rebuild the injected memory block. With a `query` (Smart Connections, §7), the
 * facts are BM25-ranked by relevance to it (the current turn) and its terms seed
 * the learnings task-boost; without one, the cold recency/decay ordering.
 */
function refreshBootMemoryBlock(query?: string): void {
  try {
    const injection = mergeScopedBootInjection(scopedMemory.activeStores(), query ? { query } : {});
    bootMemoryBlock = injection.block;
    injectedLearningIds = injection.injectedLearningIds;
  } catch {
    bootMemoryBlock = "";
    injectedLearningIds = [];
  }
}

/** Flywheel decay clocks: sessions primary (§8), days as the fallback for pre-counter learnings. */
const FLYWHEEL_DECAY = { reviewAfterDays: 14, pruneAfterDays: 28 };
const FLYWHEEL_DECAY_SESSIONS = { reviewAfterSessions: 8, pruneAfterSessions: 16 };
/** L0→L3 diagonal (§8): validated L1→L2 at 2 cites, L2→L3 at 4; uncited skills demote after 12. */
const FLYWHEEL_PROMOTION = { promoteToSkill: 2, promoteToRule: 4, demoteAfterSessions: 12 };

/**
 * The knowledge flywheel write-side, run at park (§8): EXTRACT the session's
 * grounded learnings, GATE them, STORE the admitted ones, CITE the injected
 * learnings this session actually used, then DECAY-sweep (supersede / prune stale
 * / surface review + cross-level conflicts). Returns a one-line receipt tail.
 */
function runFlywheelAtPark(roleSlug: string, earnedTools: readonly string[], usedTools: ReadonlySet<string>, routeId: string, turns: number, sessionNumber: number): string {
  let extracted = 0;
  let cited = 0;
  let pruned = 0;
  let flagged = 0;
  let promoted = 0;
  let demoted = 0;
  // Address the role scope (§7): a suit's learnings compound in its own namespace.
  // Falls back to global if the role store isn't resolvable (should not happen at park).
  const store = scopedMemory.storeFor("role") ?? guruMemoryStore;
  try {
    // EXTRACT + GATE + STORE.
    const existing = new Set(loadLearnings(store).map((learning) => learning.id));
    for (const learning of extractLearnings({ roleSlug, toolsUsed: earnedTools, routeId, turns, now: () => new Date(), currentSession: sessionNumber })) {
      const gate = gateLearning(learning, existing);
      if (gate.admit) {
        storeLearning(store, learning);
        existing.add(learning.id);
        extracted += 1;
      }
    }
    // CITE — an injected learning whose tools were all used this session earns a citation.
    const injected = new Set(injectedLearningIds);
    for (const learning of loadLearnings(store)) {
      if (!injected.has(learning.id) || learning.tools.length === 0) {
        continue;
      }
      if (learning.tools.every((tool) => usedTools.has(tool))) {
        const cite: Learning = citeLearning(learning, { at: new Date().toISOString(), outcome: `used in ${roleSlug} session` }, sessionNumber);
        storeLearning(store, cite);
        cited += 1;
      }
    }
    // DECAY — supersede contradicted, prune stale (by SESSION now), surface review + conflicts.
    const sweep = decaySweep(loadLearnings(store), new Date(), FLYWHEEL_DECAY, { currentSession: sessionNumber, ...FLYWHEEL_DECAY_SESSIONS });
    for (const learning of sweep.prune) {
      pruneLearning(store, learning.id, learning.confidence < 0.3 ? "flywheel decay: stale + uncited" : "flywheel: superseded by a newer contradicting learning");
      pruned += 1;
    }
    flagged = sweep.review.length + sweep.conflicts.length;
    for (const conflict of sweep.conflicts) {
      print(colorize(theme, "yellow", `  ⚠ flywheel conflict (review): L3 rule vs L2 skill on "${conflict.subject}" — never silent, resolve it`));
    }
    // The L0→L3 diagonal (§8): validated cited episodics cluster UP into skills/
    // rules; uncited skills fall DOWN. A level change re-ids the fact, so store the
    // new level and prune the old.
    const promotion = promoteSweep(loadLearnings(store), sessionNumber, FLYWHEEL_PROMOTION);
    for (const change of [...promotion.promoted, ...promotion.demoted]) {
      storeLearning(store, change.learning);
      if (change.oldId !== change.learning.id) {
        pruneLearning(store, change.oldId, `flywheel: ${change.from}→${change.to}`);
      }
    }
    promoted = promotion.promoted.length;
    demoted = promotion.demoted.length;
  } catch {
    // The flywheel is best-effort at park; a failure never blocks the park.
  }
  const levels = promoted > 0 || demoted > 0 ? ` · ${promoted} promoted · ${demoted} demoted` : "";
  return `${extracted} learned · ${cited} cited · ${pruned} pruned${levels}${flagged > 0 ? ` · ${flagged} to review` : ""}`;
}

/** Base tools that need repoRoot injected from the live session's repo context. */
const REPO_ROOT_TOOL_IDS: ReadonlySet<string> = new Set(["read", "write", "edit", "bash", "grep", "glob", "ls"]);

/** Tools the model may run without approval (read-only / no side effects). */
/**
 * Tools whose declarations are sent to the model in guru chat turns. The live
 * session still registers everything; this curates the model-facing surface to
 * task-relevant tools. Operational/store/git-PR/readiness tools stay operator-only —
 * in the 2026-07-02 scale shakedown the model wandered into service_readiness_report
 * (15s, zero task value) and burned tool budget; declaration payload also drops.
 */
export const GURU_CHAT_TOOL_IDS: ReadonlySet<string> = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "glob",
  "ls",
  "repo.context.resolve",
  "skills.catalog.list",
  "skill.document.load",
  "honcho_recall",
  "honcho_context",
  "memory_remember",
  "memory_search",
  "memory_get",
  "spawn_agent",
  "get_task_output",
  "kill_task",
  "resolve_capability_gap"
]);

export const READ_ONLY_TOOL_IDS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "repo.context.resolve",
  "skills.catalog.list",
  "skill.document.load",
  "honcho_memory_status",
  "honcho_recall",
  "honcho_context",
  "memory_search",
  "memory_get",
  "get_task_output",
  "resolve_capability_gap",
  "service_readiness_report",
  "maintenance.audit.run",
  "operational.project.get",
  "operational.state.list",
  "operational.backlog.list",
  "github.pr.status"
]);

export interface SlashCommand {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "/help", usage: "/help", description: "Show commands and hotkeys" },
  { name: "/status", usage: "/status", description: "Harness status: session, model, Honcho, routes" },
  { name: "/model", usage: "/model [routeId|#] [modelIdOverride]", description: "Browse providers or connect a route" },
  { name: "/models", usage: "/models", description: "Alias for /model" },
  { name: "/sessions", usage: "/sessions", description: "List saved conversations (resumable)" },
  { name: "/resume", usage: "/resume <id|#>", description: "Resume a saved conversation" },
  { name: "/new", usage: "/new", description: "Start a fresh conversation" },
  { name: "/tree", usage: "/tree [user|all]", description: "Navigate the session tree — fork points, child branches, summaries" },
  { name: "/fork", usage: "/fork <#>", description: "Branch a new session from a prior user turn (numbers from /tree)" },
  { name: "/clone", usage: "/clone", description: "Duplicate the active branch for destructive experiments" },
  { name: "/skills", usage: "/skills [promote <id>]", description: "List discovered skills ([bridge] = ATTACH); promote a bridge skill to native" },
  { name: "/remember", usage: "/remember [global|space|role] <fact>", description: "Save a durable memory fact to a scope (default global; injected at boot)" },
  { name: "/memory", usage: "/memory [status|doctor]", description: "Memory organ status / heal the index" },
  { name: "/recall", usage: "/recall <query>", description: "Smart Connections — surface memory semantically related to a query (BM25)" },
  { name: "/role", usage: "/role [list | suit <thing> | park | off]", description: "Suit up for the day's work (roles emerge; garage lists parked suits)" },
  { name: "/lookahead", usage: "/lookahead [on|off]", description: "The scout/commit look-ahead engine (config-gated; scouts run ahead in dead time)" },
  { name: "/compact", usage: "/compact [instructions]", description: "Fold older history into an LLM summary (auto-runs near the context window)" },
  { name: "/settings", usage: "/settings", description: "Show harness config (names only)" },
  { name: "/login", usage: "/login [provider]", description: "Credential presence, or a provider's login flow" },
  { name: "/accounts", usage: "/accounts", description: "Connected providers: source layer + expiry (values never shown)" },
  { name: "/keys", usage: "/keys [rm <NAME> | reload]", description: "The encrypted credential vault — an env-var alternative (add via `guru keys set <NAME>`)" },
  { name: "/logout", usage: "/logout <provider>", description: "How to disconnect a provider (guru holds no token file)" },
  { name: "/tools", usage: "/tools", description: "List live session tools" },
  { name: "/mandate", usage: "/mandate [grant space|machine <verbs> | list | revoke]", description: "Standing permission grants (this repo/computer is yours)" },
  { name: "/yolo", usage: "/yolo [on|off]", description: "YOLO mode: lift all permission gates (explicit ritual)" },
  { name: "/clear", usage: "/clear", description: "Clear the screen" },
  { name: "/exit", usage: "/exit | /quit | ctrl+d", description: "Leave the harness" }
];

/** Parse an input line into a slash command + args, or null when it is chat text. */
export function parseSlashCommand(line: string): { command: string; args: readonly string[] } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const [command = "", ...args] = trimmed.split(/\s+/u);
  return { command: command.toLowerCase(), args };
}

/** Pick the route a bare `/model <selector>` refers to: exact routeId, 1-based index, or providerId prefix. */
export function resolveRouteSelector(routes: readonly ProviderRouteDescriptor[], selector: string): ProviderRouteDescriptor | undefined {
  const byId = routes.find((route) => route.routeId === selector);
  if (byId) {
    return byId;
  }
  const index = Number.parseInt(selector, 10);
  if (Number.isInteger(index) && index >= 1 && index <= routes.length) {
    return sortedRoutes(routes)[index - 1];
  }
  return sortedRoutes(routes).find((route) => route.providerId === selector || route.routeId.startsWith(`${selector}/`));
}

export function sortedRoutes(routes: readonly ProviderRouteDescriptor[]): readonly ProviderRouteDescriptor[] {
  return [...routes].sort((a, b) => a.directFirstRank - b.directFirstRank || a.routeId.localeCompare(b.routeId));
}

function banner(): string {
  const info = getRuntimeInfo();
  const columns = process.stdout.columns ?? (Number(process.env.COLUMNS) || 80);
  const splash = renderSplash(paint, { version: info.version, themeName: paint.name, node: process.versions.node }, columns);
  return [
    "",
    splash.trimEnd(),
    "",
    paint.fg("muted", `  build ${resolveBuildStamp()} · agentic tools · streaming · resumable sessions`),
    paint.fg("muted", "  /help commands · /model connect a model · /resume continue a session · ctrl+d exit"),
    ""
  ].join("\n");
}

/** Freshness marker: mtime of the running bundle — no codegen, always honest. */
function resolveBuildStamp(): string {
  try {
    const stamp = statSync(fileURLToPath(import.meta.url)).mtime;
    return `${stamp.toISOString().slice(0, 10)} ${stamp.toTimeString().slice(0, 5)}`;
  } catch {
    return "unknown";
  }
}

function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/u, "")}k`;
  return String(value);
}

/** Statusline per spec §5: left `▲ <project>`; right model · tokens · turns, muted with values in fg. */
/**
 * Full-width status bar (the "indicators around the composer" — modern-TUI style):
 * cwd · suit · mode chips (YOLO / scout / mandate) · session tokens · context% ·
 * turns on the left; model · effort right-justified to the terminal edge. Pure so
 * it's testable at any width; reflows on resize.
 */
export function buildStatusBar(state: GuruState, columns: number = process.stdout.columns ?? 80): string {
  const project = state.session?.repo ? basename(state.session.repo.repoRoot) : "no repo";
  const sep = paint.fg("muted", " · ");

  const leftParts: string[] = [`${paint.fg("accent2", GLYPHS.agent)} ${paint.fg("fgBright", project)}`];
  if (state.activeRole) {
    leftParts.push(paint.fg("accent", state.activeRole.label));
  }
  const chips: string[] = [];
  if (state.yolo) {
    chips.push(paint.fg("warning", "⚡YOLO"));
  }
  if (state.lookahead.enabled) {
    chips.push(paint.fg("accent2", "⛃scout"));
  }
  if (state.mandate.grants.length > 0) {
    chips.push(paint.fg("success", "⛨mandate"));
  }
  if (chips.length > 0) {
    leftParts.push(chips.join(" "));
  }
  leftParts.push(`${paint.fg("fg", `${fmtTokens(state.usage.inputTokens)}/${fmtTokens(state.usage.outputTokens)}`)}${paint.fg("muted", " tok")}`);
  const ctxWindow = state.connectedRoute?.context?.contextWindowTokens;
  if (ctxWindow !== undefined && state.usage.lastInputTokens > 0) {
    const pct = Math.min(100, Math.round((state.usage.lastInputTokens / ctxWindow) * 100));
    const tone = pct < 60 ? "success" : pct < 85 ? "warning" : "error";
    leftParts.push(`${paint.fg("fg", `${fmtTokens(state.usage.lastInputTokens)}/${fmtTokens(ctxWindow)}`)}${paint.fg("muted", " ctx ")}${paint.fg(tone, `${pct}%`)}`);
  }
  leftParts.push(`${paint.fg("fg", String(state.usage.turns))}${paint.fg("muted", " turn(s)")}`);
  const left = leftParts.join(sep);

  const modelText = state.connectedRoute
    ? `${state.connectedRoute.routeId}${state.modelIdOverride ? ` (${state.modelIdOverride})` : ""}`
    : "none — /model";
  const effort = state.connectedRoute?.compat?.supportsReasoningEffort ? " · high" : "";
  const right = `${paint.fg("fgBright", modelText)}${paint.fg("muted", effort)}`;

  const gap = Math.max(2, columns - visibleWidth(left) - visibleWidth(right));
  return `${left}${" ".repeat(gap)}${right}`;
}

function statusLine(state: GuruState): string {
  return buildStatusBar(state);
}

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function cmdStatus(state: GuruState): Promise<void> {
  const honchoTool = state.session?.tools.find((tool) => tool.id === "honcho_memory_status");
  const summary = summarizeReadiness(mapRoutesToProviders(state.routes, { lastCheckedAt: new Date().toISOString(), env: process.env }));
  print(paint.bold(paint.fg("fgBright", "Guru Harness status")));
  const rows: string[][] = [
    [paint.fg("muted", "runtime"), `${getRuntimeInfo().name} ${getRuntimeInfo().version}`],
    [paint.fg("muted", "session"), state.session ? `${state.session.id.slice(0, 8)} ${paint.fg("fgFaint", `(${state.session.status})`)}` : "none"],
    [paint.fg("muted", "tools"), `${state.session?.tools.length ?? 0} registered${honchoTool ? " (incl. Honcho)" : ""}`],
    [paint.fg("muted", "model"), state.connectedRoute ? `${state.connectedRoute.routeId} ${paint.fg("fgFaint", `[${state.connectedRoute.apiFamily ?? "?"}]`)}` : "not connected"],
    [paint.fg("muted", "routes"), `${state.routes.length} in catalog · ${summary.active} active · ${summary.readyUnverified} ready · ${summary.missingOrLogin} missing/login`],
    [paint.fg("muted", "usage"), `${state.usage.inputTokens} in / ${state.usage.outputTokens} out · ${state.usage.turns} turn(s)`],
    [
      paint.fg("muted", "approval"),
      state.sessionApprovals.size > 0
        ? `${badge(paint, "PER-CALL", "brand")} ${paint.fg("fgFaint", `${[...state.sessionApprovals].join("+")} approved this session`)}`
        : `${badge(paint, "PER-CALL", "brand")} ${paint.fg("fgFaint", "each mutating call prompts (y/N/always)")}`
    ]
  ];
  for (const row of rows) {
    print(`  ${row[0]!.padEnd(paint.level === "none" ? 8 : 30)} ${row[1]!}`);
  }
}

function cmdModelList(state: GuruState): void {
  const providers = mapRoutesToProviders(state.routes, { lastCheckedAt: new Date().toISOString(), env: process.env });
  for (const line of renderProviderPicker(providers, theme)) {
    print(line);
  }
  for (const line of renderReadinessSummary(summarizeReadiness(providers), theme)) {
    print(line);
  }
  print("");
  print(bold(theme, "Connect: /model <routeId | #> [modelIdOverride]"));
  sortedRoutes(state.routes).forEach((route, index) => {
    const availability = state.availability.find((row) => row.routeId === route.routeId);
    const status = availability?.status ?? route.status;
    const marker = colorize(theme, STATUS_COLOR[status] ?? "default", status);
    const chat = isChatCapableFamily(route.apiFamily) ? "" : dim(theme, " (not chat-capable yet)");
    print(`  ${String(index + 1).padStart(2)}. ${route.routeId}  ${marker}${chat}`);
  });
}

function cmdModelConnect(state: GuruState, selector: string, override: string | undefined): void {
  const route = resolveRouteSelector(state.routes, selector);
  if (!route) {
    print(colorize(theme, "red", `No route matches '${selector}'. Try /model to list.`));
    return;
  }
  // Plan/OAuth lanes with REAL direct wiring (baseUrl + a credential the layered
  // resolver finds — an API key OR a vaulted OAuth token) connect DIRECT and run the
  // native tool loop. guru no longer delegates any turn to a provider CLI.
  const directReady = route.baseUrl !== undefined && isChatCapableFamily(route.apiFamily) && resolveRouteCredential(route).usable;
  if (isOperatorAuthRoute(route) && !directReady) {
    // A plan/OAuth lane that isn't directly connectable = not signed in with a token
    // guru can use. Sign in through guru's OWN /login (loopback OAuth → vaulted token),
    // then the turn runs natively — there is no CLI-delegate fallback anymore.
    const loginName = route.providerId.replace(/-direct$/u, "");
    const presence = resolveOperatorAuthPresence(route);
    print(colorize(theme, "yellow", `${route.routeId}: not signed in. Run /login ${loginName} to sign in through guru.`));
    print(dim(theme, `  hint: ${presence.summary}`));
    return;
  }

  const credential = resolveRouteCredential(route);
  if (!isChatCapableFamily(route.apiFamily)) {
    print(colorize(theme, "yellow", `${route.routeId} is not chat-capable in this slice (family: ${route.apiFamily ?? "unknown"}).`));
    const availability = state.availability.find((row) => row.routeId === route.routeId);
    for (const hint of availability?.setupHints ?? []) {
      print(dim(theme, `  hint: ${hint}`));
    }
    return;
  }
  if (!credential.usable) {
    print(colorize(theme, "yellow", `${route.routeId}: ${credential.reason}`));
    print(dim(theme, "  Connect after fixing the credential (env NAME above; value never shown)."));
    return;
  }
  state.connectedRoute = route;
  state.modelIdOverride = override ?? null;
  state.history = [{ role: "system", content: systemPrompt() }];
  print(colorize(theme, "green", `Connected: ${route.routeId}${override ? ` (model ${override})` : ""} — ${credential.reason}`));
  print(dim(theme, "  Type a message to chat. /status for details."));
}

/** Persist the current conversation transcript durably (create on first turn, update after). */
/**
 * Compaction wiring (Runtime Survival wave, ADR 2026-07-04-compaction-engine).
 *
 * The pure pieces below are exported for the deterministic acceptance suite; the
 * engine itself lives in src/compaction/. History adapter contract: index 0 is the
 * system head (never compacted); a system entry bearing SUMMARY_ENTRY_PREFIX is the
 * previous compaction summary (excluded from the compactable region — its text
 * feeds the next summary as iterative context, the summary algorithm).
 */

export interface CompactableHistory {
  readonly head: ChatTurnMessage;
  readonly entries: readonly TranscriptEntry[];
  readonly previousSummary: string | undefined;
}

export function historyToCompactionEntries(history: readonly ChatTurnMessage[]): CompactableHistory {
  const head: ChatTurnMessage = history[0] ?? { role: "system", content: "" };
  const entries: TranscriptEntry[] = [];
  let previousSummary: string | undefined;
  for (let index = 1; index < history.length; index += 1) {
    const message = history[index];
    if (!message) {
      continue;
    }
    if (message.role === "system" && message.content.startsWith(SUMMARY_ENTRY_PREFIX)) {
      const newline = message.content.indexOf("\n");
      previousSummary = newline === -1 ? "" : message.content.slice(newline + 1);
      continue;
    }
    entries.push({ id: `e${index}`, kind: message.role, content: message.content });
  }
  return { head, entries, previousSummary };
}

export function rebuildHistoryAfterCompaction(
  head: ChatTurnMessage,
  summaryEntry: TranscriptEntry,
  keptEntries: readonly TranscriptEntry[]
): ChatTurnMessage[] {
  const kept: ChatTurnMessage[] = [];
  for (const entry of keptEntries) {
    // guru's flat history only carries these roles; toolCall/toolResult kinds
    // belong to richer transcripts and cannot appear here by construction.
    if (entry.kind === "system" || entry.kind === "user" || entry.kind === "assistant") {
      kept.push({ role: entry.kind, content: entry.content });
    }
  }
  return [head, { role: "system", content: summaryEntry.content }, ...kept];
}

export function estimateChatHistoryTokens(history: readonly ChatTurnMessage[]): number {
  return estimateTranscriptTokens(
    history.map((message, index) => ({ id: `e${index}`, kind: message.role, content: message.content }))
  );
}

/**
 * What actually goes to the model: with compaction enabled the FULL (compacted)
 * history; disabled restores the legacy silent-drop window exactly.
 */
export function sendableHistory(history: readonly ChatTurnMessage[], compactionEnabled: boolean): ChatTurnMessage[] {
  return compactionEnabled ? [...history] : history.slice(-13);
}

/**
 * Reconcile keepRecentTokens with the trigger threshold (adversarial review
 * 2026-07-04): a keep budget ≥ contextWindow − reserveTokens could never bring the
 * estimate back under the trigger — every turn would re-compact (thrash). Clamp to
 * half the threshold so a compaction always lands well below it.
 */
export function effectiveKeepRecentTokens(config: CompactionConfig, contextWindowTokens: number): number {
  const threshold = contextWindowTokens - config.reserveTokens;
  if (threshold <= 0) {
    return config.keepRecentTokens;
  }
  return config.keepRecentTokens >= threshold ? Math.max(1_000, Math.floor(threshold / 2)) : config.keepRecentTokens;
}

/**
 * A lane can host the summary completion only when the turn itself runs direct
 * (baseUrl + chat-capable family + usable credential). Delegate/operator-auth
 * lanes keep the legacy window — their CLI turn can't serve a summary call.
 */
function routeDirectReady(route: ProviderRouteDescriptor | null): boolean {
  return (
    route !== null &&
    route.baseUrl !== undefined &&
    isChatCapableFamily(route.apiFamily) &&
    resolveRouteCredential(route).usable
  );
}

const SUMMARIZER_SYSTEM_PROMPT =
  "You summarize an agent-session transcript so the conversation can continue with less context. Produce a dense, factual summary: the operator's goals, decisions made, work completed (files, commands, outcomes), open threads, and any constraints stated. Never invent details. Never include credential values.";

/** session_before_compact / session_compact seams — callable now, extension-event
 * delivery lands in the extension wave (deferred; noted in the Done Packet). */
const beforeCompactHook: BeforeCompactHook = () => undefined;
const onCompactHook: CompactHook = () => undefined;

function buildRouteSummarizer(state: GuruState): (request: SummarizeRequest) => Promise<string> {
  return async (request) => {
    const route = state.connectedRoute;
    if (!route) {
      throw new Error("No connected model route for the compaction summary.");
    }
    const sections: string[] = [];
    if (request.previousSummary && request.previousSummary.trim().length > 0) {
      sections.push(`Previous summary (extend it — do not repeat verbatim):\n${request.previousSummary}`);
    }
    if (request.customInstructions && request.customInstructions.trim().length > 0) {
      sections.push(`Operator focus instructions: ${request.customInstructions}`);
    }
    sections.push(`Transcript region to fold (${request.label}):\n${request.transcriptBlock}`);
    sections.push("Reply with ONLY the summary text.");
    const result = await directAgentTurn(
      route,
      [
        { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
        { role: "user", content: sections.join("\n\n") }
      ],
      {
        // Plain completion: no tools are declared, so these callbacks can't fire.
        tools: [],
        executeTool: (toolId) =>
          Promise.resolve({
            toolId,
            status: "failed" as const,
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            durationMs: 0,
            error: "The compaction summarizer runs without tools."
          }),
        approveTool: () => false,
        maxTokens: request.maxTokens,
        retry: state.retryConfig,
        onRetry: printRetryIndicator,
        ...(state.modelIdOverride ? { modelIdOverride: state.modelIdOverride } : {})
      }
    );
    return result.text;
  };
}

/** Track read/write/edit paths at the executeTool seam (cumulative file tracking). */
export function trackCompactionFileOp(
  files: { readFiles: Set<string>; modifiedFiles: Set<string> },
  toolId: string,
  input: unknown
): void {
  if (typeof input !== "object" || input === null) {
    return;
  }
  const path = (input as { path?: unknown }).path;
  if (typeof path !== "string" || path.length === 0) {
    return;
  }
  if (toolId === "read") {
    files.readFiles.add(path);
  } else if (toolId === "write" || toolId === "edit") {
    files.modifiedFiles.add(path);
  }
}

async function runGuruCompaction(
  state: GuruState,
  reason: "manual" | "threshold",
  customInstructions?: string
): Promise<boolean> {
  if (state.compaction.running) {
    return false;
  }
  if (!state.connectedRoute) {
    print(colorize(theme, "yellow", "Compaction needs a connected model for the summary — /model to connect."));
    return false;
  }
  const { head, entries, previousSummary } = historyToCompactionEntries(state.history);
  if (entries.length < 2) {
    if (reason === "manual") {
      print(dim(theme, "Nothing to compact yet."));
    }
    return false;
  }
  state.compaction.running = true;
  const beforeTokens = estimateChatHistoryTokens(state.history);
  // Compaction indicator (checklist P0): visible while the summary lane runs.
  print(`  ${paint.fg("accent2", "⛁")} ${paint.fg("muted", `compacting context… ~${fmtTokens(beforeTokens)} tok${reason === "manual" ? " (manual)" : ""}`)}`);
  const contextWindowTokens = state.connectedRoute.context?.contextWindowTokens ?? FALLBACK_CONTEXT_WINDOW_TOKENS;
  try {
    const result = await runCompaction({
      entries,
      // keepRecentTokens reconciled with the trigger threshold (anti-thrash clamp).
      config: { ...state.compaction.config, keepRecentTokens: effectiveKeepRecentTokens(state.compaction.config, contextWindowTokens) },
      summarize: buildRouteSummarizer(state),
      now: () => new Date(),
      reason,
      ...(previousSummary !== undefined ? { previousSummary } : {}),
      ...(state.compaction.last ? { previousDetails: state.compaction.last.details, previousCount: state.compaction.last.count } : {}),
      ...(customInstructions !== undefined && customInstructions.trim().length > 0 ? { customInstructions } : {}),
      sessionFiles: {
        readFiles: [...state.compaction.files.readFiles].sort(),
        modifiedFiles: [...state.compaction.files.modifiedFiles].sort()
      },
      beforeCompact: beforeCompactHook,
      onCompact: onCompactHook
    });
    if (result === null) {
      if (reason === "manual") {
        print(dim(theme, "Transcript already fits the keep-recent budget — nothing folded."));
      } else {
        // A threshold trigger that folded nothing would fire again next turn with
        // the same answer — back off until the history actually grows, and send
        // the legacy window meanwhile so the turn stays under the lane's ceiling.
        state.compaction.noopEstimate = beforeTokens;
        state.compaction.sendLegacyWindowThisTurn = true;
      }
      return false;
    }
    if ("cancelled" in result) {
      print(dim(theme, "Compaction cancelled by hook."));
      return false;
    }
    state.history = rebuildHistoryAfterCompaction(head, result.summaryEntry, result.keptEntries);
    state.compaction.last = result.state;
    state.compaction.noopEstimate = null;
    // The status bar's ctx% reflects the new reality on the next real turn; keep
    // the stale pre-compaction number from re-triggering the threshold meanwhile.
    state.usage.lastInputTokens = Math.min(state.usage.lastInputTokens, estimateChatHistoryTokens(state.history));
    persistMeta(state);
    const afterTokens = estimateChatHistoryTokens(state.history);
    print(
      `  ${paint.fg("success", GLYPHS.ok)} ${paint.fg("fg", `compacted ~${fmtTokens(beforeTokens)} → ~${fmtTokens(afterTokens)} tok`)}${paint.fg("muted", ` · summary #${result.state.count} · ${result.plan.splitTurn ? "split-turn (dual summary)" : "clean cut"}`)}`
    );
    return true;
  } catch (error) {
    // ADR degrade path: the turn proceeds on the legacy slice window — context is
    // temporarily narrower, but the session NEVER dies on a failed summary.
    state.compaction.sendLegacyWindowThisTurn = true;
    print(
      colorize(
        theme,
        "yellow",
        `Compaction failed (${error instanceof Error ? error.message : String(error)}) — this turn uses the recent-window fallback.`
      )
    );
    return false;
  } finally {
    state.compaction.running = false;
  }
}

/**
 * Routes that declare no context window (ollama-local and other local lanes) still
 * receive the full history — bound them by a conservative model default so long sessions on
 * those lanes compact instead of overflowing (CodeRabbit 2026-07-04).
 */
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 128_000;

async function maybeAutoCompact(state: GuruState): Promise<void> {
  // The summary lane IS the connected route; a delegate/operator-auth lane can't
  // host it — those turns keep the legacy window (see the delegate call site).
  if (!routeDirectReady(state.connectedRoute)) {
    return;
  }
  const estimatedTokens = estimateChatHistoryTokens(state.history);
  // Anti-thrash backoff: a prior threshold attempt folded nothing at this size —
  // don't burn a summary call again until the history has actually grown.
  if (state.compaction.noopEstimate !== null) {
    if (estimatedTokens <= state.compaction.noopEstimate) {
      state.compaction.sendLegacyWindowThisTurn = true;
      return;
    }
    state.compaction.noopEstimate = null;
  }
  const trigger = shouldCompact({
    config: state.compaction.config,
    contextWindowTokens: state.connectedRoute?.context?.contextWindowTokens ?? FALLBACK_CONTEXT_WINDOW_TOKENS,
    lastInputTokens: state.usage.lastInputTokens,
    estimatedTokens
  });
  if (trigger) {
    await runGuruCompaction(state, "threshold");
  }
}

/**
 * Durable persistence is now the append-only session log (ADR
 * 2026-07-05-session-tree). Messages append at the point they are created (the
 * stream is lossless — a compaction is a marker, never a rewrite); meta appends
 * only when title/route/model change; a compaction entry appends when a fold
 * advances the count.
 */
function currentMode(state: GuruState): "normal" | "yolo" {
  return state.yolo ? "yolo" : "normal";
}

function logMessage(state: GuruState, role: "system" | "user" | "assistant", content: string): void {
  try {
    state.store.appendMessage(state.conversationId, { role, content, mode: currentMode(state) });
  } catch (error) {
    print(dim(theme, `  (could not persist message: ${error instanceof Error ? error.message : String(error)})`));
  }
}

function metaSignature(state: GuruState): string {
  return `${deriveConversationTitle(state.history)}|${state.connectedRoute?.routeId ?? ""}|${state.modelIdOverride ?? ""}`;
}

/** Append meta (if changed) + a compaction marker (if a fold advanced) — cheap, idempotent. */
function persistMeta(state: GuruState): void {
  try {
    const sig = metaSignature(state);
    if (sig !== state.lastMetaSig) {
      state.store.appendMeta(state.conversationId, {
        title: deriveConversationTitle(state.history),
        routeId: state.connectedRoute?.routeId ?? null,
        modelIdOverride: state.modelIdOverride,
        createdAt: state.createdAt,
        ...(state.lineage ? { lineage: state.lineage } : {})
      });
      state.lastMetaSig = sig;
    }
    if (state.compaction.last && state.compaction.last.count !== state.lastCompactionCount) {
      state.store.appendCompaction(state.conversationId, state.compaction.last);
      state.lastCompactionCount = state.compaction.last.count;
    }
  } catch (error) {
    print(dim(theme, `  (could not persist session: ${error instanceof Error ? error.message : String(error)})`));
  }
}

/** Seed a fresh (or legacy-migrated) session's log: meta + every current message. */
function seedLog(state: GuruState): void {
  state.lastMetaSig = "";
  state.lastCompactionCount = 0;
  persistMeta(state);
  for (const message of state.history) {
    logMessage(state, message.role, message.content);
  }
}

/** Child branch summaries injected into the parent history on return (in-memory only). */
function injectBranchMemory(state: GuruState): void {
  let branches: ReturnType<SessionLogStore["children"]>;
  try {
    branches = state.store.children(state.conversationId);
  } catch {
    return;
  }
  const withSummary = branches.filter((branch) => branch.branchSummary && branch.branchSummary.trim().length > 0);
  for (const branch of withSummary) {
    state.history.push({ role: "system", content: `[branch memory: ${branch.title}] ${branch.branchSummary}` });
  }
  if (withSummary.length > 0) {
    print(dim(theme, `  ↳ injected ${withSummary.length} branch ${withSummary.length === 1 ? "summary" : "summaries"} on return`));
  }
}

/** Point live state at a replayed session (resume / fork / clone) and inject branch memory. */
function switchToSession(state: GuruState, session: ReconstructedSession, lineage: SessionLineage | null): void {
  state.conversationId = session.id;
  state.createdAt = session.createdAt;
  state.history = session.messages.map((message) => ({ role: message.role, content: message.content }));
  state.usage = {
    inputTokens: 0,
    outputTokens: 0,
    turns: session.messages.filter((message) => message.role === "assistant").length,
    lastInputTokens: 0
  };
  state.compaction.last = session.compaction ?? null;
  state.compaction.files = {
    readFiles: new Set(session.compaction?.details.readFiles ?? []),
    modifiedFiles: new Set(session.compaction?.details.modifiedFiles ?? [])
  };
  state.compaction.sendLegacyWindowThisTurn = false;
  state.compaction.noopEstimate = null;
  state.lineage = lineage;
  state.turnsThisBranch = 0;
  if (session.legacy) {
    // Migrate the flat record into the append-only log on first resume so new
    // turns chain onto the FULL history (load() prefers the jsonl once it exists).
    seedLog(state);
  } else {
    state.lastMetaSig = metaSignature(state);
    state.lastCompactionCount = state.compaction.last?.count ?? 0;
  }
  injectBranchMemory(state);
}

/** Leaving a branch with new turns: fold it to a branch summary via the compaction summarizer. */
async function maybeSummarizeBranch(state: GuruState): Promise<void> {
  if (!state.lineage || state.turnsThisBranch === 0 || !routeDirectReady(state.connectedRoute)) {
    return;
  }
  try {
    const recent = state.history
      .filter((message) => message.role !== "system")
      .slice(-12)
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n\n");
    if (recent.trim().length === 0) {
      return;
    }
    const summary = await buildRouteSummarizer(state)({
      label: "history",
      transcriptBlock: recent,
      maxTokens: state.compaction.config.summaryMaxTokens
    });
    if (summary.trim().length > 0) {
      state.store.appendMeta(state.conversationId, {
        title: deriveConversationTitle(state.history),
        routeId: state.connectedRoute?.routeId ?? null,
        modelIdOverride: state.modelIdOverride,
        createdAt: state.createdAt,
        lineage: state.lineage,
        branchSummary: summary
      });
      print(dim(theme, `  ⛁ branch summary saved (${state.conversationId.slice(0, 8)})`));
    }
  } catch {
    // Best-effort: leaving a branch must never fail on a summary.
  }
}

function cmdSessions(state: GuruState): void {
  const sessions = state.store.list();
  if (sessions.length === 0) {
    print(dim(theme, `No saved conversations yet (store: ${state.store.directory}).`));
    return;
  }
  print(paint.bold(paint.fg("fgBright", "Saved conversations")) + paint.fg("muted", "  (/resume <id|#>)"));
  const rows = sessions.map((item, index) => [
    item.id === state.conversationId ? paint.fg("success", GLYPHS.ok) : " ",
    paint.fg("fg", String(index + 1)),
    item.title.length > 44 ? `${item.title.slice(0, 43)}…` : item.title,
    paint.fg("muted", item.routeId ?? "no route"),
    paint.fg("fg", `${item.turnCount}`),
    paint.fg("fgFaint", item.updatedAt.slice(0, 16).replace("T", " "))
  ]);
  for (const line of renderTable(paint, [{ header: " " }, { header: "#" }, { header: "title" }, { header: "route" }, { header: "turns" }, { header: "updated" }], rows)) {
    print(`  ${line}`);
  }
}

async function cmdResume(state: GuruState, selector: string): Promise<void> {
  const sessions = state.store.list();
  const index = Number.parseInt(selector, 10);
  const summary =
    sessions.find((item) => item.id === selector) ??
    (Number.isInteger(index) && index >= 1 && index <= sessions.length ? sessions[index - 1] : undefined);
  if (!summary) {
    print(colorize(theme, "red", `No saved conversation matches '${selector}'. Try /sessions.`));
    return;
  }
  const record = state.store.load(summary.id);
  if (!record) {
    print(colorize(theme, "red", `Could not load conversation ${summary.id}.`));
    return;
  }
  // Fold the branch we're leaving before we switch away (branch memory).
  await maybeSummarizeBranch(state);

  // Reconnect the route FIRST so a legacy migration / the meta signature captures it.
  let routeNote = record.routeId ? "; /model to reconnect" : "; /model to connect";
  if (record.routeId) {
    const route = state.routes.find((candidate) => candidate.routeId === record.routeId);
    if (route) {
      state.connectedRoute = route;
      state.modelIdOverride = record.modelIdOverride;
      routeNote = `, route ${record.routeId}`;
    }
  }
  switchToSession(state, record, record.lineage ?? null);
  print(colorize(theme, "green", `Resumed: ${record.title}`) + dim(theme, ` (${record.messages.length} message(s)${routeNote})`));
}

async function cmdNew(state: GuruState): Promise<void> {
  await maybeSummarizeBranch(state);
  state.conversationId = randomUUID();
  state.createdAt = new Date().toISOString();
  state.history = [{ role: "system", content: systemPrompt() }];
  state.usage = { inputTokens: 0, outputTokens: 0, turns: 0, lastInputTokens: 0 };
  state.compaction.last = null;
  state.compaction.files = { readFiles: new Set(), modifiedFiles: new Set() };
  state.compaction.sendLegacyWindowThisTurn = false;
  state.compaction.noopEstimate = null;
  state.lineage = null;
  state.turnsThisBranch = 0;
  seedLog(state);
  print(colorize(theme, "green", "Started a fresh conversation.") + dim(theme, ` (${state.conversationId.slice(0, 8)})`));
}

function cmdTree(state: GuruState, args: readonly string[]): void {
  const filterArg = (args[0] ?? "").toLowerCase();
  const filter: TreeFilter = filterArg === "user" ? "user" : filterArg === "all" ? "all" : "conversation";
  const session = state.store.load(state.conversationId);
  if (!session || session.messages.length === 0) {
    print(dim(theme, "No conversation yet — nothing to branch."));
    return;
  }
  const model = buildSessionTree(session, state.store.children(state.conversationId), { filter });
  print(paint.bold(paint.fg("fgBright", "Session tree")) + paint.fg("muted", `  ${model.title}`));
  for (const row of model.rows) {
    const indent = "  ".repeat(row.depth + 1);
    if (row.kind === "branch") {
      print(`${indent}${paint.fg("accent2", "└─")} ${paint.fg("muted", row.text)}`);
      continue;
    }
    const marker = row.forkNumber !== undefined ? paint.fg("accent", `[${row.forkNumber}]`) : "   ";
    const who = row.role === "user" ? paint.fg("fgBright", "you") : row.role === "assistant" ? paint.fg("accent2", "guru") : paint.fg("muted", row.role ?? "");
    print(`${indent}${marker} ${who}${paint.fg("muted", ":")} ${paint.fg("fg", row.text)}`);
  }
  print(dim(theme, `  /fork <#> from a user turn · /clone this branch${filter === "conversation" ? " · /tree user|all to filter" : ""}`));
}

async function cmdFork(state: GuruState, args: readonly string[]): Promise<void> {
  const session = state.store.load(state.conversationId);
  if (!session || session.messages.length === 0) {
    print(dim(theme, "Nothing to fork yet."));
    return;
  }
  const model = buildSessionTree(session, state.store.children(state.conversationId), {});
  const requested = Number.parseInt(args[0] ?? "", 10);
  const target = Number.isInteger(requested) ? model.forkTargets.get(requested) : undefined;
  if (!target) {
    print(colorize(theme, "yellow", `Usage: /fork <#> — pick a user turn number (1..${model.forkTargets.size}).`));
    cmdTree(state, []);
    return;
  }
  await maybeSummarizeBranch(state);
  const forked = state.store.fork(state.conversationId, target);
  if (!forked) {
    print(colorize(theme, "red", "Fork failed — could not resolve the selected turn."));
    return;
  }
  switchToSession(state, forked.session, forked.session.lineage ?? null);
  print(
    colorize(theme, "green", `Forked from turn ${requested} → branch ${forked.newId.slice(0, 8)}`) +
      dim(theme, ` (${forked.session.messages.length} message(s) carried over; original untouched)`)
  );
}

async function cmdClone(state: GuruState): Promise<void> {
  const cloned = state.store.clone(state.conversationId);
  if (!cloned) {
    print(dim(theme, "Nothing to clone yet."));
    return;
  }
  switchToSession(state, cloned.session, cloned.session.lineage ?? null);
  print(
    colorize(theme, "green", `Cloned the active branch → ${cloned.newId.slice(0, 8)}`) +
      dim(theme, " (experiment freely; the original branch is intact)")
  );
}

function cmdSkills(state: GuruState, args: readonly string[] = []): void {
  const catalog = state.session?.skills.catalog;
  if ((args[0] ?? "").toLowerCase() === "promote") {
    cmdSkillPromote(state, args[1] ?? "");
    return;
  }
  if (!catalog || catalog.skills.length === 0) {
    print(dim(theme, "No skills discovered."));
    return;
  }
  for (const skill of catalog.skills) {
    // Bridge loading (§14/§16): a bridge skill is an ATTACH — flagged, tracked.
    const badge = skill.kind === "bridge" ? colorize(theme, "yellow", bridgeBadge(skill).trim()) : "";
    print(`  ${bold(theme, skill.id)}${badge ? ` ${badge}` : ""} ${dim(theme, skill.description ?? "")}`);
  }
  const bridges = bridgeManifests(catalog);
  if (bridges.length > 0) {
    print(dim(theme, `  ${bridges.length} bridge skill(s) tracked as ATTACH parity gaps — /skills promote <id> graduates one to native.`));
  }
}

/** Graduate a bridge skill to native: rewrite its frontmatter + close its parity gap. */
function cmdSkillPromote(state: GuruState, skillId: string): void {
  const catalog = state.session?.skills.catalog;
  const skill = catalog?.skills.find((candidate) => candidate.id === skillId.trim());
  if (!skillId.trim() || !skill) {
    print(dim(theme, "Usage: /skills promote <id> — the id of a [bridge] skill (see /skills)."));
    return;
  }
  if (skill.kind !== "bridge") {
    print(dim(theme, `${skill.id} is already native — nothing to promote.`));
    return;
  }
  const result = promoteBridgeSkillFile(skill.skillFile);
  if (!result.ok) {
    print(colorize(theme, "yellow", `Could not promote ${skill.id}: ${result.reason}`));
    return;
  }
  // Close the tracked parity gap (an ATTACH satisfied by graduation to native).
  const gapId = bridgeGapId(skill);
  const remaining = loadGapRecords(guruMemoryStore).filter((record) => record.id !== gapId);
  saveGapRecords(guruMemoryStore, remaining);
  print(colorize(theme, "green", `Promoted ${skill.id} to native — bridge dropped, parity gap closed.`) + dim(theme, " (reloads on next boot / /new)"));
}

function cmdRemember(state: GuruState, args: readonly string[]): void {
  // An optional leading scope keyword targets a namespace (§7); default global.
  let scope: MemoryScope = "global";
  let words = [...args];
  const firstWord = (words[0] ?? "").toLowerCase();
  if ((MEMORY_SCOPES as readonly string[]).includes(firstWord)) {
    scope = firstWord as MemoryScope;
    words = words.slice(1);
  }
  const textInput = words.join(" ").trim();
  if (textInput.length === 0) {
    print(dim(theme, "Usage: /remember [global|space|role] <fact to persist>"));
    return;
  }
  let store = scopedMemory.storeFor(scope);
  if (!store) {
    print(dim(theme, `  no ${scope} scope active (${scope === "space" ? "no repo bound" : "no suit worn"}) — saving to global`));
    scope = "global";
    store = guruMemoryStore;
  }
  const firstSentence = textInput.split(/(?<=[.!?])\s+/u)[0] ?? textInput;
  const title = (firstSentence.length > 80 ? `${firstSentence.slice(0, 77)}...` : firstSentence).trim();
  const description = (textInput.length > 200 ? `${textInput.slice(0, 197)}...` : textInput).replace(/\s+/gu, " ").trim();
  const result = store.remember({ title, description, body: textInput, type: "project", edit: "replace", confidence: 1 });
  if (result.status === "blocked") {
    print(colorize(theme, "yellow", result.summary));
    for (const blocker of result.blockers) {
      print(dim(theme, `  ${blocker}`));
    }
    return;
  }
  refreshBootMemoryBlock();
  if (state.history[0]?.role === "system") {
    state.history[0] = { role: "system", content: systemPrompt() };
  }
  const scopeNote = scope === "global" ? "" : ` (${scope} scope)`;
  print(colorize(theme, "green", `${result.summary}${scopeNote} It will be in every future boot briefing.`));
}

function cmdMemory(args: readonly string[]): void {
  const sub = (args[0] ?? "status").toLowerCase();
  if (sub === "doctor") {
    const report = guruMemoryStore.doctor();
    print(colorize(theme, "green", report.summary));
    for (const corrupt of report.corruptSkipped) {
      print(dim(theme, `  corrupt (skipped): ${corrupt}`));
    }
    for (const link of report.danglingLinks) {
      print(dim(theme, `  dangling link: ${link}`));
    }
    refreshBootMemoryBlock();
    return;
  }
  const facts = guruMemoryStore.list();
  print(bold(theme, `memory — ${facts.length} fact(s)`) + dim(theme, `  (${guruMemoryStore.directory})`));
  // Per-scope breakdown (§7): global is always shown; space/role when bound.
  for (const { scope, store } of scopedMemory.activeStores()) {
    if (scope === "global") {
      continue;
    }
    print(dim(theme, `  ${scope.padEnd(6)} ${store.list().length} fact(s)  (${store.directory})`));
  }
  for (const { fact } of facts.slice(0, 15)) {
    print(`  ${colorize(theme, "cyan", fact.name.padEnd(34))} ${dim(theme, `${fact.type} · updated ${fact.updatedAt.slice(0, 10)}`)}`);
  }
  if (facts.length > 15) {
    print(dim(theme, `  ...and ${facts.length - 15} more (memory_search)`));
  }
  if (facts.length === 0) {
    print(dim(theme, "  Nothing remembered yet — /remember [global|space|role] <fact> or the memory_remember tool."));
  }
  print(dim(theme, "  Obsidian-compatible vault: open the directory above as a vault to browse/graph it."));
}

/**
 * Smart Connections (§7, v0.25): surface memory — facts + learnings, across every
 * active scope — semantically related to a query, ranked by BM25. The same relevance
 * signal that re-ranks the injected memory each turn, exposed as an explicit lookup.
 */
function cmdRecall(args: readonly string[]): void {
  const query = args.join(" ").trim();
  if (query.length === 0) {
    print(dim(theme, "Usage: /recall <what you're looking for>"));
    return;
  }
  const docs: { id: string; text: string }[] = [];
  const meta = new Map<string, { label: string; kind: string; scope: MemoryScope }>();
  for (const { scope, store } of scopedMemory.activeStores()) {
    for (const { fact } of store.list()) {
      if (fact.type === "learning") {
        continue;
      }
      const id = `${scope}:${fact.name}`;
      if (meta.has(id)) {
        continue;
      }
      docs.push({ id, text: `${fact.title} ${fact.description}` });
      meta.set(id, { label: `${fact.title} — ${fact.description}`, kind: "fact", scope });
    }
    for (const learning of loadLearnings(store)) {
      const id = `${scope}:learning:${learning.id}`;
      if (meta.has(id)) {
        continue;
      }
      docs.push({ id, text: `${learning.statement} ${learning.subject} ${learning.tools.join(" ")}` });
      meta.set(id, { label: `(${learning.level}) ${learning.statement}`, kind: "learning", scope });
    }
  }
  const hits = queryRecall(buildRecallIndex(docs), query, 10);
  if (hits.length === 0) {
    print(dim(theme, `No memory related to "${query}" (searched ${docs.length} item(s)).`));
    return;
  }
  print(bold(theme, `recall — ${hits.length} related to "${query}"`) + dim(theme, `  (BM25 over ${docs.length} item(s))`));
  for (const hit of hits) {
    const entry = meta.get(hit.id);
    if (!entry) {
      continue;
    }
    const tag = entry.scope === "global" ? "" : ` ·${entry.scope}`;
    print(`  ${colorize(theme, "cyan", hit.score.toFixed(2).padStart(5))} ${dim(theme, `${entry.kind}${tag}`)}  ${entry.label}`);
  }
}

/**
 * The model-facing tool surface for this session: the active suit's assembled
 * loadout when suited, else the default curated set. Selection only — gates
 * (mandate/approval) survive every loadout.
 */
function activeChatToolIds(state: GuruState): ReadonlySet<string> {
  if (!state.activeRole) {
    return GURU_CHAT_TOOL_IDS;
  }
  const registered = new Set(state.sessionTools.map((tool) => tool.id));
  return assembleSuit(state.activeRole, registered, READ_ONLY_TOOL_IDS).chatToolIds;
}

function suitUpSummary(state: GuruState, fromGarage: boolean): void {
  const role = state.activeRole;
  if (!role) {
    return;
  }
  const registered = new Set(state.sessionTools.map((tool) => tool.id));
  const suit = assembleSuit(role, registered, READ_ONLY_TOOL_IDS);
  const check = verifyModelForRole(role, state.connectedRoute);
  print(bold(theme, `suited up: ${role.label}`) + dim(theme, `  (${role.capabilityMode} · ${fromGarage ? `from the garage, worn ${role.wornCount}x` : "new suit — naked base, it grows as you work"})`));
  print(dim(theme, `  tools offered: ${suit.chatToolIds.size}${suit.missingTools.length > 0 ? ` · not registered yet: ${suit.missingTools.join(", ")}` : ""}`));
  if (role.skills.length > 0) {
    print(dim(theme, `  skills: ${role.skills.join(", ")}`));
  }
  if (!check.ok) {
    print(colorize(theme, "yellow", `  model check: ${state.connectedRoute?.routeId ?? "no model"} lacks ${check.unmet.join("+")} — /model to pick one that has them`));
  } else if (state.connectedRoute) {
    print(dim(theme, `  model check: ${state.connectedRoute.routeId} satisfies ${role.modelPreference.requires.join("+")}`));
  }
}

function cmdRoleSuit(state: GuruState, description: string): void {
  if (description.trim().length === 0) {
    print(dim(theme, "Usage: /role suit <what we're doing today>"));
    return;
  }
  let slug: string;
  try {
    slug = slugifyRole(description);
  } catch {
    print(colorize(theme, "yellow", "Couldn't derive a suit name from that — try a couple of words."));
    return;
  }
  const existing = loadManifest(guruMemoryStore, slug);
  if (existing) {
    // Re-verify-before-load (§8): a clean suit loads on the ungated fast path; a
    // stale / hash-mismatched / unverified layer re-verifies first; a layer that
    // fails is marked RED and skipped — never loaded.
    const registered = new Set(state.sessionTools.map((tool) => tool.id));
    const catalogSkills = new Set((state.session?.skills.catalog.skills ?? []).map((skill) => skill.id));
    const result = reverifyForLoad(existing, {
      now: () => new Date(),
      staleAfterDays: ROLE_STALE_AFTER_DAYS,
      verifyLayer: (layer: GarageLayer) => {
        if (layer.kind === "tool") return registered.has(layer.id);
        // Presence-known layers red on definite absence; unknown → keep (no false red).
        if (layer.kind === "skill") return catalogSkills.size === 0 ? true : catalogSkills.has(layer.id);
        return true;
      }
    });
    // Persist the re-verified manifest only when re-verification actually changed
    // something (the fast path writes nothing).
    if (!result.fastPath) {
      parkManifest(guruMemoryStore, result.manifest);
    }
    state.activeRole = { ...manifestToRoleProfile(result.manifest), wornCount: existing.wornCount + 1 };
    suitUpSummary(state, true);
    if (result.skippedRed.length > 0) {
      print(colorize(theme, "yellow", `  ⚠ ${result.skippedRed.length} layer(s) failed re-verify and were skipped (red): ${result.skippedRed.map((layer) => `${layer.kind}:${layer.id}`).join(", ")}`));
    } else if (result.fastPath) {
      print(dim(theme, `  garage fast path — all ${result.loaded} verified layer(s) loaded, no re-verify needed`));
    } else {
      print(dim(theme, `  re-verified ${result.reverified} layer(s) before load`));
    }
    const age = roleAgeDays(guruMemoryStore, slug);
    if (age !== undefined && age > ROLE_STALE_AFTER_DAYS) {
      // Never silently trusted, never silently deleted (garage hygiene law).
      print(colorize(theme, "yellow", `  ⚠ suit parked ${age} days ago — layers were re-verified above`));
    }
  } else {
    state.activeRole = {
      slug,
      label: description.trim(),
      capabilityMode: "all",
      tools: [],
      skills: [],
      extensions: [],
      mcpServers: [],
      modelPreference: { requires: ["chat", "tools"] },
      verifiedTools: [],
      wornCount: 1,
      notes: ""
    };
    suitUpSummary(state, false);
  }
  // Bind the role scope (§7): this suit's learnings now compound in its own
  // namespace. Self-heal legacy flat-store learnings into it on first wear.
  scopedMemory.setRole(slug);
  const roleStore = scopedMemory.role();
  if (roleStore) {
    const moved = migrateRoleLearnings(guruMemoryStore, roleStore, slug);
    if (moved > 0) {
      print(dim(theme, `  ${moved} legacy learning(s) folded into the ${slug} role scope`));
    }
  }
  refreshBootMemoryBlock();
  state.toolsUsed = new Set<string>();
}

function cmdRolePark(state: GuruState): void {
  const role = state.activeRole;
  if (!role) {
    print(dim(theme, "Not suited — /role suit <thing> first."));
    return;
  }
  const floor = new Set(["read", "bash", "edit", "write"]);
  const earned = [...state.toolsUsed].filter((toolId) => !floor.has(toolId));
  // Start from the STORED manifest (preserves per-layer verification history +
  // gap records across parks); fall back to migrating the active RoleProfile.
  const base = loadManifest(guruMemoryStore, role.slug) ?? roleProfileToManifest(role);
  const stamp = new Date().toISOString();
  const layers: GarageLayer[] = base.layers.map((layer) => ({ ...layer }));
  for (const id of earned) {
    const index = layers.findIndex((layer) => layer.kind === "tool" && layer.id === id);
    // A tool observed used-and-succeeded this session is verified-by-use.
    const verified: GarageLayer = {
      kind: "tool",
      id,
      coveringTestsRef: "presence",
      verificationHash: computeLayerHash({ kind: "tool", id, coveringTestsRef: "presence" }),
      status: "verified",
      provenance: "observed",
      staleFlag: false,
      lastVerifiedAt: stamp,
      donePacketRef: ""
    };
    if (index >= 0) {
      layers[index] = verified;
    } else {
      layers.push(verified);
    }
  }
  const receipt = parkManifest(guruMemoryStore, { ...base, layers, wornCount: role.wornCount, lastWornAt: stamp, lastWornSession: state.sessionNumber });
  if (state.usage.turns > 0 && state.connectedRoute) {
    recordPathOutcome(guruMemoryStore, role.slug, {
      routeId: state.connectedRoute.routeId,
      turns: state.usage.turns,
      toolsUsed: earned
    });
  }
  // The knowledge flywheel (§8): extract/gate/store/cite/decay BEFORE the boot
  // block refreshes so newly-learned facts are injectable next session.
  const flywheelTail = runFlywheelAtPark(
    role.slug,
    earned,
    state.toolsUsed,
    state.connectedRoute?.routeId ?? "none",
    state.usage.turns,
    state.sessionNumber
  );
  refreshBootMemoryBlock();
  print(
    colorize(theme, "green", `Parked ${role.label} in the garage.`) +
      dim(theme, `  receipt: ${receipt.stored} stored · ${receipt.rejected} rejected · ${receipt.gaps} gap(s) · ${receipt.verificationStatus}`)
  );
  print(dim(theme, `  flywheel: ${flywheelTail}`));
  if (receipt.rejected > 0) {
    print(colorize(theme, "yellow", `  ⚠ refused (verified-only): ${receipt.rejectedLayers.map((layer) => `${layer.kind}:${layer.id}`).join(", ")} — a BUILT layer must carry its done packet`));
  }
  if (earned.length > 0) {
    print(dim(theme, `  +${earned.length} tool(s) verified-by-use this session`));
  }
  state.activeRole = null;
  scopedMemory.setRole(null); // role scope closes with the suit
  refreshBootMemoryBlock();
}

function cmdRole(state: GuruState, args: readonly string[]): void {
  const sub = (args[0] ?? "list").toLowerCase();
  if (sub === "list") {
    const roles = listRoles(guruMemoryStore);
    print(bold(theme, `garage — ${roles.length} suit(s)`) + dim(theme, `  active: ${state.activeRole?.label ?? "naked"}`));
    for (const role of roles) {
      const age = roleAgeDays(guruMemoryStore, role.slug);
      const staleness = age === undefined ? "" : age > ROLE_STALE_AFTER_DAYS ? ` · ${colorize(theme, "yellow", `stale (${age}d) — re-verify`)}` : ` · parked ${age}d ago`;
      print(`  ${colorize(theme, "cyan", role.slug.padEnd(30))} ${dim(theme, `${role.label} · worn ${role.wornCount}x · ${role.verifiedTools.length} verified tool(s)`)}${staleness}`);
    }
    if (roles.length === 0) {
      print(dim(theme, "  Garage is empty — suits emerge from work. /role suit <what we're doing today>"));
    }
    return;
  }
  if (sub === "suit") {
    cmdRoleSuit(state, args.slice(1).join(" "));
    return;
  }
  if (sub === "park") {
    cmdRolePark(state);
    return;
  }
  if (sub === "off") {
    state.activeRole = null;
    scopedMemory.setRole(null); // role scope closes with the suit
    refreshBootMemoryBlock();
    print(colorize(theme, "green", "Suit off — back to the naked default surface (unparked changes discarded)."));
    return;
  }
  print(dim(theme, "Usage: /role [list | suit <thing> | park | off]"));
}

const MANDATE_VERB_PRESETS: Readonly<Record<string, readonly MandateVerb[]>> = {
  read: ["read"],
  write: ["read", "write"],
  work: ["read", "write", "exec"],
  all: ["read", "write", "exec", "net"]
};

function cmdMandate(state: GuruState, args: readonly string[]): void {
  const sub = (args[0] ?? "list").toLowerCase();

  if (sub === "list") {
    const grants = state.mandate.grants;
    print(bold(theme, `mandates — ${grants.length} grant(s)`) + dim(theme, `  (${state.mandateStore.filePath})`));
    for (const grant of grants) {
      const where = grant.scope === "space" ? `space ${grant.path}` : "machine";
      print(`  ${colorize(theme, "cyan", where.padEnd(40))} ${dim(theme, grant.verbs.join("+"))}`);
    }
    if (grants.length === 0) {
      print(dim(theme, "  No standing grants. Each mutating tool call prompts per-call (y/N/always)."));
      print(dim(theme, "  /mandate grant machine work   -> 'this computer is yours' (read+write+exec)"));
    }
    print(dim(theme, `  YOLO: ${state.yolo ? colorize(theme, "yellow", "ON") : "off"} - hard edges (destructive/spend) always prompt below YOLO`));
    return;
  }

  if (sub === "revoke") {
    state.mandate = state.mandateStore.revokeAll();
    print(colorize(theme, "green", "All standing mandates revoked. Per-call approval is back in force."));
    return;
  }

  if (sub === "grant") {
    const scope = (args[1] ?? "").toLowerCase();
    const preset = (args[2] ?? "work").toLowerCase();
    const verbs = MANDATE_VERB_PRESETS[preset];
    if (scope !== "space" && scope !== "machine") {
      print(dim(theme, "Usage: /mandate grant <space|machine> [read|write|work|all]"));
      return;
    }
    if (!verbs) {
      print(dim(theme, `Unknown verb preset '${preset}'. One of: ${Object.keys(MANDATE_VERB_PRESETS).join(", ")}.`));
      return;
    }
    const cwd = state.session?.repo?.repoRoot ?? process.cwd();
    state.mandate = state.mandateStore.grant(scope === "space" ? { scope, path: cwd, verbs: [...verbs] } : { scope, verbs: [...verbs] });
    const where = scope === "space" ? `this repo (${cwd})` : "this computer";
    print(colorize(theme, "green", `Granted ${verbs.join("+")} for ${where}.`) + dim(theme, " Per-call prompts for these verbs now collapse into the grant."));
    print(dim(theme, "  Hard edges (rm -rf, force-push, spend) still prompt below YOLO."));
    return;
  }

  print(dim(theme, "Usage: /mandate [list | grant <space|machine> [read|write|work|all] | revoke]"));
}

function cmdYolo(state: GuruState, args: readonly string[]): void {
  const arg = (args[0] ?? "").toLowerCase();
  if (arg === "off") {
    state.yolo = false;
    print(colorize(theme, "green", "YOLO disabled. Standing mandates + hard-edge prompts back in force."));
    return;
  }
  if (arg !== "on") {
    print(dim(theme, "YOLO lifts EVERY permission gate: if it exists on this computer, the model may use it."));
    print(dim(theme, "The secret-value output law and the self-mutation gates (validation/CodeRabbit) still hold."));
    print(dim(theme, "To confirm, type exactly:  /yolo on"));
    return;
  }
  state.yolo = true;
  print(colorize(theme, "yellow", "⚠ YOLO MODE ON — ordinary permission gates lifted for this session."));
  print(dim(theme, "  Hard edges — destructive / spend / secrets-adjacent / ecosystem-auth — STILL prompt every time. /yolo off to restore."));
}

function cmdLookahead(state: GuruState, args: readonly string[]): void {
  const arg = (args[0] ?? "").toLowerCase();
  if (arg === "on" || arg === "off") {
    // Runtime toggle: rebuild the engine's enabled flag via a fresh instance is
    // heavy; instead the engine reads its own config, so we surface guidance.
    print(arg === "on"
      ? colorize(theme, "yellow", "Look-ahead is config-gated (lookahead.enabled). Set it in guruharness.config.json + relaunch to enable scouts.")
      : colorize(theme, "green", "Look-ahead scouts only run when lookahead.enabled is true in config."));
    print(dim(theme, `  current: ${state.lookahead.enabled ? "ENABLED — read-only scouts pre-explore forks in dead time" : "disabled — byte-identical to the plain loop"}`));
    return;
  }
  const cfg = state.lookahead.config;
  const stats = state.lookahead.stats();
  print(bold(theme, "look-ahead engine") + dim(theme, `  ${state.lookahead.enabled ? "ENABLED" : "disabled (default)"}`));
  print(dim(theme, "  Two-plane: the commit plane does the real work; read-only scouts pre-explore likely forks in its dead time."));
  print(dim(theme, `  forkWidth ${cfg.forkWidth} · leadDepth ${cfg.leadDepth} · scoutBudget ${Math.round(cfg.scoutBudgetFraction * 100)}%`));
  // Governor (§17 scenario 8): the three bounds that keep speculation honest.
  const allow = cfg.idempotentAllowlist;
  print(dim(theme, `  governor: allowlist ${allow.length === 0 ? "EMPTY (default nothing — no step is speculated)" : `[${allow.join(", ")}]`} · session budget ${stats.scoutsSpawned}/${cfg.maxScoutsPerSession} scouts · throttle >${Math.round(cfg.missRateThreshold * 100)}% miss`));
  if (stats.hits + stats.misses > 0 || stats.throttled) {
    print(dim(theme, `  this session: ${stats.hits} hit · ${stats.misses} miss (${Math.round(stats.missRate * 100)}%)${stats.throttled ? colorize(theme, "yellow", " · THROTTLED (miss rate too high)") : ""}`));
  }
  if (stats.lastSkip.length > 0) {
    print(dim(theme, `  last skip: ${stats.lastSkip}`));
  }
  print(dim(theme, "  When reality forks, a scout's pre-reasoned branch is promoted as a warm hint (never auto-executed). Enable via lookahead.enabled + populate lookahead.idempotentAllowlist in config."));
}

function cmdSettings(): void {
  const configResult = loadHarnessConfig({});
  print(bold(theme, "Settings (read-only; names only)"));
  print(`  config      ${configResult.path} (${configResult.status}, ${configResult.verdict})`);
  print(`  runtime     ${configResult.config.runtimeName} → reference: ${configResult.config.referenceRuntime}`);
  print(`  skills dirs ${configResult.config.skillDirectories.join(", ") || "(none)"}`);
  print(`  validation  ${configResult.config.validationCommands.map((command) => command.name).join(", ")}`);
  print(`  review gate ${configResult.config.reviewGate.provider} (required: ${configResult.config.reviewGate.required})`);
  print(`  approvals   autoCommitPushPr=${configResult.config.approvalPolicy.autoCommitPushPr} localMerge=${configResult.config.approvalPolicy.allowLocalMerge}`);
  print(
    `  compaction  enabled=${configResult.config.compaction.enabled} reserve=${configResult.config.compaction.reserveTokens} keepRecent=${configResult.config.compaction.keepRecentTokens}`
  );
  print(
    `  retry       enabled=${configResult.config.retry.enabled} max=${configResult.config.retry.maxRetries} base=${configResult.config.retry.baseDelayMs}ms delayCap=${configResult.config.retry.provider.maxRetryDelayMs}ms`
  );
  print(dim(theme, "  Edit guruharness.config.json to change settings."));
}

async function cmdLogin(state: GuruState, args: readonly string[] = []): Promise<void> {
  if (args.length > 0) {
    await cmdLoginProvider(state, args[0] ?? "", args[1]);
    return;
  }
  print(paint.bold(paint.fg("fgBright", "Credential status")) + paint.fg("muted", "  (env NAMES / file PRESENCE only — values never shown)"));
  const statusGlyph = (status: string): string =>
    status === "active" || status === "ready-unverified" || status === "delegated"
      ? paint.fg("success", GLYPHS.ok)
      : status === "needs-login" || status === "works-with-caveat"
        ? paint.fg("warning", GLYPHS.warn)
        : paint.fg("error", GLYPHS.pending);
  const loginRows: string[][] = [];
  const hints: string[] = [];
  for (const row of state.availability) {
    const route = state.routes.find((candidate) => candidate.routeId === row.routeId);

    if (route && isOperatorAuthRoute(route)) {
      // Unify the status column with the SAME resolver connect/turns use (Resolver A):
      // a route that connects direct is logged-in even when its presence-spec paths
      // differ from the catalog's credential file — otherwise the table contradicts
      // /login ("already connected") and the route that is actually chatting. Only the
      // pure delegate lane (no baseUrl, e.g. openai-codex) falls through to presence.
      const directReady = route.baseUrl !== undefined && isChatCapableFamily(route.apiFamily) && resolveRouteCredential(route).usable;
      if (directReady) {
        loginRows.push([statusGlyph("active"), row.routeId, paint.fg("success", "logged-in"), paint.fg("fgFaint", "operator auth (direct)")]);
        continue;
      }
      const presence = resolveOperatorAuthPresence(route);
      loginRows.push([
        statusGlyph(presence.present ? "active" : "needs-login"),
        row.routeId,
        presence.present ? paint.fg("success", "logged-in") : paint.fg("warning", "login-needed"),
        paint.fg("fgFaint", presence.present || !presence.loginCommand ? "operator auth" : `login: ${presence.loginCommand}`)
      ]);
      continue;
    }

    const envInfo =
      row.requiredEnvVarNames.length > 0
        ? `${row.presentEnvVarNames.length}/${row.requiredEnvVarNames.length} env (${row.requiredEnvVarNames.join(", ")})`
        : row.credentialSourceType;
    loginRows.push([statusGlyph(row.status), row.routeId, paint.fg("muted", row.status), paint.fg("fgFaint", envInfo)]);
    for (const hint of row.setupHints) {
      hints.push(hint);
    }
  }
  for (const line of renderTable(paint, [{ header: " " }, { header: "route" }, { header: "status" }, { header: "credential" }], loginRows)) {
    print(`  ${line}`);
  }
  if (hints.length > 0) {
    print(paint.fg("fgFaint", `  hints: ${[...new Set(hints)].slice(0, 4).join(" · ")}`));
  }
  print(dim(theme, "  /login <provider> for a specific login flow · /accounts for presence + expiry"));
}

/** Resolve the routes matching a provider id or route id selector. */
function routesForSelector(state: GuruState, selector: string): readonly ProviderRouteDescriptor[] {
  const exact = state.routes.filter((route) => route.providerId === selector || route.routeId === selector);
  if (exact.length > 0) {
    return exact;
  }
  return state.routes.filter((route) => route.providerId.startsWith(selector));
}

/**
 * guru-native OAuth sign-in (e.g. `/login codex`): open the operator's browser, run
 * the loopback PKCE flow, and store guru's OWN token in the encrypted vault. No Codex
 * CLI, no env var, no cache — passes the fresh-machine acceptance test.
 */
async function runNativeOAuthLogin(state: GuruState, route: ProviderRouteDescriptor): Promise<void> {
  const isGrok = route.providerId === "grok";
  print(bold(theme, `login: ${route.providerId}`) + dim(theme, "  (guru-native OAuth sign-in)"));
  try {
    const onUrl = (url: string): void => print(dim(theme, `  if the browser didn't open, paste this into it:\n    ${url}`));
    // Standalone rule: reuse the provider CLI's own sign-in if it happens to be present
    // (shortcut), else run guru's OWN native sign-in. guru never REQUIRES a CLI.
    let token = isGrok ? readGrokCacheToken() : readCodexCacheToken();
    if (token) {
      print(dim(theme, `  reusing an existing ${isGrok ? "xAI (~/.grok)" : "ChatGPT (~/.codex)"} sign-in — no browser needed.`));
    } else if (isGrok) {
      // xAI uses the RFC 8628 DEVICE-CODE flow (what the real Grok CLI does): no loopback
      // port (immune to Windows reserved ranges), works headless. Show the code, open the
      // browser, poll until approved.
      print("  Sign in to xAI (SuperGrok plan) — approve in your browser:");
      token = await loginViaXaiDeviceCode({
        onPrompt: (grant) => {
          print(`    ${bold(theme, `code: ${grant.userCode}`)}`);
          print(dim(theme, `    open: ${grant.verificationUriComplete ?? grant.verificationUri}`));
          print(dim(theme, "    (opening your browser — approve there, then return here…)"));
        }
      });
    } else {
      print("  Opening your browser to sign in to OpenAI (ChatGPT plan)…");
      token = await loginViaLoopback({ onUrl });
    }
    writeVaultOAuthToken(state.vault, route.providerId, token);
    registerSecretValue(token.accessToken);
    if (token.refreshToken) {
      registerSecretValue(token.refreshToken);
    }
    registerOAuthTokenAccessor((providerId) => {
      const stored = readVaultOAuthToken(state.vault, providerId);
      if (!stored?.accessToken) {
        return null;
      }
      registerSecretValue(stored.accessToken);
      if (stored.refreshToken) {
        registerSecretValue(stored.refreshToken);
      }
      return { accessToken: stored.accessToken, ...(stored.accountId ? { accountId: stored.accountId } : {}) };
    });
    refreshVaultAvailability(state);
    print(colorize(theme, "green", `  ✓ signed in to ${route.providerId}${token.planType ? ` (${token.planType} plan)` : ""} — token saved to the encrypted vault.`));
    print(dim(theme, `  reconnect with /model ${route.routeId}  ·  /logout ${route.providerId} to sign out`));
  } catch (error) {
    print(colorize(theme, "yellow", `  sign-in failed: ${error instanceof Error ? error.message : String(error)}`));
    print(dim(theme, "  (a device-code fallback for SSH/WSL sessions is planned.)"));
  }
}

async function cmdLoginProvider(state: GuruState, selector: string, inlineKey?: string): Promise<void> {
  const routes = routesForSelector(state, selector);
  if (routes.length === 0) {
    print(colorize(theme, "yellow", `No provider matches '${selector}'. /login for the full list.`));
    return;
  }

  const key = inlineKey?.trim();

  // Native OAuth sign-in (e.g. `/login codex`): guru's OWN browser login through its own
  // loopback callback — no ~/.codex cache, no Codex CLI, one sign-in, guru's own token.
  if (!key) {
    const oauthRoute = routes.find((candidate) => candidate.credentialSource.type === "guru-oauth");
    if (oauthRoute) {
      await runNativeOAuthLogin(state, oauthRoute);
      return;
    }
  }

  const route = routes[0];
  if (!route) {
    return;
  }

  // Inline key: `/login <provider> <key>` saves it to the ENCRYPTED vault under the
  // lane's primary env NAME, then lights up the provider. The value is never printed
  // or written to a plaintext guru file — and no external credential store is touched.
  if (key) {
    const name = route.credentialSource.envVarName ?? route.credentialSource.envVarNames[0];
    if (!name) {
      print(colorize(theme, "yellow", `${route.providerId} has no API-key env name to store a key under.`));
      return;
    }
    try {
      state.vault.set(name, key);
      state.vault.save();
      registerCredentialVault((lookup) => state.vault.get(lookup));
      registerSecretValue(key);
      refreshVaultAvailability(state);
      print(colorize(theme, "green", `saved ${name} to the encrypted vault — ${route.providerId} is ready.`));
      print(dim(theme, `  reconnect with /model ${route.routeId}  ·  /keys to view · /keys rm ${name} to remove`));
    } catch (error) {
      print(colorize(theme, "yellow", `could not save to the vault: ${error instanceof Error ? error.message : String(error)}`));
    }
    return;
  }

  const flow = describeLoginFlow(route);
  const badge = flow.present ? colorize(theme, "green", "connected") : colorize(theme, "yellow", flow.kind);
  print(bold(theme, `login: ${route.providerId}`) + `  ${badge}` + dim(theme, `  (${flow.kind})`));
  for (const step of flow.steps) {
    print(`  ${step}`);
  }
  if (flow.present && flow.expiresAt) {
    print(dim(theme, `  ${formatExpiry(flow.expiresAt, Date.now())}`));
  }
}

function cmdAccounts(state: GuruState): void {
  print(bold(theme, "accounts") + dim(theme, "  (presence + source layer + expiry — values never shown)"));
  const seen = new Set<string>();
  const rows: string[][] = [];
  for (const route of state.routes) {
    if (seen.has(route.providerId)) {
      continue;
    }
    seen.add(route.providerId);
    const flow = describeLoginFlow(route);
    if (flow.kind === "none-needed") {
      continue;
    }
    rows.push([
      flow.present ? paint.fg("success", GLYPHS.ok) : paint.fg("warning", GLYPHS.pending),
      route.providerId,
      flow.present ? paint.fg("success", "connected") : paint.fg("muted", "not connected"),
      paint.fg("fgFaint", flow.present ? `${flow.source ?? "resolved"} · ${formatExpiry(flow.expiresAt, Date.now())}` : flow.kind)
    ]);
  }
  for (const line of renderTable(paint, [{ header: " " }, { header: "provider" }, { header: "status" }, { header: "source · expiry" }], rows)) {
    print(`  ${line}`);
  }
  print(dim(theme, "  Keys resolve from env vars or the encrypted guru vault (/keys) — guru does not touch any external credential store."));
}

// ---------------------------------------------------------------------------
// Credential vault (§13; operator directive 2026-07-06): an encrypted env-var
// ALTERNATIVE. Add a key with `guru keys set <NAME>` (hidden prompt), and it lights
// up its provider on launch exactly like the env var of that name.
// ---------------------------------------------------------------------------

/** Open the vault, degrading to a locked empty view (never a crash, never an overwrite). */
function safeOpenVault(): Vault {
  try {
    return openVault();
  } catch (error) {
    print(colorize(theme, "yellow", `  credential vault present but could not be decrypted (${error instanceof Error ? error.message : "error"}) — check GURU_VAULT_PASSPHRASE. Vault-backed providers will show missing until it opens.`));
    return {
      filePath: "",
      kdf: "keyfile",
      size: 0,
      get: () => undefined,
      has: () => false,
      names: () => [],
      set: () => {
        throw new Error("vault is locked (decrypt failed)");
      },
      remove: () => false,
      save: () => {
        throw new Error("vault is locked (decrypt failed) — cannot save over it");
      }
    };
  }
}

/** Read one line WITHOUT echo (a secret value). TTY masks input; non-TTY reads a piped line. */
function readHiddenLine(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      const onData = (chunk: Buffer): void => {
        stdin.off("data", onData);
        resolve(chunk.toString("utf8").split(/\r?\n/u)[0] ?? "");
      };
      stdin.on("data", onData);
      stdin.resume();
      return;
    }
    process.stdout.write(promptText);
    const wasRaw = stdin.isRaw === true;
    stdin.setRawMode?.(true);
    stdin.resume();
    let buffer = "";
    const finish = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode?.(wasRaw);
      process.stdout.write("\n");
      resolve(buffer);
    };
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        const code = ch.codePointAt(0) ?? 0;
        if (code === 13 || code === 10) {
          finish();
          return;
        }
        if (code === 3) {
          buffer = ""; // ctrl-c cancels
          finish();
          return;
        }
        if (code === 127 || code === 8) {
          buffer = buffer.slice(0, -1); // backspace / delete
        } else if (code >= 32) {
          buffer += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

/** `guru keys set|list|rm` — the pre-session credential-vault CLI (secure value entry). */
async function runKeysCli(args: readonly string[]): Promise<void> {
  const sub = (args[0] ?? "list").toLowerCase();
  const vault = safeOpenVault();
  if (sub === "set" || sub === "add") {
    const name = (args[1] ?? "").trim();
    if (!name) {
      print(dim(theme, "Usage: guru keys set <ENV_VAR_NAME>   (e.g. guru keys set ANTHROPIC_API_KEY) — you'll be prompted for the value."));
      return;
    }
    print(dim(theme, `Saving ${name} to the encrypted guru vault (${vault.filePath}). The value is never echoed, logged, or committed.`));
    const value = (await readHiddenLine(`  value for ${name} (hidden): `)).trim();
    if (value.length === 0) {
      print(colorize(theme, "yellow", "  cancelled — no value entered."));
      return;
    }
    try {
      vault.set(name, value);
      vault.save();
    } catch (error) {
      print(colorize(theme, "yellow", `  could not save: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    print(colorize(theme, "green", `  ${name} saved to the vault. It will light up its provider on the next launch.`));
    return;
  }
  if (sub === "rm" || sub === "remove") {
    const name = (args[1] ?? "").trim();
    if (!name) {
      print(dim(theme, "Usage: guru keys rm <ENV_VAR_NAME>"));
      return;
    }
    try {
      const removed = vault.remove(name);
      if (removed) {
        vault.save();
      }
      print(removed ? colorize(theme, "green", `  removed ${name} from the vault.`) : dim(theme, `  ${name} was not in the vault.`));
    } catch (error) {
      print(colorize(theme, "yellow", `  could not save: ${error instanceof Error ? error.message : String(error)}`));
    }
    return;
  }
  // list (default) — NAMES only, never values.
  const names = vault.names();
  print(bold(theme, `guru vault — ${names.length} key(s)`) + dim(theme, `  (${vault.filePath}${vault.kdf === "scrypt" ? "; passphrase-encrypted" : "; machine-key-encrypted"})`));
  for (const name of names) {
    print(`  ${paint.fg("success", GLYPHS.ok)} ${name}`);
  }
  if (names.length === 0) {
    print(dim(theme, "  empty — add a key with: guru keys set <ENV_VAR_NAME>"));
  }
}

/** Re-scan readiness after the vault changed (a mutated vault lights up / dims providers live). */
/** A guru-oauth lane is "signed in" when a token sits in the vault OR the provider's CLI cache. */
function oauthProviderPresent(vault: GuruState["vault"], providerId: string): boolean {
  if (readVaultOAuthToken(vault, providerId)?.accessToken) {
    return true;
  }
  if (providerId === "grok") {
    return readGrokCacheToken() !== null;
  }
  if (providerId === "openai-codex") {
    return readCodexCacheToken() !== null;
  }
  return false;
}

function refreshVaultAvailability(state: GuruState): void {
  state.availability = scanProviderReadiness(state.routes, {
    vaultNames: new Set(state.vault.names()),
    oauthPresent: (providerId) => oauthProviderPresent(state.vault, providerId)
  });
}

/** `/keys` — the in-session vault view + the env-vs-vault guidance + a live reload. */
function cmdKeys(state: GuruState, args: readonly string[]): void {
  const sub = (args[0] ?? "status").toLowerCase();
  if (sub === "rm" || sub === "remove") {
    const name = (args[1] ?? "").trim();
    if (!name) {
      print(dim(theme, "Usage: /keys rm <ENV_VAR_NAME>"));
      return;
    }
    try {
      if (state.vault.remove(name)) {
        state.vault.save();
        refreshVaultAvailability(state);
        print(colorize(theme, "green", `removed ${name} from the vault.`));
      } else {
        print(dim(theme, `${name} was not in the vault.`));
      }
    } catch (error) {
      print(colorize(theme, "yellow", `could not save: ${error instanceof Error ? error.message : String(error)}`));
    }
    return;
  }
  if (sub === "reload") {
    state.vault = safeOpenVault();
    registerCredentialVault((name) => state.vault.get(name));
    for (const name of state.vault.names()) {
      const value = state.vault.get(name);
      if (value) {
        registerSecretValue(value);
      }
    }
    refreshVaultAvailability(state);
    print(colorize(theme, "green", `vault reloaded — ${state.vault.size} key(s); readiness refreshed.`));
    return;
  }
  // status / list.
  const names = state.vault.names();
  print(bold(theme, `keys — vault holds ${names.length} key(s)`) + dim(theme, `  (${state.vault.filePath || "locked"})`));
  for (const name of names) {
    print(`  ${paint.fg("success", GLYPHS.ok)} ${name} ${dim(theme, "· vault")}`);
  }
  print(dim(theme, "  A missing provider's key can go in your shell ENV VAR, or the encrypted vault:"));
  print(dim(theme, "    · env var — set the name shown in /login (e.g. ANTHROPIC_API_KEY), relaunch"));
  print(dim(theme, "    · vault  — run `guru keys set <NAME>` (hidden prompt), then /keys reload (or relaunch)"));
  print(dim(theme, "  /keys rm <NAME> removes one · guru does NOT read any external credential store."));
}

function cmdLogout(state: GuruState, selector: string): void {
  if (selector.length === 0) {
    print(dim(theme, "Usage: /logout <provider>"));
    return;
  }
  const routes = routesForSelector(state, selector);
  const route = routes[0];
  if (!route) {
    print(colorize(theme, "yellow", `No provider matches '${selector}'.`));
    return;
  }
  const source = route.credentialSource;
  print(bold(theme, `logout: ${route.providerId}`));
  if (source.filePath) {
    print(`  This lane uses the provider's OWN token cache (${source.filePath}). Log out through the provider's CLI — guru never deletes caches it doesn't own.`);
  } else {
    const name = source.envVarName ?? source.envVarNames[0];
    print(`  Remove the credential at its source (unset the env var, or /keys rm ${name ?? "<NAME>"}).`);
  }
  print(dim(theme, "  Guru holds no token file to clear — presence-over-value."));
}

function cmdTools(state: GuruState): void {
  if (!state.session) {
    print(dim(theme, "No session."));
    return;
  }
  print(paint.bold(paint.fg("fgBright", "Session tools")) + paint.fg("muted", `  (${state.session.tools.length} registered)`));
  const rows = state.session.tools.map((tool) => {
    const modelFacing = activeChatToolIds(state).has(tool.id);
    const gated = !READ_ONLY_TOOL_IDS.has(tool.id);
    return [
      modelFacing ? paint.fg("accent2", GLYPHS.agent) : " ",
      tool.id,
      gated ? badge(paint, "GATED", "ghost") : paint.fg("success", "free"),
      paint.fg("fgFaint", tool.description.length > 60 ? `${tool.description.slice(0, 59)}…` : tool.description)
    ];
  });
  for (const line of renderTable(paint, [{ header: " " }, { header: "tool" }, { header: "access" }, { header: "description" }], rows)) {
    print(`  ${line}`);
  }
  print(paint.fg("fgFaint", `  ${GLYPHS.agent} = offered to the model in chat turns · GATED = prompts per-call (y/N/always)`));
}

function cmdHelp(): void {
  const groups: ReadonlyArray<{ title: string; names: readonly string[] }> = [
    { title: "work", names: ["/model", "/models", "/role", "/mandate", "/yolo", "/lookahead", "/tools", "/skills", "/remember", "/memory"] },
    { title: "sessions", names: ["/sessions", "/resume", "/new", "/clear"] },
    { title: "info", names: ["/status", "/login", "/accounts", "/logout", "/settings", "/help"] },
    { title: "leave", names: ["/exit"] }
  ];
  for (const group of groups) {
    print(paint.bold(paint.fg("fgBright", group.title)));
    for (const name of group.names) {
      const command = SLASH_COMMANDS.find((candidate) => candidate.name === name);
      if (command) {
        print(`  ${paint.fg("accent", command.usage.padEnd(40))} ${paint.fg("muted", command.description)}`);
      }
    }
  }
  print("");
  print(
    `  ${paint.bg("bgSelect", paint.fg("fgBright", " / "))} ${paint.fg("muted", "menu")}   ${paint.bg("bgSelect", paint.fg("fgBright", " ↑↓ "))} ${paint.fg("muted", "navigate")}   ${paint.bg("bgSelect", paint.fg("fgBright", " → "))} ${paint.fg("muted", "drill")}   ${paint.bg("bgSelect", paint.fg("fgBright", " ⇥ "))} ${paint.fg("muted", "accept")}   ${paint.bg("bgSelect", paint.fg("fgBright", " ^C^C "))} ${paint.fg("muted", "quit")}`
  );
  print("");
  print(paint.fg("fgFaint", "  Anything not starting with / is sent to the connected model."));
}

function cmdMenu(): void {
  print(bold(theme, "/ command menu") + dim(theme, "  (type a command, e.g. /model — Tab completes)"));
  for (const command of SLASH_COMMANDS) {
    print(`  ${colorize(theme, "cyan", command.name.padEnd(16))} ${dim(theme, command.description)}`);
  }
}

/**
 * Rank slash commands against a partial line (Claude-Code-style intent matching):
 * exact > name-prefix > name-substring > description keyword. Non-matches drop out.
 */
export function filterSlashCommands(partial: string): SlashCommand[] {
  const term = partial.trim().toLowerCase();
  if (!term.startsWith("/")) {
    return [];
  }
  const needle = term.slice(1);
  if (needle.length === 0) {
    return [...SLASH_COMMANDS];
  }
  const scored = SLASH_COMMANDS.map((command) => {
    const name = command.name.toLowerCase();
    const score =
      name === term ? 0 : name.startsWith(term) ? 1 : name.includes(needle) ? 2 : command.description.toLowerCase().includes(needle) ? 3 : -1;

    return { command, score };
  }).filter((entry) => entry.score >= 0);

  return scored.sort((left, right) => left.score - right.score).map((entry) => entry.command);
}

/** Tab accepts the top guess (readline completer contract: [matches, line]). */
export function completeSlashCommand(line: string): [string[], string] {
  const ranked = filterSlashCommands(line);

  return [ranked.length > 0 && line.startsWith("/") ? [ranked[0]!.name] : [], line];
}

/**
 * Inject live-session defaults the model can't know / shouldn't pay for:
 * - repoRoot for base tools (abs path)
 * - includeContents=false for repo.context.resolve (token-efficient default; the
 *   model may pass includeContents=true explicitly, and the read tool covers
 *   targeted full-text needs).
 */
export function injectRepoRoot(toolId: string, input: unknown, session: HarnessSession): unknown {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

  if (toolId === "repo.context.resolve") {
    return { includeContents: false, ...record };
  }

  if (!REPO_ROOT_TOOL_IDS.has(toolId) || session.repo === null) {
    return input;
  }

  // bash/edit/write only execute after the per-call approval gate, so their
  // dry-run defaults would silently no-op every approved
  // call — the model's edits "succeed" without changing a file (found live in the
  // 2026-07-02 scale shakedown). Approved calls run for real unless the model
  // explicitly asks for a dry run.
  const defaults: Record<string, unknown> =
    toolId === "bash" || toolId === "edit" || toolId === "write" ? { dryRun: false } : {};

  if (typeof record.repoRoot === "string" && record.repoRoot.length > 0) {
    return { ...defaults, ...record };
  }
  return { ...defaults, ...record, repoRoot: session.repo.repoRoot };
}

export interface ComposerDeps {
  readonly input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
  readonly output: { write(text: string): boolean };
  /** Keypress handling attaches only when true (real TTY, or terminal-mode test streams). */
  readonly interactive: boolean;
  /** Styled prompt text for the first editor row. Defaults to the brand "▸ ". */
  readonly promptText?: string;
  readonly columns?: () => number;
  /** cwd for Tab path completion; defaults to process.cwd(). */
  readonly cwd?: string;
  /**
   * Persistent composer chrome drawn BELOW the input on every render (status bar +
   * hint line) — pinned under the composer, reflows on resize. Empty = no chrome.
   */
  chromeRows?(): string[];
  isBusy(): boolean;
  commandItems(buffer: string): MenuItem[];
  drillItems(parentId: string): MenuItem[];
  /** @ picker candidates for a query — injectable; defaults to the bounded repo scan. */
  pickFiles?(query: string): readonly string[];
  /** Tab path completion — injectable; defaults to completePathToken. */
  completePath?(token: string, cwd: string): PathCompletion;
}

/**
 * Pure builder for the menu overlay lines (testable). Given the visible state,
 * returns the rows drawn BELOW the input. Kept side-effect-free so the render
 * math (highlight, windowing, crumb) is unit-tested without a terminal.
 */
export function buildMenuOverlayRows(paintApi: Painter, menu: MenuState): string[] {
  const needle = menu.mode === "commands" ? menu.buffer.slice(1).toLowerCase() : "";
  const highlight = (name: string): string => {
    const at = needle.length > 0 ? name.toLowerCase().indexOf(needle, 1) : -1;
    if (at < 0) return name;
    return `${name.slice(0, at)}${paintApi.bold(paintApi.fg("accent2", name.slice(at, at + needle.length)))}${name.slice(at + needle.length)}`;
  };
  const start = Math.max(0, Math.min(menu.selected - 3, menu.items.length - 7));
  const view = menu.items.slice(start, start + 7);
  const labelWidth = Math.max(15, ...view.map((v) => v.label.length));
  const rows = view.map((item, offset) => {
    const index = start + offset;
    const label = highlight(item.label.padEnd(labelWidth));
    const drill = item.drillable ? paintApi.fg("fgFaint", " ›") : "  ";
    return index === menu.selected
      ? paintApi.bg("bgSelect", `  ${paintApi.fg("accent", "▸")} ${label}${drill} ${paintApi.fg("muted", item.hint ?? "")} `)
      : `    ${paintApi.fg("fg", label)}${drill} ${paintApi.fg("muted", item.hint ?? "")}`;
  });
  const crumb = menu.mode === "drill" ? `${menu.parentId} › ` : "";
  rows.push(paintApi.fg("fgFaint", `    ${crumb}↑↓ move · › drill · ‹ back · ⇥ accept · ⏎ run · esc close`));
  return rows;
}

/**
 * The composer controller (P1 wave, ADR 2026-07-05-composer-editor): OWNS the
 * input in TTY mode — a hand-rolled multi-line editor (Ctrl+J newline contract),
 * the slash menu, the @ file picker, Tab path completion, and the pinned chrome —
 * all drawn as ONE block with RELATIVE moves only (clear-below + cursor-up; never
 * DECSC/DECRC, which drift on Windows-Terminal scroll). Replaces readline's line
 * management entirely; the readline private-API line surgery is gone.
 */
export function attachComposer(deps: ComposerDeps): {
  readLine(): Promise<string | null>;
  takePendingSelection(): string | null;
  isMenuOpen(): boolean;
  isPickerOpen(): boolean;
  isClosed(): boolean;
  bufferText(): string;
  refresh(): void;
  clear(): void;
  beginPrompt(): void;
  /** Abandon the current prompt frame cleanly (Ctrl+C hint path). */
  abortPrompt(): void;
  onInterrupt(handler: () => void): void;
  close(): void;
} {
  const columns = deps.columns ?? ((): number => process.stdout.columns ?? 80);
  const promptText = deps.promptText ?? paint.bold(paint.fg("accent", "▸ "));
  const promptCols = promptWidth(promptText);
  const cwd = deps.cwd ?? process.cwd();
  const completePath = deps.completePath ?? completePathToken;
  let pickerScan: RepoFileScan | null = null;
  const pickFiles =
    deps.pickFiles ??
    ((query: string): readonly string[] => {
      // Re-walked on every picker OPEN (openPickerScan below) so files created
      // mid-session appear; the walk is bounded, so this stays instant.
      pickerScan ??= scanRepoFiles(cwd);
      return filterFiles(pickerScan.files, query).map((match) => match.path);
    });
  const openPickerScan = (): void => {
    pickerScan = null; // invalidate: fresh bounded walk for this picker session
  };

  let editor = createEditorState();
  let menu: MenuState | null = null;
  /** @ picker: anchor = position of the "@" in the buffer; filter derives from it. */
  let picker: { row: number; col: number; menu: MenuState } | null = null;
  let pendingSelection: string | null = null;
  let interruptHandler: () => void = () => undefined;
  /**
   * FIFO of pending readLine() resolvers — a second concurrent read must wait
   * for the NEXT submission, never overwrite (and hang) the first (CodeRabbit
   * round 2).
   */
  const submitResolvers: Array<(line: string | null) => void> = [];
  /**
   * Submissions that arrived while no readLine() was pending (a multi-line
   * paste carries several \r in ONE chunk; the loop re-arms in a microtask).
   * Dropping them was the critical adversarial finding — queue instead.
   */
  const queuedSubmissions: string[] = [];
  let closed = false;
  /** Visual cursor row within the last-rendered editor frame (for relative moves). */
  let lastCursorRow = 0;
  let rendered = false;

  const overlayRows = (): string[] => {
    const menuState = picker ? picker.menu : menu;
    let menuRows = menuState && menuState.items.length > 0 ? buildMenuOverlayRows(paint, menuState) : [];
    if (picker && picker.menu.items.length === 0) {
      // NEVER an invisible open picker (adversarial finding: it ate Enter).
      menuRows = [paint.fg("fgFaint", "    @ no matching files — esc to dismiss")];
    } else if (picker && pickerScan?.truncated) {
      menuRows = [...menuRows, paint.fg("fgFaint", "    (file list truncated — keep typing to narrow)")];
    }
    const chrome = deps.chromeRows ? deps.chromeRows() : [];
    return menuRows.length > 0 && chrome.length > 0 ? [...menuRows, "", ...chrome] : [...menuRows, ...chrome];
  };

  /**
   * ANSI-aware hard clamp to the terminal width: an overlay/chrome row that
   * wrapped would silently add physical rows the relative-move accounting
   * doesn't know about, stacking stale frames (adversarial finding). Measures
   * DISPLAY cells (CJK/emoji are 2) — a UTF-16 count would let wide rows slip
   * past the clamp and hard-wrap anyway (CodeRabbit round 2).
   */
  const clampToWidth = (row: string, width: number): string => {
    if (stringDisplayWidth(row.replace(/\x1b\[[0-9;]*m/gu, "")) <= width) {
      return row;
    }
    let out = "";
    let visible = 0;
    for (let at = 0; at < row.length && visible < width; ) {
      if (row[at] === "\x1b") {
        const match = /^\x1b\[[0-9;]*m/u.exec(row.slice(at));
        if (match) {
          out += match[0];
          at += match[0].length;
          continue;
        }
      }
      const codePoint = row.codePointAt(at) ?? 0;
      const char = String.fromCodePoint(codePoint);
      const cells = charDisplayWidth(codePoint);
      if (visible + cells > width) {
        break; // a wide char at the edge must not spill past the clamp
      }
      out += char;
      visible += cells;
      at += char.length;
    }
    return `${out}\x1b[0m`;
  };

  /**
   * Full-block redraw: [editor rows] + [overlay] as one region. Relative moves
   * only: up to the block's first row, clear below, rewrite, reposition.
   */
  const render = (): void => {
    if (!deps.interactive || deps.isBusy() || closed) {
      return;
    }
    const width = columns();
    const frame = renderEditorFrame(paint, editor, { text: promptText, width: promptCols }, width);
    const below = overlayRows().map((row) => clampToWidth(row, width));
    if (rendered && lastCursorRow > 0) {
      deps.output.write(`\x1b[${lastCursorRow}A`);
    }
    deps.output.write("\x1b[1G\x1b[0J");
    deps.output.write(frame.rows.join("\n"));
    if (below.length > 0) {
      deps.output.write(`\n${below.join("\n")}`);
    }
    const totalRows = frame.rows.length + below.length;
    const upFromBottom = totalRows - 1 - frame.cursorRow;
    if (upFromBottom > 0) {
      deps.output.write(`\x1b[${upFromBottom}A`);
    }
    deps.output.write(`\x1b[${frame.cursorCol}G`);
    lastCursorRow = frame.cursorRow;
    rendered = true;
  };

  /** Finalize a submission: echo the buffer as scrollback, cursor below it. */
  const renderFinal = (text: string): void => {
    if (!deps.interactive) {
      return;
    }
    if (rendered && lastCursorRow > 0) {
      deps.output.write(`\x1b[${lastCursorRow}A`);
    }
    deps.output.write("\x1b[1G\x1b[0J");
    const echoed = text.split("\n").map((line, index) => (index === 0 ? `${promptText}${line}` : `${" ".repeat(promptCols)}${line}`));
    deps.output.write(`${echoed.join("\n")}\n`);
    rendered = false;
    lastCursorRow = 0;
  };

  const pickerFilter = (): string => {
    if (!picker) {
      return "";
    }
    const line = editor.lines[picker.row] ?? "";
    return line.slice(picker.col + 1, editor.row === picker.row ? editor.col : line.length);
  };

  const refreshPicker = (): void => {
    if (!picker) {
      return;
    }
    const line = editor.lines[picker.row] ?? "";
    // The anchor "@" was deleted or the cursor left the anchor line — close.
    if (line[picker.col] !== "@" || editor.row !== picker.row || editor.col <= picker.col) {
      picker = null;
      return;
    }
    const query = pickerFilter();
    // Whitespace in the query = the operator is writing prose, not a file
    // reference (adversarial finding: '@' mid-sentence hijacked Enter forever).
    if (/\s/u.test(query)) {
      picker = null;
      return;
    }
    const items: MenuItem[] = pickFiles(query).map((path) => ({ id: path, label: path, hint: "" }));
    picker = { ...picker, menu: createMenuState(items, query) };
  };

  const syncMenuToBuffer = (): void => {
    const buffer = editorText(editor);
    if (deps.isBusy() || isMultiline(editor) || !buffer.startsWith("/") || buffer.includes(" ")) {
      menu = null;
      return;
    }
    const items = deps.commandItems(buffer);
    menu = menu && menu.mode === "commands" ? refilter(menu, items, buffer) : createMenuState(items, buffer);
  };

  /** Replace the @query span with the selected path (ADR: ⏎ inserts the reference). */
  const acceptPickerSelection = (): void => {
    if (!picker) {
      return;
    }
    const chosen = selectedItem(picker.menu)?.id;
    if (chosen === undefined) {
      picker = null;
      return;
    }
    const line = editor.lines[picker.row] ?? "";
    const before = line.slice(0, picker.col);
    // Replace the WHOLE @token (anchor → next whitespace/EOL), not just up to
    // the cursor — a cursor parked mid-query would otherwise glue leftover
    // query text onto the inserted path (adversarial finding).
    let tokenEnd = picker.col;
    while (tokenEnd < line.length && !/\s/u.test(line[tokenEnd] as string)) {
      tokenEnd += 1;
    }
    const after = line.slice(tokenEnd);
    const nextLine = `${before}${chosen}${after}`;
    const lines = [...editor.lines];
    lines[picker.row] = nextLine;
    editor = { ...editor, lines, col: before.length + chosen.length };
    picker = null;
  };

  const completeAtCursor = (): void => {
    const line = editor.lines[editor.row] ?? "";
    const head = line.slice(0, editor.col);
    const match = /(\S+)$/u.exec(head);
    if (!match || match[1] === undefined) {
      return;
    }
    const token = match[1];
    const completion = completePath(token, cwd);
    if (completion.completed !== token) {
      const start = editor.col - token.length;
      const nextLine = line.slice(0, start) + completion.completed + line.slice(editor.col);
      editor = { ...editor, lines: replaceEditorLine(editor.lines, editor.row, nextLine), col: start + completion.completed.length };
    }
  };

  const submit = (text: string): void => {
    if (menu) {
      pendingSelection = selectedItem(menu)?.id ?? null;
      menu = null;
    }
    renderFinal(text);
    const resolve = submitResolvers.shift();
    if (resolve) {
      resolve(text);
    } else {
      // No reader armed (multi-line paste, type-ahead during a command) —
      // QUEUE, never drop (the critical adversarial finding).
      queuedSubmissions.push(text);
    }
  };

  const onKey = (key: EditorKey): void => {
    if (closed) {
      return;
    }
    const name = key?.name ?? "";
    if (deps.isBusy()) {
      if (key?.ctrl === true && name === "c") {
        interruptHandler();
      }
      return; // a streaming turn owns the screen
    }

    // --- @ picker interception (arrows/enter/esc/tab; typing falls through) ---
    if (picker) {
      if (name === "up" || name === "down") {
        picker = { ...picker, menu: menuReduce(picker.menu, { name } as MenuKey).state };
        render();
        return;
      }
      if ((name === "return" || name === "tab") && picker.menu.items.length > 0) {
        acceptPickerSelection();
        render();
        return;
      }
      if (name === "return") {
        // No matches to accept — the Enter is the OPERATOR'S submit, not the
        // picker's (adversarial finding: the empty picker ate the keystroke).
        picker = null;
      } else if (name === "escape") {
        picker = null; // typed text stays, per the ADR
        render();
        return;
      } else if (name === "tab") {
        picker = null; // fall through to path completion below
      }
    }

    // --- slash-menu interception (exact legacy semantics) ---
    if (menu && !picker && (name === "up" || name === "down" || name === "left" || name === "right" || name === "escape" || name === "tab")) {
      const step = menuReduce(menu, { name } as MenuKey);
      menu = step.state;
      if (step.effect.kind === "close") {
        editor = createEditorState(editor.history);
        menu = null;
      } else if (step.effect.kind === "accept") {
        editor = withBufferText(createEditorState(editor.history), step.effect.text);
        menu = { ...menu, buffer: step.effect.text };
      } else if (step.effect.kind === "drill") {
        if (step.effect.parentId === "") {
          menu = refilter(menu, deps.commandItems(menu.buffer), menu.buffer);
        } else {
          const items = deps.drillItems(step.effect.parentId);
          if (items.length > 0) {
            menu = enterDrill(menu, step.effect.parentId, items);
          }
        }
        editor = withBufferText(createEditorState(editor.history), menu.buffer);
      }
      render();
      return;
    }

    // --- Tab completion (menu closed): paths at the cursor token ---
    if (name === "tab" && !menu && !picker) {
      completeAtCursor();
      render();
      return;
    }

    // --- the editor owns everything else ---
    const step = editorReduce(editor, key ?? {});
    editor = step.state;
    if (step.effect.kind === "interrupt") {
      interruptHandler();
      return;
    }
    if (step.effect.kind === "eof") {
      close();
      return;
    }
    if (step.effect.kind === "submit") {
      picker = null;
      submit(step.effect.text);
      return;
    }
    if (step.effect.kind === "render") {
      // @ trigger: anchor at the LAST "@" of the typed run (a single keystroke
      // is a 1-char run; a pasted "@query" anchors at its "@") — but ONLY at a
      // word boundary: an email/handle mid-prose must not hijack the composer.
      const run = key?.sequence ?? "";
      const atIndex = run.lastIndexOf("@");
      if (atIndex !== -1 && !picker) {
        const anchorCol = editor.col - (run.length - atIndex);
        const lineText = editor.lines[editor.row] ?? "";
        const before = anchorCol > 0 ? lineText[anchorCol - 1] : undefined;
        if (before === undefined || /\s/u.test(before)) {
          openPickerScan();
          picker = { row: editor.row, col: anchorCol, menu: createMenuState([], "") };
        }
      }
      refreshPicker();
      if (!picker) {
        syncMenuToBuffer();
      }
      render();
    }
  };

  // Hand-rolled key decoding (src/tui/keys.ts): standalone emitKeypressEvents
  // buffers a lone ESC forever (its timeout lives in readline's Interface,
  // which the composer replaced) — Esc in the picker would hang until the next
  // key. The decoder parses raw chunks with a short ESC grace instead. The
  // StringDecoder reassembles multibyte UTF-8 split across reads (a split
  // emoji/CJK char otherwise corrupts to U+FFFD — adversarial finding).
  const decoder = createKeyDecoder(onKey);
  const utf8 = new StringDecoder("utf8");
  const onData = (chunk: Buffer | string): void => {
    decoder.feed(typeof chunk === "string" ? chunk : utf8.write(chunk));
  };

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (deps.interactive) {
      // Finalize the on-screen frame so exit text lands cleanly below it.
      if (rendered && lastCursorRow > 0) {
        deps.output.write(`\x1b[${lastCursorRow}A`);
      }
      if (rendered) {
        deps.output.write("\x1b[1G\x1b[0J");
        rendered = false;
      }
      deps.input.removeListener("data", onData);
      decoder.dispose();
      deps.output.write("\x1b[?2004l"); // stop bracketed-paste mode
      deps.input.setRawMode?.(false);
      // A resumed TTY stdin keeps the event loop referenced even with no
      // listeners — without pause() the process hangs after "bye."
      (deps.input as { pause?: () => void }).pause?.();
    }
    for (const resolve of submitResolvers.splice(0)) {
      resolve(null);
    }
  };

  if (deps.interactive) {
    deps.input.setRawMode?.(true);
    deps.output.write("\x1b[?2004h"); // bracketed paste: pastes arrive as ESC[200~…ESC[201~
    deps.input.on("data", onData);
    (deps.input as { resume?: () => void }).resume?.();
  }

  return {
    readLine: () =>
      new Promise<string | null>((resolve) => {
        const queued = queuedSubmissions.shift();
        if (queued !== undefined) {
          resolve(queued); // paste/type-ahead submissions drain in order
          return;
        }
        if (closed) {
          resolve(null);
          return;
        }
        submitResolvers.push(resolve);
      }),
    takePendingSelection: () => {
      const taken = pendingSelection;
      pendingSelection = null;
      return taken;
    },
    isMenuOpen: () => menu !== null,
    isPickerOpen: () => picker !== null,
    isClosed: () => closed,
    bufferText: () => editorText(editor),
    /** Redraw the whole composer block (after prompt / turn / resize). */
    refresh: render,
    /** Erase the below-region (before printing transcript output). */
    clear: () => {
      if (rendered) {
        deps.output.write("\x1b[0J");
      }
    },
    /** Start a fresh prompt frame (new empty buffer, chrome pinned below). */
    beginPrompt: () => {
      rendered = false;
      lastCursorRow = 0;
      render();
    },
    /** Clear the current frame without submitting (Ctrl+C hint path). */
    abortPrompt: () => {
      if (rendered && lastCursorRow > 0) {
        deps.output.write(`\x1b[${lastCursorRow}A`);
      }
      if (rendered) {
        deps.output.write("\x1b[1G\x1b[0J");
        rendered = false;
        lastCursorRow = 0;
      }
      editor = createEditorState(editor.history);
      menu = null;
      picker = null;
    },
    onInterrupt: (handler) => {
      interruptHandler = handler;
    },
    close
  };
}

/** Replace one logical line (composer-local helper mirroring the editor's). */
function replaceEditorLine(lines: readonly string[], row: number, text: string): string[] {
  const next = [...lines];
  next[row] = text;
  return next;
}

/** Discover prompt templates without ever failing boot on a malformed dir. */
function safeDiscoverTemplates(): readonly PromptTemplate[] {
  try {
    // A template whose name collides with a built-in command would be
    // discoverable but never dispatch (built-ins own the switch) — drop it so
    // the / menu never advertises a dead command.
    const builtinNames = new Set(SLASH_COMMANDS.map((command) => command.name));
    return discoverPromptTemplates().filter((template) => !builtinNames.has(`/${template.name}`));
  } catch {
    return [];
  }
}

/** A short repo tree for the template $TREE expansion (top-level, bounded). */
function repoTreePreview(repoRoot: string): string {
  try {
    const skip = new Set([".git", "node_modules", "dist", "coverage", ".trash"]);
    const entries = readdirSync(repoRoot)
      .filter((entry) => !skip.has(entry) && !entry.startsWith("."))
      .slice(0, 40)
      .map((entry) => {
        try {
          return statSync(join(repoRoot, entry)).isDirectory() ? `${entry}/` : entry;
        } catch {
          return entry;
        }
      });
    return entries.join("\n");
  } catch {
    return "";
  }
}

/** PATH presence probe (presence only — never the path/version). */
function commandOnPath(name: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(probe, [name], { stdio: ["ignore", "ignore", "ignore"], timeout: 5_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const MOVE_TO_GAP: Readonly<Record<NeverStuckMove, "build" | "attach" | "learn" | "depend" | null>> = {
  "already-have": null,
  attach: "attach",
  "learn-replicate": "learn",
  build: "build"
};

/**
 * The enforced boot ritual (ADR 2026-07-05-boot-ritual, §4): five ORDERED,
 * non-skippable phases run as deterministic code every wake, rendered from the
 * live session state. Replaces the old display-panel briefing.
 */
async function printLaunchBriefing(state: GuruState, baselineHealth: { readonly command: readonly string[]; readonly timeoutMs: number }): Promise<void> {
  const info = getRuntimeInfo();
  let skillsCount = "?";
  let honcho = "unknown";
  if (state.session) {
    try {
      const skills = await state.runtime.executeTool(state.session.id, "skills.catalog.list", {});
      const list = (skills.output as { skills?: unknown[] } | undefined)?.skills;
      skillsCount = Array.isArray(list) ? String(list.length) : "?";
    } catch {
      skillsCount = "?";
    }
    try {
      const status = await state.runtime.executeTool(state.session.id, "honcho_memory_status", {});
      honcho = (status.output as { status?: string } | undefined)?.status ?? "unknown";
    } catch {
      honcho = "unavailable";
    }
  }
  const readiness = summarizeReadiness(mapRoutesToProviders(state.routes, { lastCheckedAt: new Date().toISOString(), env: process.env }));
  const cwd = state.session?.repo?.repoRoot ?? process.cwd();
  const registeredToolIds = new Set(state.sessionTools.map((tool) => tool.id));

  const hooks: BootRitualHooks = {
    kernelAssert: (): PhaseOutput => ({
      status: "ok",
      lines: [
        `I am guru harness ${info.version} · node ${process.versions.node}`,
        `model: ${state.connectedRoute?.routeId ?? "none — /model to connect"} · access: ${state.yolo ? "YOLO (gates lifted)" : state.mandate.grants.length > 0 ? `${state.mandate.grants.length} standing mandate(s)` : "per-call approval"}`,
        `resolver: ${registeredToolIds.size > 0 ? "bound (never-stuck ready)" : "not bound"} · cwd: ${cwd}`
      ]
    }),
    inspectGarage: (): PhaseOutput => {
      const manifests = listManifests(guruMemoryStore);
      if (manifests.length === 0) {
        return { status: "skip", lines: ["garage empty — suits emerge from work (/role suit <thing>)"] };
      }
      const lines = manifests.slice(0, 6).map((manifest) => {
        const verified = manifest.layers.filter((layer) => layer.status === "verified").length;
        const stale = manifest.layers.filter((layer) => layer.staleFlag).length;
        const red = manifest.layers.filter((layer) => layer.status === "red").length;
        const worn = manifest.lastWornSession !== null ? `worn #${manifest.lastWornSession} (${Math.max(0, state.sessionNumber - manifest.lastWornSession)} session(s) ago)` : `worn ${manifest.wornCount}×`;
        return `${manifest.slug}: ${manifest.layers.length} layer(s) · ${verified} verified${stale ? ` · ${stale} stale` : ""}${red ? ` · ${red} red` : ""} · ${worn}`;
      });
      return { status: "ok", lines: [`${manifests.length} suit(s) in the garage (typed query):`, ...lines] };
    },
    injectMemory: (): PhaseOutput => {
      const injected = new Set(injectedLearningIds);
      const learnings = loadLearnings(guruMemoryStore).filter((learning) => injected.has(learning.id));
      const lines = [`${guruMemoryStore.list().length} fact(s) · honcho ${honcho} · ${injected.size} learning(s) injected (decay-ranked, with provenance)`];
      for (const learning of learnings.slice(0, 4)) {
        lines.push(`↳ (${learning.level}·cited ${learning.citations.length}×${learning.lastCitedSession !== null ? `·last #${learning.lastCitedSession}` : ""}) ${learning.statement}`);
      }
      return { status: "ok", lines };
    },
    declareWork: (): PhaseOutput => {
      const probe = { toolPresent: (id: string) => registeredToolIds.has(id), cmdPresent: commandOnPath };
      const { open, closed } = evaluateAndClose(loadGapRecords(guruMemoryStore), probe);
      const lines: string[] = [];
      const active = state.activeRole;
      if (!active) {
        lines.push("naked — no task declared yet (/role suit <thing> to dress for the day)");
      } else {
        const suit = assembleSuit(active, registeredToolIds, READ_ONLY_TOOL_IDS);
        lines.push(`task: ${active.label} · have ${suit.chatToolIds.size} tool(s)${suit.missingTools.length > 0 ? ` · lack ${suit.missingTools.length}` : " · fully equipped"}`);
        const newRecords = [];
        for (const need of suit.missingTools.slice(0, 3)) {
          const resolution = resolveCapabilityGap({ need, candidateCommands: [], referencePrograms: [] }, { registeredToolIds, toolSummaries: new Map() });
          lines.push(`gap "${need}" → ${resolution.move.toUpperCase()}: ${resolution.statement}`);
          const move = MOVE_TO_GAP[resolution.move];
          if (move) {
            newRecords.push(makeGapRecord(need, move, resolution.statement, new Date().toISOString()));
          }
        }
        if (newRecords.length > 0 || closed.length > 0) {
          saveGapRecords(guruMemoryStore, upsertGapRecords(open, newRecords));
        }
      }
      if (closed.length > 0) {
        lines.push(`✓ ${closed.length} gap record(s) CLOSED — the world provided them (trigger satisfied)`);
      } else if (open.length > 0) {
        lines.push(`${open.length} open gap record(s) tracked — re-checked every boot`);
      }
      return { status: active || open.length > 0 || closed.length > 0 ? "ok" : "skip", lines };
    },
    baselineHealth: (): PhaseOutput => {
      if (baselineHealth.command.length === 0) {
        return { status: "skip", lines: ["not configured — set baselineHealth.command for a boot TTFV gate"] };
      }
      const [cmd, ...args] = baselineHealth.command;
      const start = Date.now();
      const result = spawnSync(cmd as string, args, { cwd, timeout: baselineHealth.timeoutMs, encoding: "utf8", windowsHide: true });
      const green = result.status === 0;
      return {
        status: green ? "ok" : "warn",
        lines: [`${baselineHealth.command.join(" ")} → ${green ? "GREEN" : "RED"} (${Date.now() - start}ms)${green ? "" : " — session continues; fix before you trust it"}`]
      };
    }
  };

  const report = runBootRitual(hooks, state.sessionNumber);
  const glyphFor = (status: string): string => (status === "ok" ? paint.fg("success", GLYPHS.ok) : status === "warn" ? paint.fg("warning", GLYPHS.warn) : paint.fg("fgFaint", "·"));
  const boxLines: string[] = [
    paint.fg("muted", `session #${report.sessionNumber} · ${readiness.active + readiness.readyUnverified} route(s) ready · ${readiness.missingOrLogin} need login/key · ${skillsCount} skill(s) · theme ${paint.name}`)
  ];
  for (const phase of report.phases) {
    boxLines.push(`${paint.fg("accent", String(phase.ordinal))} ${paint.bold(paint.fg("fgBright", phase.title))} ${glyphFor(phase.status)}`);
    for (const line of phase.lines) {
      boxLines.push(paint.fg("fg", `  ${line}`));
    }
  }
  for (const line of roundedBox(paint, boxLines, { title: "BOOT RITUAL" })) {
    print(line);
  }
}

/** Badge verbs for the tool-call trace (§5): RUN/READ/EDIT/WRITE, else TOOL. */
const TOOL_BADGE: Readonly<Record<string, string>> = {
  bash: "RUN",
  read: "READ",
  edit: "EDIT",
  write: "WRITE",
  "repo.context.resolve": "REPO"
};

function renderToolEvent(event: AgentToolEvent): void {
  const verb = TOOL_BADGE[event.toolId] ?? "TOOL";
  const kind = event.status === "succeeded" ? "brand" : event.status === "blocked" ? "warning" : "error";
  const glyph =
    event.status === "succeeded"
      ? paint.fg("success", GLYPHS.ok)
      : event.status === "blocked"
        ? paint.fg("warning", GLYPHS.warn)
        : paint.fg("error", GLYPHS.fail);
  const timing = event.durationMs !== undefined ? paint.fg("muted", ` ${event.durationMs}ms`) : "";
  const name = verb === "TOOL" ? ` ${paint.fg("fg", event.toolId)}` : "";
  const what = event.inputPreview !== undefined ? ` ${paint.fg("fgBright", event.inputPreview)}` : "";
  const detail = event.detail !== undefined ? paint.fg("muted", ` — ${event.detail}`) : "";
  print(`  ${badge(paint, verb, kind)}${name}${what} ${glyph}${timing}${detail}`);
  // "Show me what it's doing": first result lines, muted, under the badge (§5).
  if (event.outputPreview !== undefined && event.status === "succeeded") {
    for (const line of event.outputPreview.split("\n")) {
      print(line.startsWith("… ") ? paint.fg("fgFaint", `      ${line}`) : paint.fg("muted", `      ${line}`));
    }
  }
}

/**
 * Read a single keypress from stdin. Raw mode is already on (the composer set it),
 * and the composer's own handler ignores input while `isBusy()` — so this one-shot
 * read during a turn has no conflict.
 */
function readOneKey(): Promise<string> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer): void => {
      process.stdin.off("data", onData);
      resolve(chunk.toString("utf8").slice(0, 1));
    };
    process.stdin.on("data", onData);
  });
}

/**
 * The interactive per-call approval prompt (v0.22). TTY only — a non-TTY caller
 * has no channel to answer, so it DENIES (fail-safe). Default (Enter / N / Ctrl+C /
 * anything else) is deny; the operator must actively type `y`, or `a` for always.
 */
async function promptApproval(request: ApprovalRequest, stopSpinner: () => void): Promise<ApprovalChoice> {
  if (!process.stdout.isTTY) {
    return "deny";
  }
  stopSpinner();
  const edge = request.hardEdge ? paint.fg("error", " HARD EDGE") : "";
  print(
    `  ${badge(paint, "APPROVE?", "warning")} ${paint.fg("fgBright", request.toolId)} ${paint.fg("muted", request.verbs.join("+"))}${edge} ${paint.fg("fgFaint", `— ${request.reason}`)}`
  );
  print(dim(theme, request.allowAlways ? "  [y] once · [a] always this session · [enter/N] deny" : "  [y] approve · [enter/N] deny  (hard edge — no 'always')"));
  const key = (await readOneKey()).toLowerCase();
  if (key === "y") {
    return "once";
  }
  if (key === "a" && request.allowAlways) {
    return "always";
  }
  return "deny";
}

/** Refresh a guru-native OAuth token that's near expiry, persisting the rotated token. */
async function refreshCodexTokenIfNeeded(state: GuruState, route: ProviderRouteDescriptor): Promise<void> {
  if (route.credentialSource.type !== "guru-oauth") {
    return;
  }
  const token = readVaultOAuthToken(state.vault, route.providerId);
  if (!token || !isTokenNearExpiry(token)) {
    return;
  }
  try {
    const refreshed =
      route.providerId === "grok"
        ? await refreshXaiToken(resolveXaiOAuthConfig(), token)
        : await refreshOAuthToken(resolveOAuthConfig(), token);
    writeVaultOAuthToken(state.vault, route.providerId, refreshed);
    registerSecretValue(refreshed.accessToken);
    if (refreshed.refreshToken) {
      registerSecretValue(refreshed.refreshToken);
    }
  } catch (error) {
    if (error instanceof OAuthRefreshError && error.permanent) {
      print(colorize(theme, "yellow", `  ${route.providerId} session expired — run /login ${route.providerId} to sign in again.`));
    }
    // A transient refresh failure lets the turn proceed on the current token (a real
    // 401 then surfaces to the operator); only a permanent failure warns to re-login.
  }
}

async function chatTurn(state: GuruState, text: string): Promise<void> {
  if (!state.connectedRoute) {
    print(colorize(theme, "yellow", "No model connected. Use /model to browse and connect (e.g. /model 1)."));
    return;
  }
  // Keep a guru-native OAuth token fresh: refresh (rotating token persisted) BEFORE the
  // turn if it's within the expiry margin, so long sessions don't silently 401.
  await refreshCodexTokenIfNeeded(state, state.connectedRoute);
  // @-reference content expansion (ADR 2026-07-05-composer-completion): pull
  // referenced file contents inline, guarded (50KB head/tail, 80%-window skip,
  // secret scrub). Notices print so expansion is never silent.
  let submitted = text;
  if (text.includes("@") && state.session?.repo) {
    const expansion = expandReferences(text, {
      repoRoot: state.session.repo.repoRoot,
      baseTokens: estimateChatHistoryTokens(state.history),
      contextWindowTokens: state.connectedRoute.context?.contextWindowTokens ?? FALLBACK_CONTEXT_WINDOW_TOKENS
    });
    submitted = expansion.text;
    for (const notice of expansion.notices) {
      print(dim(theme, `  @ ${notice}`));
    }
  }
  state.history.push({ role: "user", content: submitted });
  logMessage(state, "user", submitted);
  // Natural-language suit trigger (§17 scenario 14): on the naked OPENING turn, a
  // plain-prose work declaration ("finances today") assembles the suit — no /role
  // needed. Announced + reversible (/role off); only the opening turn, only when
  // naked, so it never fires on ordinary mid-session chat.
  if (!state.activeRole && state.usage.turns === 0) {
    const intent = detectSuitIntent(submitted);
    if (intent) {
      print(dim(theme, `  heard "${submitted.trim().slice(0, 48)}" — suiting up (say /role off to stay naked)`));
      cmdRoleSuit(state, intent);
    }
  }
  // Smart Connections (§7): re-rank the injected memory by relevance to THIS turn
  // (BM25 over facts + a task-boost on learnings), so the model sees what matters
  // NOW — not just the newest/most-cited. No-op when memory is empty (block stays
  // "", system head unchanged), so the memory-less path is byte-identical.
  if (scopedMemory.activeStores().some(({ store }) => store.list().length > 0)) {
    refreshBootMemoryBlock(submitted);
    if (state.history[0]?.role === "system") {
      state.history[0] = { role: "system", content: systemPrompt() };
    }
  }
  state.busy = true;
  // Auto-compaction (P0): pre-turn check of BOTH signals — the provider-reported
  // context size of the last turn and the estimator over what we're about to send.
  state.compaction.sendLegacyWindowThisTurn = false;
  await maybeAutoCompact(state);
  const startedAt = Date.now();
  // Working indicator (§6): braille spinner breathing through the brand ramp until
  // the first token or tool event arrives. TTY only.
  let spinTick = 0;
  let spinnerShown = false;
  let spinnerTimer: NodeJS.Timeout | undefined;
  const stopSpinner = (): void => {
    if (spinnerTimer !== undefined) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
    if (spinnerShown) {
      process.stdout.write("\r\x1b[K");
      spinnerShown = false;
    }
  };
  if (process.stdout.isTTY) {
    spinnerTimer = setInterval(() => {
      spinnerShown = true;
      process.stdout.write(`\r  ${spinnerFrame(paint, spinTick++)} ${paint.fg("muted", "working…")}`);
    }, 80);
  }
  const session = state.session;
  let directStreamed = false;
  if (state.lookahead.enabled) { state.lookahead.reset(); }
  // Direct-ready plan lanes (Phase B: baseUrl + resolver-found credential) take the
  // REAL agentic tool-loop; the CLI delegate is only for routes with no endpoint.
  const turnDirectReady =
    state.connectedRoute.baseUrl !== undefined &&
    isChatCapableFamily(state.connectedRoute.apiFamily) &&
    resolveRouteCredential(state.connectedRoute).usable;
  try {
    if (isOperatorAuthRoute(state.connectedRoute) && !turnDirectReady) {
      // A plan/OAuth lane with no resolvable token = not signed in. guru NO LONGER
      // delegates any turn to a provider CLI (removed 2026-07): sign in through guru's
      // OWN /login (loopback OAuth → vaulted token) and the turn then runs NATIVELY,
      // exactly like every API-key model.
      stopSpinner();
      print("");
      const loginName = state.connectedRoute.providerId.replace(/-direct$/u, "");
      print(colorize(theme, "yellow", `  Not signed in to ${state.connectedRoute.providerId}. Run /login ${loginName} to sign in through guru, then send your message again.`));
      state.busy = false;
      return;
    }
    // Engine unification (v0.18b): the direct agentic turn runs THROUGH the shared
    // AgentSession — the SAME engine the SDK drives. guru keeps its exact pre-turn
    // work (@-expansion, user push, compaction, spinner) and post-turn rendering;
    // only the turn EXECUTION + assistant handling live in the engine now. The
    // driver injects the TUI's exact behaviors, so REPL output is byte-identical.
    state.agentSession ??= new AgentSession({
      runtime: state.runtime,
      route: state.connectedRoute,
      ...(session ? { session } : {}),
      sessionTools: state.sessionTools,
      mandate: state.mandate,
      now: () => new Date()
    });
    const result = await state.agentSession.driveTurn({
      getHistory: () => state.history,
      route: state.connectedRoute,
      ...(session ? { session } : {}),
      // Routes that reject tool declarations (e.g. Perplexity Sonar) get a plain
      // chat turn — sending tools draws an HTTP 400 from those APIs.
      tools:
        state.connectedRoute.capabilities?.supportsTools === false
          ? []
          : state.sessionTools.filter((tool) => activeChatToolIds(state).has(tool.id)),
      prepareMessages: (history) => sendableHistory(history, state.compaction.config.enabled && !state.compaction.sendLegacyWindowThisTurn),
      executeTool: (toolId, input) => {
        if (!session) {
          return Promise.resolve({
            toolId,
            status: "failed" as const,
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            durationMs: 0,
            error: "No live harness session."
          });
        }
        // Cumulative file tracking for compaction details (read/write/edit paths).
        trackCompactionFileOp(state.compaction.files, toolId, input);
        return state.runtime.executeTool(session.id, toolId, injectRepoRoot(toolId, input, session));
      },
      approveTool: async (toolId, input) => {
        if (READ_ONLY_TOOL_IDS.has(toolId) || MANDATE_READ_ONLY_TOOLS.has(toolId)) {
          return true;
        }
        const decision = evaluateToolMandate(toolId, input, {
          cwd: session?.repo?.repoRoot ?? process.cwd(),
          state: state.mandate,
          yolo: state.yolo
        });
        // Per-call approval (v0.22): a standing mandate/YOLO allows silently; an
        // escalation PROMPTS the operator (y/N/always), and a hard edge prompts
        // every time regardless of a session grant.
        return resolveApproval(toolId, decision, {
          sessionApprovals: state.sessionApprovals,
          prompt: (request) => promptApproval(request, stopSpinner)
        });
      },
      onToolPending: (toolId) => {
        // Commit-plane dead time: pre-explore this step's forks with read-only scouts.
        if (state.lookahead.enabled) {
          state.lookahead.scoutPendingStep(toolId, { inDeadTime: true });
        }
      },
      onToolEvent: (event) => {
        if (event.status === "succeeded") {
          state.toolsUsed.add(event.toolId);
        }
        if (state.lookahead.enabled && state.lookahead.openBranches().length > 0) {
          const match = state.lookahead.matchBranch({ toolId: event.toolId, status: event.status === "succeeded" ? "succeeded" : "failed", ...(event.detail ? { detail: event.detail } : {}) });
          if (match.outcome === "hit" && match.warmHint) {
            // Promote the scout's pre-reasoned plan as a warm hint — never executed;
            // the next mutation still passes approval.
            state.history.push({ role: "system", content: `[look-ahead] ${match.warmHint}` });
            logMessage(state, "system", `[look-ahead] ${match.warmHint}`);
            stopSpinner();
            print(paint.fg("accent2", `  ${GLYPHS.agent} look-ahead: a scout already reasoned past this fork`));
          }
        }
        stopSpinner();
        if (directStreamed) {
          process.stdout.write("\n");
          directStreamed = false;
        }
        renderToolEvent(event);
      },
      onToken: (chunk) => {
        stopSpinner();
        if (!directStreamed) {
          // Agent message prefix per §5: ▲ accent2.
          process.stdout.write(`\n${paint.fg("accent2", GLYPHS.agent)} `);
          directStreamed = true;
        }
        process.stdout.write(chunk);
      },
      onAssistant: (content, res) => {
        // The assistant message is already pushed by the engine; log + tally + persist.
        logMessage(state, "assistant", content);
        state.usage.turns += 1;
        if (state.lineage) {
          state.turnsThisBranch += 1;
        }
        state.usage.inputTokens += res.usage?.inputTokens ?? 0;
        state.usage.outputTokens += res.usage?.outputTokens ?? 0;
        // The LAST request's prompt size is the true context footprint; inputTokens
        // is the cumulative sum across tool-loop iterations (adversarial review fix).
        state.usage.lastInputTokens = res.usage?.lastRequestInputTokens ?? res.usage?.inputTokens ?? state.usage.lastInputTokens;
        persistMeta(state);
      },
      onRetry: (info) => {
        stopSpinner();
        printRetryIndicator(info);
      },
      retry: state.retryConfig,
      ...(state.modelIdOverride ? { modelIdOverride: state.modelIdOverride } : {})
    });
    if (directStreamed) {
      process.stdout.write("\n");
    } else {
      print("");
      print(
        result.text.trim().length > 0
          ? `${paint.fg("accent2", GLYPHS.agent)} ${result.text.trim()}`
          : paint.fg("muted", "(empty response)")
      );
    }
    print("");
    const toolNote = result.toolCallCount > 0 ? ` · ${result.toolCallCount} tool call(s)` : "";
    print(paint.fg("fgFaint", `${result.routeId} · ${Date.now() - startedAt}ms · ${result.usage?.inputTokens ?? "?"} in / ${result.usage?.outputTokens ?? "?"} out${toolNote}`));
  } catch (error) {
    state.history.pop();
    if (error instanceof DirectChatError) {
      print(colorize(theme, "red", `Turn failed: ${error.message}`));
    } else {
      print(colorize(theme, "red", `Turn failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  } finally {
    stopSpinner();
    state.busy = false;
  }
}

async function handleLine(state: GuruState, line: string, rl: { close(): void }): Promise<void> {
  const slash = parseSlashCommand(line);
  if (!slash) {
    if (line.trim().length > 0) {
      await chatTurn(state, line.trim());
    }
    return;
  }

  if (slash.command === "/") {
    cmdMenu();
    return;
  }

  switch (slash.command) {
    case "/help":
    case "/menu":
      cmdHelp();
      break;
    case "/status":
      await cmdStatus(state);
      break;
    case "/model":
    case "/models":
      if (slash.args.length === 0) {
        cmdModelList(state);
      } else {
        cmdModelConnect(state, slash.args[0] ?? "", slash.args[1]);
      }
      break;
    case "/sessions":
      cmdSessions(state);
      break;
    case "/resume":
      if (slash.args.length === 0) {
        cmdSessions(state);
        print(dim(theme, "Usage: /resume <id|#>"));
      } else {
        await cmdResume(state, slash.args[0] ?? "");
      }
      break;
    case "/new":
      await cmdNew(state);
      break;
    case "/tree":
      cmdTree(state, slash.args);
      break;
    case "/fork":
      await cmdFork(state, slash.args);
      break;
    case "/clone":
      await cmdClone(state);
      break;
    case "/skills":
      cmdSkills(state, slash.args);
      break;
    case "/remember":
      cmdRemember(state, slash.args);
      break;
    case "/memory":
      cmdMemory(slash.args);
      break;
    case "/recall":
      cmdRecall(slash.args);
      break;
    case "/mandate":
      cmdMandate(state, slash.args);
      break;
    case "/yolo":
      cmdYolo(state, slash.args);
      break;
    case "/role":
      cmdRole(state, slash.args);
      break;
    case "/lookahead":
      cmdLookahead(state, slash.args);
      break;
    case "/compact":
      if (!state.compaction.config.enabled) {
        // With compaction disabled the send window is slice(-13) — a manual rewrite
        // of the durable transcript would never even reach the model. Refuse.
        print(colorize(theme, "yellow", "Compaction is disabled in guruharness.config.json (compaction.enabled=false) — enable it to use /compact."));
        break;
      }
      await runGuruCompaction(state, "manual", slash.args.join(" "));
      break;
    case "/settings":
      cmdSettings();
      break;
    case "/login":
      await cmdLogin(state, slash.args);
      break;
    case "/accounts":
      cmdAccounts(state);
      break;
    case "/keys":
      cmdKeys(state, slash.args);
      break;
    case "/logout":
      cmdLogout(state, slash.args[0] ?? "");
      break;
    case "/tools":
      cmdTools(state);
      break;
    case "/clear":
      process.stdout.write("\x1b[2J\x1b[H");
      process.stdout.write(banner());
      break;
    case "/exit":
    case "/quit":
      // The daily ritual: fold an experiment branch, then an active suit parks itself.
      await maybeSummarizeBranch(state);
      if (state.activeRole) {
        cmdRolePark(state);
      }
      rl.close();
      return;
    default: {
      // Prompt templates (ADR 2026-07-05-composer-completion): "/name arg…"
      // expands the template body and runs it as a chat turn.
      const templateName = slash.command.slice(1);
      const template = state.promptTemplates.find((candidate) => candidate.name === templateName);
      if (template) {
        const expanded = expandTemplate(template, slash.args, {
          context: bootMemoryBlock,
          ...(state.activeRole ? { suit: state.activeRole.label } : {}),
          ...(state.session?.repo ? { tree: repoTreePreview(state.session.repo.repoRoot) } : {})
        });
        if (expanded.missing.length > 0) {
          const hint = template.args.map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`)).join(" ");
          print(colorize(theme, "yellow", `/${template.name} needs: ${expanded.missing.join(", ")} — usage: /${template.name} ${hint}`));
          return;
        }
        await chatTurn(state, expanded.text);
        return;
      }
      // Enter runs the top guess: "/mo" → /model, "/res 1" → /resume 1.
      const guess = filterSlashCommands(slash.command)[0];
      if (guess && guess.name !== slash.command) {
        print(dim(theme, `→ ${guess.name}`));
        await handleLine(state, [guess.name, ...slash.args].join(" "), rl);
        return;
      }
      print(colorize(theme, "red", `Unknown command: ${slash.command} — /help lists commands.`));
    }
  }
}

export async function runGuru(): Promise<void> {
  // Compact mark for --version/-v (§4), no session launch.
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    const info = getRuntimeInfo();
    print(`${compactMark(paint)} ${paint.fg("fg", info.version)} ${paint.fg("fgFaint", `· build ${resolveBuildStamp()} · node ${process.versions.node}`)}`);
    return;
  }
  // Credential vault CLI (operator directive): `guru keys set|list|rm` — a secure,
  // no-session path to add a key to the encrypted vault (hidden value prompt).
  const keysIndex = process.argv.indexOf("keys");
  if (keysIndex === 2) {
    await runKeysCli(process.argv.slice(keysIndex + 1));
    return;
  }
  // Headless RPC surface (§14): guru --mode rpc → JSONL over stdio on the unified
  // AgentSession engine (no banner, no TUI). The same driveTurn the REPL drives.
  const modeIndex = process.argv.indexOf("--mode");
  if (modeIndex >= 0 && process.argv[modeIndex + 1] === "rpc") {
    await runRpcMode();
    return;
  }
  process.stdout.write(banner());

  // Boot recall (push, not pull): load the memory index BEFORE the first system
  // prompt is built so the session starts already knowing what it knows.
  refreshBootMemoryBlock();

  const runtime = createHarnessRuntime();
  const routes = createDirectProviderCatalog();
  // Credential vault (operator directive 2026-07-06): an encrypted, machine-local
  // env-var ALTERNATIVE. Load it, register the lookup so resolveRouteCredential can
  // resolve a key by name WITHOUT it ever touching process.env, register its values
  // with the scrubber, and count its names as present in readiness — so vault-backed
  // providers light up on launch exactly like env-backed ones.
  const vault = safeOpenVault();
  registerCredentialVault((name) => vault.get(name));
  // guru's OWN vaulted OAuth tokens (native ChatGPT/Codex sign-in): the resolver +
  // wire header both read this — never ~/.codex or any other tool's cache.
  registerOAuthTokenAccessor((providerId) => {
    // Vault first (guru's own sign-in). SHORTCUT: if the vault is empty but the provider's
    // CLI already logged in, reuse its cache token (~/.grok, ~/.codex) — never a requirement.
    const token =
      readVaultOAuthToken(vault, providerId) ??
      (providerId === "grok" ? readGrokCacheToken() : providerId === "openai-codex" ? readCodexCacheToken() : null);
    if (!token?.accessToken) {
      return null;
    }
    registerSecretValue(token.accessToken);
    if (token.refreshToken) {
      registerSecretValue(token.refreshToken);
    }
    return { accessToken: token.accessToken, ...(token.accountId ? { accountId: token.accountId } : {}) };
  });
  for (const name of vault.names()) {
    const value = vault.get(name);
    if (value) {
      registerSecretValue(value);
    }
  }
  const availability = scanProviderReadiness(routes, {
    vaultNames: new Set(vault.names()),
    oauthPresent: (providerId) => oauthProviderPresent(vault, providerId)
  });
  const mandateStore = createMandateStore();
  const harnessConfig = loadHarnessConfig({}).config;
  const swarmManager = getSharedSwarmManager(harnessConfig.swarm);
  const lookahead = createLookAheadEngine({
    config: harnessConfig.lookahead,
    // Scouts are READ-ONLY swarm workers (contract): a scout physically cannot mutate.
    spawnScout: (fork) => ({ taskId: swarmManager.spawn(fork.prompt, "read-only", `scout:${fork.triggerCondition.slice(0, 24)}`).id }),
    enumerateForks: createForkEnumerator(guruMemoryStore),
    onBranchResolved: (event) => {
      if (event.outcome === "hit" && state.activeRole) {
        // Garage learning: record which fork actually occurred, per suit.
        try {
          recordPathOutcome(guruMemoryStore, state.activeRole.slug, {
            routeId: state.connectedRoute?.routeId ?? "none",
            turns: state.usage.turns,
            toolsUsed: [`lookahead-hit:${event.pendingToolId}`]
          });
        } catch {
          // learning is best-effort; never break the turn
        }
      }
    }
  });
  const state: GuruState = {
    runtime,
    session: null,
    sessionTools: [],
    routes,
    availability,
    connectedRoute: null,
    modelIdOverride: null,
    history: [{ role: "system", content: systemPrompt() }],
    usage: { inputTokens: 0, outputTokens: 0, turns: 0, lastInputTokens: 0 },
    sessionApprovals: new Set<MandateVerb>(),
    mandateStore,
    mandate: mandateStore.load(),
    yolo: false,
    activeRole: null,
    toolsUsed: new Set<string>(),
    lookahead,
    busy: false,
    vault,
    store: createSessionLogStore(),
    conversationId: randomUUID(),
    createdAt: new Date().toISOString(),
    lineage: null,
    turnsThisBranch: 0,
    lastMetaSig: "",
    lastCompactionCount: 0,
    compaction: {
      config: harnessConfig.compaction,
      files: { readFiles: new Set<string>(), modifiedFiles: new Set<string>() },
      last: null,
      running: false,
      sendLegacyWindowThisTurn: false,
      noopEstimate: null
    },
    retryConfig: harnessConfig.retry,
    promptTemplates: safeDiscoverTemplates(),
    // Boot Ritual wave: advance the persisted session counter once per wake — the
    // flywheel's real decay clock.
    sessionNumber: incrementSessionCounter(),
    // Engine Extraction v0.18b: created lazily on the first direct turn (needs a route).
    agentSession: null
  };

  try {
    state.session = await runtime.startSession({});
    state.sessionTools = runtime.getSessionTools(state.session.id);
    // Bind the space scope (§7): the session repo's .guru/memory travels with it.
    scopedMemory.setRepoRoot(state.session.repo?.repoRoot ?? null);
    refreshBootMemoryBlock();
    print(dim(theme, `session ${state.session.id.slice(0, 8)} ready · ${state.session.tools.length} tools (agentic) · ${routes.length} routes in catalog`));

    // Bridge loading (§14/§16): every discovered bridge skill is an ATTACH, so it
    // must ride a tracked parity gap — never a silent DEPEND (§S4). Record one gap
    // per bridge skill at boot (upsert; promotion or a native tool closes it).
    const catalog = state.session.skills.catalog;
    const bridges = bridgeManifests(catalog);
    if (bridges.length > 0) {
      const existing = loadGapRecords(guruMemoryStore);
      const merged = upsertGapRecords(existing, bridgeGapRecords(catalog, new Date().toISOString()));
      if (merged.length !== existing.length) {
        saveGapRecords(guruMemoryStore, merged);
      }
      print(dim(theme, `${bridges.length} bridge skill(s) loaded (ATTACH — tracked as parity gap(s); /skills promote <id> to graduate)`));
    }

    // Never-stuck resolver (Phase G): bind session context — registered tools +
    // the garage's verified capabilities. Presence-only, read-only probes.
    setResolverContext({
      registeredToolIds: new Set(state.sessionTools.map((tool) => tool.id)),
      toolSummaries: new Map(state.sessionTools.map((tool) => [tool.id, `${tool.title} ${tool.description}`.slice(0, 200)])),
      garageCapabilities: listRoles(guruMemoryStore).flatMap((role) => role.verifiedTools.map((toolId) => `${role.slug}: ${toolId}`))
    });

    // Swarm v1: bind the worker runner (contract: 2026-07-04 swarm ADR). The
    // closure reads LIVE state at execution time — route, tools, and approval
    // policy are current per call; a worker can never exceed the parent's
    // mandate, and read-only scouts physically cannot mutate. Workers don't get
    // the spawn trio in v1 (recursion deferred; the session task cap backstops).
    // Sibling isolation (§9): capture the mandate + session approvals at SPAWN time,
    // so a later /mandate or approval change never reaches an already-spawned worker.
    getSharedSwarmManager().setSnapshotProvider(() => ({ mandate: state.mandate, approvals: [...state.sessionApprovals] }));
    getSharedSwarmManager().setRunner(async (request) => {
      const route = state.connectedRoute;
      const session = state.session;
      if (!route || !session) {
        throw new Error("No connected model route for swarm workers.");
      }
      // Prefer the spawn-time snapshot over live state (sibling isolation).
      const snapshot = request.mandateSnapshot as { mandate: MandateState; approvals: readonly MandateVerb[] } | undefined;
      const workerMandate = snapshot?.mandate ?? state.mandate;
      const workerApprovals = new Set<MandateVerb>(snapshot ? snapshot.approvals : state.sessionApprovals);
      const swarmToolIds = new Set(["spawn_agent", "get_task_output", "kill_task"]);
      const offered = state.sessionTools.filter((tool) => {
        if (swarmToolIds.has(tool.id)) {
          return false;
        }
        return request.mode === "read-only" ? READ_ONLY_TOOL_IDS.has(tool.id) : activeChatToolIds(state).has(tool.id);
      });
      const result = await directAgentTurn(
        route,
        [
          { role: "system", content: `You are a bounded ${request.mode} worker agent spawned by GuruHarness. Do the job, report findings as plain text. You have ${request.toolCallBudget} tool calls.` },
          { role: "user", content: request.prompt }
        ],
        {
          tools: offered,
          executeTool: (toolId, input) => state.runtime.executeTool(session.id, toolId, injectRepoRoot(toolId, input, session)),
          approveTool: (toolId, input) => {
            if (READ_ONLY_TOOL_IDS.has(toolId) || MANDATE_READ_ONLY_TOOLS.has(toolId)) {
              return true;
            }
            if (request.mode === "read-only") {
              return false; // scouts cannot mutate, by construction
            }
            const decision = evaluateToolMandate(toolId, input, {
              cwd: session.repo?.repoRoot ?? process.cwd(),
              // The SNAPSHOTTED mandate (frozen at spawn), not live state.
              state: workerMandate,
              // YOLO NEVER cascades to workers (§9): a worker evaluates the mandate
              // WITHOUT the parent's YOLO — hard edges + denies bind for workers.
              yolo: false
            });
            // Workers never PROMPT (they can't block on a keypress). An escalation is
            // allowed only if the operator had session-approved the verbs AT SPAWN, and
            // never for a hard edge — otherwise it is denied.
            if (decision.outcome === "allow") return true;
            if (decision.outcome === "deny") return false;
            const workerHardEdge = decision.verbs.some((verb) => HARD_EDGE_VERBS.has(verb));
            return !workerHardEdge && decision.verbs.length > 0 && decision.verbs.every((verb) => workerApprovals.has(verb));
          },
          maxToolCalls: request.toolCallBudget,
          maxTokens: request.tokenBudget,
          timeoutMs: request.timeoutMs,
          retry: state.retryConfig,
          ...(state.modelIdOverride ? { modelIdOverride: state.modelIdOverride } : {})
        }
      );
      return { text: result.text, toolCallCount: result.toolCallCount, budgetExceeded: result.toolCallCount >= request.toolCallBudget };
    });
  } catch (error) {
    print(colorize(theme, "yellow", `Session start degraded: ${error instanceof Error ? error.message : String(error)}`));
  }

  // Auto-connect (2026-07 — DIRECT-READY FIRST): the highest-ranked chat-capable route
  // guru can call DIRECTLY — one with a baseUrl AND a credential the resolver resolves
  // (an API key OR a plan/OAuth token in the encrypted vault). This covers API-key lanes
  // AND native plan lanes (ChatGPT/Grok/Z.AI) identically. A CLI-delegate lane is the LAST
  // resort — only when nothing direct is usable — never the default (its sandbox can't
  // even spawn a probe on Windows).
  const plan = planRoute({}, routes);
  const directReady = sortedRoutes(routes).filter(
    (route) => route.baseUrl !== undefined && isChatCapableFamily(route.apiFamily) && resolveRouteCredential(route).usable
  );
  const auto = directReady[0] ?? (plan.verdict === "selected" && plan.choice && isChatCapableFamily(plan.choice.apiFamily) && resolveRouteCredential(plan.choice).usable
    ? plan.choice
    : undefined);
  if (auto) {
    state.connectedRoute = auto;
    print(colorize(theme, "green", `auto-connected: ${auto.routeId} (direct-first)`) + dim(theme, " — /model to change"));
  } else {
    print(colorize(theme, "yellow", "no auto-connectable model (no usable credential found by env NAME) — /model to browse, /login for hints"));
  }
  // Seed the append-only session log (ADR 2026-07-05-session-tree): meta + the
  // opening system message. Placed after auto-connect so the first meta captures
  // the connected route.
  seedLog(state);
  // Cross-harness import (§16): `--continue pi|claude` maps the most recent
  // session from another harness's JSONL into a fresh guru session (read-only —
  // nothing is re-executed) and points live state at it, mirroring /resume.
  const continueIndex = process.argv.indexOf("--continue");
  if (continueIndex >= 0) {
    const contHarness = (process.argv[continueIndex + 1] ?? "").toLowerCase();
    if (contHarness === "pi" || contHarness === "claude") {
      const cwd = state.session?.repo?.repoRoot ?? process.cwd();
      const result = importExternalSession(contHarness as ForeignHarness, state.store, { cwd, systemPrompt: systemPrompt() });
      if (result.ok) {
        switchToSession(state, result.session, null);
        print(colorize(theme, "green", `imported ${result.summary.imported} message(s) from ${result.summary.sourceLabel}`) + dim(theme, ` — ${result.summary.sourcePath}`));
        if (result.summary.redactedMessages > 0) {
          print(dim(theme, `  ${result.summary.redactedMessages} message(s) redacted for secret-shaped values (${result.summary.redactionKinds.join(", ")}) — presence-over-value`));
        }
        print(dim(theme, "  read-only import — nothing from the other harness was re-executed. Just continue, or /resume to browse."));
      } else {
        print(colorize(theme, "yellow", `--continue ${contHarness}: ${result.reason}`));
      }
    } else {
      print(colorize(theme, "yellow", "--continue expects 'pi' or 'claude' (import the latest session from that harness)."));
    }
  }
  const roleArgIndex = process.argv.indexOf("--role");
  const roleArg = roleArgIndex >= 0 ? process.argv.slice(roleArgIndex + 1).filter((token) => !token.startsWith("--")).join(" ") : "";
  await printLaunchBriefing(state, harnessConfig.baselineHealth);
  if (roleArg.length > 0) {
    cmdRoleSuit(state, roleArg);
  } else if (listRoles(guruMemoryStore).length > 0 || guruMemoryStore.list().length === 0) {
    print(dim(theme, "what are we working on today?  /role suit <thing> — or just start chatting naked"));
  }
  print("");

  const stdinIsTty = process.stdin.isTTY === true;

  const commandItems = (buffer: string): MenuItem[] => {
    const needle = buffer.trim().toLowerCase();
    const commands = filterSlashCommands(buffer).map((command) => ({
      id: command.name,
      label: command.name,
      hint: command.description,
      drillable: command.name === "/model" || command.name === "/models" || command.name === "/resume" || command.name === "/sessions"
    }));
    // Prompt templates ride the / menu alongside built-in commands.
    const templates = state.promptTemplates
      .filter((template) => needle === "/" || `/${template.name}`.startsWith(needle))
      .map((template) => ({ id: `/${template.name}`, label: `/${template.name}`, hint: template.description || "prompt template" }));
    return [...commands, ...templates];
  };
  const drillItems = (parentId: string): MenuItem[] => {
    if (parentId === "/model" || parentId === "/models") {
      return sortedRoutes(state.routes).map((route, index) => {
        const availability = state.availability.find((row) => row.routeId === route.routeId);
        const status = availability?.status ?? route.status;
        return { id: `/model ${index + 1}`, label: route.routeId, hint: status };
      });
    }
    if (parentId === "/resume" || parentId === "/sessions") {
      return state.store.list().slice(0, 12).map((item, index) => ({
        id: `/resume ${index + 1}`,
        label: item.title.length > 34 ? `${item.title.slice(0, 33)}…` : item.title,
        hint: `${item.routeId ?? "no route"} · ${item.turnCount} turn(s)`
      }));
    }
    return [];
  };
  const composerModeLabel = (): string => {
    const chips: string[] = [];
    if (state.yolo) chips.push("YOLO");
    if (state.lookahead.enabled) chips.push("scout");
    if (state.activeRole) chips.push(state.activeRole.label);
    return chips.length > 0 ? `▸ ${chips.join(" · ")}` : "";
  };
  if (stdinIsTty) {
    // --- TTY: the composer OWNS the input (ADR 2026-07-05-composer-editor):
    // multi-line editor (Ctrl+J newline), slash menu, @ file picker, Tab paths,
    // pinned chrome — readline's line management is fully replaced here.
    const composer = attachComposer({
      input: process.stdin,
      output: process.stdout,
      interactive: true,
      isBusy: () => state.busy,
      commandItems,
      drillItems,
      chromeRows: () => [buildStatusBar(state, process.stdout.columns ?? 80), composerHintLine(paint, ["ctrl+j newline", "@ files", "tab paths"])]
    });
    let sigints = 0;
    composer.onInterrupt(() => {
      sigints += 1;
      if (sigints >= 2) {
        composer.close();
        return;
      }
      // Clear the live frame FIRST so the hint doesn't land mid-block and
      // leave a stale stacked copy (adversarial finding).
      composer.abortPrompt();
      print(dim(theme, "(ctrl+c again to exit)"));
      composer.beginPrompt();
    });

    // Resize reflow: repaint the whole composer block at the new width. Named
    // + removed in the finally below — an orphaned listener would keep the
    // closed composer closure alive (CodeRabbit round 2).
    const onResize = (): void => {
      if (!state.busy) {
        composer.refresh();
      }
    };
    process.stdout.on("resize", onResize);

    const promptComposer = (): void => {
      print(composerTopRule(paint, process.stdout.columns ?? 80, composerModeLabel()));
      composer.beginPrompt();
    };

    try {
      promptComposer();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const line = await composer.readLine();
        if (line === null) {
          break;
        }
        sigints = 0;
        // Enter with the menu open runs the highlighted item (what the user SEES
        // wins over the partial they typed — "/mo" + ↓↓ + ⏎ runs the selected row).
        const selected = composer.takePendingSelection();
        const effective = selected !== null && line.trim().startsWith("/") && !line.trim().includes(" ") ? selected : line;
        composer.clear(); // erase the pinned chrome before the turn's output flows
        await handleLine(state, effective, composer);
        if (composer.isClosed()) {
          break; // /exit closed the composer mid-turn — no stray top rule after
        }
        promptComposer();
      }
    } finally {
      process.stdout.removeListener("resize", onResize);
      composer.close();
    }
  } else {
    // --- non-TTY (pipes, CI, the runtime): the legacy readline path, unchanged.
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: paint.bold(paint.fg("accent", "▸ ")),
      completer: completeSlashCommand,
      terminal: false
    });
    let closed = false;
    rl.on("close", () => {
      closed = true;
    });
    rl.prompt();
    for await (const line of rl) {
      await handleLine(state, line, rl);
      print(statusLine(state)); // non-interactive: chrome isn't pinned, print inline
      if (closed) {
        break;
      }
      rl.prompt();
    }
  }

  print(dim(theme, "bye."));
}

const isDirectRun = process.argv[1]?.replace(/\\/gu, "/").endsWith("/guru.js") || process.argv[1]?.replace(/\\/gu, "/").endsWith("/guru.ts");
if (isDirectRun) {
  runGuru().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
