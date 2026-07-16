import { directAgentTurn, type AgentToolEvent, type AgentTurnResult } from "../model/agentTurn.js";
import type { ChatTurnMessage } from "../model/directChat.js";
import { runCompaction, type SummarizeRequest, type Summarizer } from "../compaction/engine.js";
import type { CompactionConfig, CompactionState } from "../compaction/schemas.js";
import {
  effectiveKeepRecentTokens,
  estimateChatHistoryTokens,
  historyToCompactionEntries,
  rebuildHistoryAfterCompaction
} from "../compaction/sessionHistory.js";
import type { ProviderRouteDescriptor } from "../providers/schemas.js";
import type { HarnessRuntime } from "../runtime/session.js";
import type { HarnessSession } from "../runtime/schemas.js";
import type { ToolDefinition, ToolObservation } from "../tools/registry.js";
import type { RetryConfig, RetryHooks } from "../model/retryPolicy.js";
import { evaluateToolMandate } from "../mandates/evaluate.js";
import { applyPreservationGuard } from "../mandates/preservation.js";
import { HARD_EDGE_VERBS, type MandateState } from "../mandates/schema.js";
import { expandReferences } from "../tui/references.js";
import type { FileMemoryStore } from "../memory/store.js";
import { loadManifest, parkManifest } from "../garage/store.js";
import { computeLayerHash, manifestToRoleProfile, reverifyForLoad, roleProfileToManifest, type GarageLayer } from "../garage/manifest.js";
import { slugifyRole, type RoleProfile } from "../roles/schema.js";

/**
 * AgentSession — the first-class, in-process harness engine (Engine Extraction
 * wave, ADR 2026-07-05-agent-session-engine, THERE v2 §14 + scenario 13). One
 * importable object drives a full agentic turn on the shared primitives
 * (directAgentTurn, the HarnessRuntime, the garage/mandate stores) with typed
 * events, a steering queue, and suit-up/park — no subprocess, no dependency on
 * the REPL. `runTurn` is injectable so the engine is deterministically testable
 * without a network.
 *
 * SCOPE (ADR): this ships the engine + its interface. The interactive TUI still
 * runs its own turn path this wave; migrating the TUI to drive AgentSession
 * (true single-engine) is v0.18b, as is layering compaction / look-ahead / the
 * CLI-delegate path and true mid-run steering injection.
 */

const DEFAULT_CONTEXT_WINDOW = 128_000;
const COMPACTION_SUMMARIZER_SYSTEM_PROMPT =
  "You summarize an agent-session transcript so the conversation can continue with less context. Produce a dense, factual summary: the operator's goals, decisions made, work completed (files, commands, outcomes), open threads, and any constraints stated. Never invent details. Never include credential values.";
const REPO_ROOT_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "glob", "ls", "repo.context.resolve"]);
const WRITE_TOOLS = new Set(["bash", "edit", "write"]);

export type TurnRunner = typeof directAgentTurn;

type AgentSessionCompactionEndEvent =
  | {
      readonly compacted: true;
      readonly summaryCount: number;
      readonly beforeTokens: number;
      readonly afterTokens: number;
    }
  | {
      readonly compacted: false;
      readonly reason: "nothing-to-compact" | "failed";
    };

export interface AgentSessionEvents {
  "turn.start": { readonly text: string };
  token: { readonly chunk: string };
  "tool.observation": AgentToolEvent;
  "steer.injected": { readonly text: string; readonly kind: "steer" | "follow_up" };
  "turn.stop": { readonly text: string; readonly toolCallCount: number; readonly durationMs: number };
  "done.packet": { readonly turns: number };
  "compaction.start": {
    readonly reason: "manual";
    readonly beforeTokens: number;
    readonly historyLength: number;
  };
  "compaction.end": AgentSessionCompactionEndEvent;
  /** A running turn was aborted by the operator (§17 S13). */
  aborted: { readonly atTurn: number };
}
export type AgentSessionEvent = keyof AgentSessionEvents;
type Listener<E extends AgentSessionEvent> = (payload: AgentSessionEvents[E]) => void;

export interface AgentSessionStats {
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly lastInputTokens: number;
  readonly contextWindowTokens: number;
  readonly historyLength: number;
}

export type AgentSessionCompactionNoChangeReason = "disabled" | "nothing-to-compact" | "busy";

export type AgentSessionCompactionResult =
  | {
      readonly compacted: true;
      readonly summaryCount: number;
      readonly beforeTokens: number;
      readonly afterTokens: number;
    }
  | {
      readonly compacted: false;
      readonly reason: AgentSessionCompactionNoChangeReason;
    };

export interface AgentSessionDeps {
  readonly runtime: HarnessRuntime;
  readonly route: ProviderRouteDescriptor;
  /** The live harness session (repo + tools). Optional: a TUI driver overrides tool dispatch. */
  readonly session?: HarnessSession;
  readonly sessionTools: readonly ToolDefinition[];
  readonly mandate: MandateState;
  readonly yolo?: boolean;
  /** Mutating tools allowed for model turns when the mandate falls through to escalate. */
  readonly writesAllowed?: boolean;
  readonly modelIdOverride?: string | null;
  readonly retry?: RetryConfig;
  readonly systemPrompt?: string;
  /** Manual compaction policy. Omitted or disabled preserves legacy no-compaction behavior. */
  readonly compaction?: CompactionConfig;
  /** Injectable summary lane for deterministic callers/tests. Defaults to a tool-free model turn. */
  readonly summarize?: Summarizer;
  /** Tool ids offered to the model (default: all registered session tools). */
  readonly offeredToolIds?: ReadonlySet<string>;
  /** Garage/flywheel store (suitUp/park no-op without it). */
  readonly memory?: FileMemoryStore;
  /** Injectable turn runner — defaults to directAgentTurn; tests pass a stub. */
  readonly runTurn?: TurnRunner;
  readonly now?: () => Date;
  /** Operator question handler — called by operator.answer RPC to resolve agent questions. */
  readonly answerHandler?: (questionId: string) => Promise<string> | string;
}

interface QueuedSteer {
  readonly text: string;
  readonly kind: "steer" | "follow_up";
}

/**
 * A turn driver — the seam the interactive TUI uses to ride the SAME turn
 * lifecycle as the SDK `prompt()` while injecting its exact behaviors
 * (message-windowing, executeTool/approveTool, render hooks, compaction, persist).
 * Every field is optional; the defaults reproduce `prompt()` (this.history +
 * emitted events), so the shipped v0.18.0 contract is unchanged. `getHistory`
 * lets the driver own the history array (the TUI's `state.history`), so a
 * mid-turn compaction reassignment never desyncs — the assistant push and the
 * sent window both read the LIVE array.
 */
export interface TurnDriver {
  /** The live history array to read + push the assistant into (the TUI's state.history). */
  readonly getHistory?: () => ChatTurnMessage[];
  readonly route?: ProviderRouteDescriptor;
  readonly session?: HarnessSession;
  readonly tools?: readonly ToolDefinition[];
  readonly executeTool?: (toolId: string, input: unknown, signal?: AbortSignal) => Promise<ToolObservation>;
  readonly approveTool?: (toolId: string, input: unknown) => boolean | Promise<boolean>;
  /** Transform the history into the messages actually sent (compaction windowing). */
  readonly prepareMessages?: (history: readonly ChatTurnMessage[]) => readonly ChatTurnMessage[];
  readonly onToken?: (chunk: string) => void;
  readonly onToolEvent?: (event: AgentToolEvent) => void;
  readonly onToolPending?: (toolId: string, input: unknown) => void;
  readonly onRetry?: RetryHooks["onRetry"];
  /** Runs after the assistant message is pushed (log / usage / persist). */
  readonly onAssistant?: (content: string, result: AgentTurnResult) => void;
  readonly retry?: RetryConfig;
  readonly modelIdOverride?: string | null;
}

export class AgentSession {
  readonly history: ChatTurnMessage[] = [];
  private readonly deps: AgentSessionDeps;
  private readonly runTurn: TurnRunner;
  private readonly listeners = new Map<AgentSessionEvent, Set<Listener<AgentSessionEvent>>>();
  private readonly steerQueue: QueuedSteer[] = [];
  private readonly toolsUsed = new Set<string>();
  private activeSuit: RoleProfile | null = null;
  private usage = { turns: 0, inputTokens: 0, outputTokens: 0, lastInputTokens: 0 };
  /** The in-flight turn's abort controller (§17 S13); null when no turn is running. */
  private currentAbort: AbortController | null = null;
  /** Pending operator questions — resolved by operator.answer or rejected on close. */
  private pendingQuestions = new Map<string, { resolve: (answer: string) => void; reject: (error: Error) => void }>();
  private compactionRunning = false;
  private lastCompaction: CompactionState | null = null;

  constructor(deps: AgentSessionDeps) {
    this.deps = deps;
    this.runTurn = deps.runTurn ?? directAgentTurn;
    if (deps.systemPrompt && deps.systemPrompt.length > 0) {
      this.history.push({ role: "system", content: deps.systemPrompt });
    }
  }

  // -- events --------------------------------------------------------------
  subscribe<E extends AgentSessionEvent>(event: E, listener: Listener<E>): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener<AgentSessionEvent>>();
    set.add(listener as Listener<AgentSessionEvent>);
    this.listeners.set(event, set);
    return () => this.off(event, listener);
  }
  off<E extends AgentSessionEvent>(event: E, listener: Listener<E>): void {
    this.listeners.get(event)?.delete(listener as Listener<AgentSessionEvent>);
  }
  private emit<E extends AgentSessionEvent>(event: E, payload: AgentSessionEvents[E]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as Listener<E>)(payload);
    }
  }

  // -- steering (the shared substrate for the composer tail + RPC 'steer') --
  /** Tug the wheel: applied at the next turn's injection point. */
  steer(text: string): void {
    if (text.trim().length > 0) this.steerQueue.push({ text: text.trim(), kind: "steer" });
  }
  /** Queue a follow-up to run when the agent next stops. */
  followUp(text: string): void {
    if (text.trim().length > 0) this.steerQueue.push({ text: text.trim(), kind: "follow_up" });
  }
  /** Pending steer/follow-up items (queue depth is visible, per §5). */
  queueDepth(): number {
    return this.steerQueue.length;
  }
  /** Steer-kind items only (excludes follow-ups) — used to continue a turn after late steers. */
  pendingSteerCount(): number {
    return this.steerQueue.filter((item) => item.kind === "steer").length;
  }
  /**
   * Drop pending steer-kind items (keep follow-ups). Used when a turn is aborted so
   * a cancelled nudge does not attach to the next unrelated user message.
   */
  discardPendingSteers(): readonly string[] {
    const dropped: string[] = [];
    for (let i = 0; i < this.steerQueue.length; ) {
      const item = this.steerQueue[i] as QueuedSteer;
      if (item.kind === "steer") {
        dropped.push(item.text);
        this.steerQueue.splice(i, 1);
      } else {
        i += 1;
      }
    }
    return dropped;
  }
  /**
   * Interrupt the RUNNING turn (§17 S13). Trips the in-flight abort signal so the
   * turn loop stops at its next step boundary and returns the partial so far.
   * Returns true when a turn was actually running, false otherwise (a no-op).
   */
  abort(): boolean {
    if (this.currentAbort && !this.currentAbort.signal.aborted) {
      this.currentAbort.abort();
      this.emit("aborted", { atTurn: this.usage.turns + 1 });
      return true;
    }
    return false;
  }

  /** Pull steer-kind items added DURING a running turn — injected mid-run (§17 S13). */
  private drainMidRunSteers(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.steerQueue.length; ) {
      const item = this.steerQueue[i] as QueuedSteer;
      if (item.kind === "steer") {
        out.push(item.text);
        this.steerQueue.splice(i, 1);
        this.emit("steer.injected", { text: item.text, kind: "steer" });
      } else {
        i += 1;
      }
    }
    return out;
  }

  /** Drain queued follow-ups (the driver runs them as fresh turns when the agent stops). */
  takeFollowUps(): string[] {
    const out: string[] = [];
    for (let i = this.steerQueue.length - 1; i >= 0; i -= 1) {
      const item = this.steerQueue[i] as QueuedSteer;
      if (item.kind === "follow_up") {
        out.unshift(item.text);
        this.steerQueue.splice(i, 1);
      }
    }
    return out;
  }

  // -- the turn ------------------------------------------------------------
  private prepareToolInput(toolId: string, input: unknown): unknown {
    const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
    if (toolId === "repo.context.resolve") {
      return { includeContents: false, ...record };
    }
    const repo = this.deps.session?.repo;
    if (!repo || !REPO_ROOT_TOOLS.has(toolId)) {
      return input;
    }
    const defaults: Record<string, unknown> = WRITE_TOOLS.has(toolId) ? { dryRun: false } : {};
    return { repoRoot: repo.repoRoot, ...defaults, ...record };
  }

  private offeredTools(): readonly ToolDefinition[] {
    if (this.deps.route.capabilities?.supportsTools === false) {
      return [];
    }
    const allowed = this.deps.offeredToolIds;
    return allowed ? this.deps.sessionTools.filter((tool) => allowed.has(tool.id)) : this.deps.sessionTools;
  }

  private defaultApprove(session: HarnessSession | undefined): (toolId: string, input: unknown) => boolean {
    return (toolId, input) => {
      const repoRoot = session?.repo?.repoRoot ?? process.cwd();
      // PRESERVE, DON'T REPLACE holds on the ENGINE path too: a gutting write
      // escalates to destructive-class even past writesAllowed / a standing
      // "write" grant / YOLO, and the hard-edge branch below denies it
      // fail-closed (SDK/RPC callers have no interactive double-check).
      const decision = applyPreservationGuard(
        evaluateToolMandate(toolId, input, {
          cwd: repoRoot,
          state: this.deps.mandate,
          yolo: this.deps.yolo ?? false
        }),
        toolId,
        input,
        repoRoot
      );
      if (decision.outcome === "allow") {
        return true;
      }
      if (decision.outcome === "deny") {
        return false;
      }
      // escalate: a HARD edge (destructive/spend/secret-edge/auth-edge) is NEVER
      // auto-approved by a session grant (Constitution §3, "in every mode incl YOLO").
      // The raw SDK default has no interactive prompt, so hard edges default-DENY here;
      // a caller wanting to approve them must supply an explicit approveTool.
      if (decision.verbs.some((verb) => HARD_EDGE_VERBS.has(verb))) {
        return false;
      }
      return this.deps.writesAllowed ?? false;
    };
  }

  /**
   * Execute one agentic turn on the driver's already-prepared history — the ONE
   * turn EXECUTION both the SDK (`prompt`) and the interactive TUI ride. The
   * caller owns pre-turn work (@-expansion, user push, compaction) and post-turn
   * rendering; this runs the provider request through the shared mandate/tool
   * seam, pushes the assistant message, updates usage, and emits typed events.
   * The default driver (no fields) reproduces the v0.18.0 `prompt()` behavior.
   */
  async driveTurn(driver: TurnDriver = {}): Promise<AgentTurnResult> {
    if (this.compactionRunning) {
      throw new Error("AgentSession: compaction is already running — await it before starting a turn.");
    }
    // Single-driver contract, enforced: overlapping turns would clobber
    // currentAbort (making the older turn un-abortable) and interleave
    // history pushes. Await the running turn or call abort() first.
    if (this.currentAbort) {
      throw new Error("AgentSession: a turn is already running — await it or call abort() first.");
    }
    const route = driver.route ?? this.deps.route;
    const harnessSession = driver.session ?? this.deps.session;
    const readHistory = (): ChatTurnMessage[] => (driver.getHistory ? driver.getHistory() : this.history);

    // Drain steers that queued while idle (or after a turn that never pulled them).
    // In-turn steers on no-tool answers are now continued inside agentTurn; this
    // boundary drain covers steers typed between turns. prompt() drains before
    // calling driveTurn, so the SDK path is unchanged when the queue is already empty.
    for (let i = 0; i < this.steerQueue.length; ) {
      const item = this.steerQueue[i] as QueuedSteer;
      if (item.kind === "steer") {
        this.steerQueue.splice(i, 1);
        readHistory().push({ role: "system", content: `[steering] ${item.text}` });
        this.emit("steer.injected", { text: item.text, kind: "steer" });
      } else {
        i += 1;
      }
    }

    const messages = driver.prepareMessages ? driver.prepareMessages(readHistory()) : readHistory();
    const modelIdOverride = driver.modelIdOverride ?? this.deps.modelIdOverride ?? "";
    const retry = driver.retry ?? this.deps.retry;
    const startedAt = this.deps.now ? this.deps.now().getTime() : 0;
    // Abort + mid-run steer (§17 S13): a fresh controller per turn; steer-kind items
    // added during the turn are pulled at each loop iteration and injected.
    const controller = new AbortController();
    this.currentAbort = controller;
    try {
      const result = await this.runTurn(route, messages, {
        ...(modelIdOverride.length > 0 ? { modelIdOverride } : {}),
        ...(retry ? { retry } : {}),
        ...(driver.onRetry ? { onRetry: driver.onRetry } : {}),
        signal: controller.signal,
        pullSteering: () => this.drainMidRunSteers(),
        tools: driver.tools ?? this.offeredTools(),
        executeTool:
          driver.executeTool ??
          ((toolId, input, signal) =>
            harnessSession
              ? this.deps.runtime.executeTool(harnessSession.id, toolId, this.prepareToolInput(toolId, input), signal)
              : Promise.resolve({ toolId, status: "failed" as const, startedAt: "", endedAt: "", durationMs: 0, error: "No live harness session." })),
        approveTool: driver.approveTool ?? this.defaultApprove(harnessSession),
        ...(driver.onToolPending ? { onToolPending: driver.onToolPending } : {}),
        onToolEvent: (event) => {
          if (event.status === "succeeded") this.toolsUsed.add(event.toolId);
          this.emit("tool.observation", event);
          driver.onToolEvent?.(event);
        },
        onToken: (chunk) => {
          this.emit("token", { chunk });
          driver.onToken?.(chunk);
        }
      });

      // NEVER push an empty assistant message (abort before the first token, or a
      // provider returning an empty reply): strict providers (anthropic-messages)
      // reject empty message content on EVERY subsequent request, so one aborted
      // turn used to poison the whole session into a 400 loop.
      if (result.text.length > 0) {
        readHistory().push({ role: "assistant", content: result.text });
      }
      this.usage.turns += 1;
      this.usage.inputTokens += result.usage?.inputTokens ?? 0;
      this.usage.outputTokens += result.usage?.outputTokens ?? 0;
      this.usage.lastInputTokens = result.usage?.lastRequestInputTokens ?? result.usage?.inputTokens ?? this.usage.lastInputTokens;
      driver.onAssistant?.(result.text, result);
      const durationMs = this.deps.now ? this.deps.now().getTime() - startedAt : 0;
      this.emit("turn.stop", { text: result.text, toolCallCount: result.toolCallCount, durationMs });
      this.emit("done.packet", { turns: this.usage.turns });
      return result;
    } finally {
      if (this.currentAbort === controller) {
        this.currentAbort = null;
      }
    }
  }

  /** SDK turn: the full lifecycle (steer drain → @-expand → push user → execute). */
  async prompt(text: string): Promise<AgentTurnResult> {
    if (this.compactionRunning) {
      throw new Error("AgentSession: compaction is already running — await it before prompting.");
    }
    // Reject BEFORE the steer drain and user push so a concurrent prompt can
    // never leave a dangling user message in history (driveTurn re-checks too).
    if (this.currentAbort) {
      throw new Error("AgentSession: a turn is already running — await it or call abort() first.");
    }
    // Drain ONLY pre-queued steers into this turn. Follow-ups stay queued for
    // takeFollowUps() so the driver runs them as fresh turns when the agent stops.
    for (let i = 0; i < this.steerQueue.length; ) {
      const item = this.steerQueue[i] as QueuedSteer;
      if (item.kind === "steer") {
        this.steerQueue.splice(i, 1);
        this.history.push({ role: "system", content: `[steering] ${item.text}` });
        this.emit("steer.injected", { text: item.text, kind: "steer" });
      } else {
        i += 1;
      }
    }
    let submitted = text;
    const repo = this.deps.session?.repo;
    if (text.includes("@") && repo) {
      const expansion = expandReferences(text, {
        repoRoot: repo.repoRoot,
        baseTokens: Math.ceil(this.history.map((message) => message.content).join("").length / 4),
        contextWindowTokens: this.deps.route.context?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW
      });
      submitted = expansion.text;
    }
    this.history.push({ role: "user", content: submitted });
    this.emit("turn.start", { text: submitted });
    return this.driveTurn();
  }

  /**
   * Run one prompt, then drain queued follow-ups as fresh prompts — the driver
   * contract shared by the REPL and the RPC surface.
   */
  async promptDrainingFollowUps(text: string): Promise<AgentTurnResult> {
    let result = await this.prompt(text);
    while (true) {
      const queued = this.takeFollowUps();
      if (queued.length === 0) {
        break;
      }
      for (const followUpText of queued) {
        result = await this.prompt(followUpText);
      }
    }
    return result;
  }

  private async summarizeCompaction(request: SummarizeRequest): Promise<string> {
    const sections: string[] = [];
    if (request.previousSummary && request.previousSummary.trim().length > 0) {
      sections.push(`Previous summary (extend it — do not repeat verbatim):\n${request.previousSummary}`);
    }
    if (request.customInstructions && request.customInstructions.trim().length > 0) {
      sections.push(`Operator focus instructions: ${request.customInstructions}`);
    }
    sections.push(`Transcript region to fold (${request.label}):\n${request.transcriptBlock}`);
    sections.push("Reply with ONLY the summary text.");

    const modelIdOverride = this.deps.modelIdOverride ?? "";
    const result = await this.runTurn(
      this.deps.route,
      [
        { role: "system", content: COMPACTION_SUMMARIZER_SYSTEM_PROMPT },
        { role: "user", content: sections.join("\n\n") }
      ],
      {
        tools: [],
        executeTool: (toolId) => {
          const timestamp = (this.deps.now ?? (() => new Date()))().toISOString();
          return Promise.resolve({
            toolId,
            status: "failed" as const,
            startedAt: timestamp,
            endedAt: timestamp,
            durationMs: 0,
            error: "The compaction summarizer runs without tools."
          });
        },
        approveTool: () => false,
        maxTokens: request.maxTokens,
        ...(this.deps.retry ? { retry: this.deps.retry } : {}),
        ...(modelIdOverride.length > 0 ? { modelIdOverride } : {})
      }
    );
    return result.text;
  }

  /** Fold older conversation context while preserving this history array's identity. */
  async compact(instructions?: string): Promise<AgentSessionCompactionResult> {
    const config = this.deps.compaction;
    if (!config?.enabled) {
      return { compacted: false, reason: "disabled" };
    }
    if (this.currentAbort || this.compactionRunning) {
      return { compacted: false, reason: "busy" };
    }

    const adapted = historyToCompactionEntries(this.history);
    const beforeTokens = estimateChatHistoryTokens(this.history);
    const contextWindowTokens = this.deps.route.context?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW;
    const previousState = adapted.previousSummary === undefined ? null : this.lastCompaction;
    let terminalEmitted = false;
    const emitEnd = (payload: AgentSessionCompactionEndEvent): void => {
      // Set before dispatch so a throwing subscriber cannot cause a duplicate
      // terminal event through the failure path below.
      terminalEmitted = true;
      this.emit("compaction.end", payload);
    };
    this.compactionRunning = true;
    try {
      this.emit("compaction.start", {
        reason: "manual",
        beforeTokens,
        historyLength: this.history.length
      });
      const result = await runCompaction({
        entries: adapted.entries,
        config: {
          ...config,
          keepRecentTokens: effectiveKeepRecentTokens(config, contextWindowTokens)
        },
        summarize: this.deps.summarize ?? ((request) => this.summarizeCompaction(request)),
        now: this.deps.now ?? (() => new Date()),
        reason: "manual",
        ...(adapted.previousSummary !== undefined ? { previousSummary: adapted.previousSummary } : {}),
        ...(previousState ? { previousDetails: previousState.details, previousCount: previousState.count } : {}),
        ...(instructions !== undefined && instructions.trim().length > 0 ? { customInstructions: instructions } : {})
      });

      if (result === null || "cancelled" in result) {
        emitEnd({ compacted: false, reason: "nothing-to-compact" });
        return { compacted: false, reason: "nothing-to-compact" };
      }

      const rebuilt = rebuildHistoryAfterCompaction(adapted.head, result.summaryEntry, result.keptEntries);
      const afterTokens = estimateChatHistoryTokens(rebuilt);
      this.history.splice(0, this.history.length, ...rebuilt);
      this.lastCompaction = result.state;
      emitEnd({
        compacted: true,
        summaryCount: result.state.count,
        beforeTokens,
        afterTokens
      });
      return {
        compacted: true,
        summaryCount: result.state.count,
        beforeTokens,
        afterTokens
      };
    } catch (error) {
      if (!terminalEmitted) {
        emitEnd({ compacted: false, reason: "failed" });
      }
      throw error;
    } finally {
      this.compactionRunning = false;
    }
  }

  // -- garage --------------------------------------------------------------
  /** Wear a suit headlessly: load its manifest, re-verify-before-load, return the RoleProfile. */
  suitUp(description: string): { suit: RoleProfile | null; created: boolean; skippedRed: readonly string[] } {
    if (!this.deps.memory) return { suit: null, created: false, skippedRed: [] };
    let slug: string;
    try {
      slug = slugifyRole(description);
    } catch {
      return { suit: null, created: false, skippedRed: [] };
    }
    const manifest = loadManifest(this.deps.memory, slug);
    const registered = new Set(this.deps.sessionTools.map((tool) => tool.id));
    if (!manifest) {
      this.activeSuit = {
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
      return { suit: this.activeSuit, created: true, skippedRed: [] };
    }
    const result = reverifyForLoad(manifest, {
      now: this.deps.now ?? (() => new Date()),
      staleAfterDays: 14,
      verifyLayer: (layer: GarageLayer) => (layer.kind === "tool" ? registered.has(layer.id) : true)
    });
    if (!result.fastPath && this.deps.memory) {
      parkManifest(this.deps.memory, result.manifest);
    }
    this.activeSuit = { ...manifestToRoleProfile(result.manifest), wornCount: manifest.wornCount + 1 };
    return { suit: this.activeSuit, created: false, skippedRed: result.skippedRed.map((layer) => `${layer.kind}:${layer.id}`) };
  }

  /** Park the active suit with tools observed used this session (verified-by-use). */
  park(): { stored: number } | null {
    if (!this.deps.memory || !this.activeSuit) return null;
    const base = loadManifest(this.deps.memory, this.activeSuit.slug) ?? roleProfileToManifest(this.activeSuit);
    const stamp = (this.deps.now ?? (() => new Date()))().toISOString();
    const layers: GarageLayer[] = base.layers.map((layer) => ({ ...layer }));
    const floor = new Set(["read", "bash", "edit", "write"]);
    for (const id of this.toolsUsed) {
      if (floor.has(id)) continue;
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
      const index = layers.findIndex((layer) => layer.kind === "tool" && layer.id === id);
      if (index >= 0) layers[index] = verified;
      else layers.push(verified);
    }
    const receipt = parkManifest(this.deps.memory, { ...base, layers, wornCount: this.activeSuit.wornCount, lastWornAt: stamp });
    this.activeSuit = null;
    return { stored: receipt.stored };
  }

  // -- operator questions (§G708) -------------------------------------------
  /** Whether an answer handler is wired (operator.answer can be called). */
  hasAnswerHandler(): boolean {
    return !!this.deps.answerHandler;
  }

  /** Dispatch an answer to a pending agent question via the wired handler. */
  async dispatchAnswer(questionId: string): Promise<string> {
    if (!this.deps.answerHandler) throw new Error("No answer handler wired");
    try {
      const answer = await Promise.resolve(this.deps.answerHandler(questionId));
      const pending = this.pendingQuestions.get(questionId);
      if (pending) {
        pending.resolve(answer);
        this.pendingQuestions.delete(questionId);
      }
      return answer;
    } catch (error) {
      const pending = this.pendingQuestions.get(questionId);
      if (pending) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
        this.pendingQuestions.delete(questionId);
      }
      throw error;
    }
  }

  /** Register a pending operator question — the agent waits on the returned promise. */
  waitForAnswer(questionId: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.pendingQuestions.set(questionId, { resolve, reject });
    });
  }

  /** Reject all pending questions so nothing deadlocks on close. */
  closeQuestions(reason = "Session closed"): void {
    for (const [id, pending] of this.pendingQuestions) {
      pending.reject(new Error(reason));
    }
    this.pendingQuestions.clear();
  }

  // -- introspection -------------------------------------------------------
  stats(): AgentSessionStats {
    return {
      turns: this.usage.turns,
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      lastInputTokens: this.usage.lastInputTokens,
      contextWindowTokens: this.deps.route.context?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW,
      historyLength: this.history.length
    };
  }
}
