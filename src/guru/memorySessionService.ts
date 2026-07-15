import type { MemoryConfig, MemoryStorageConfig } from "../config/schema.js";
import type { Learning } from "../garage/flywheel.js";
import { loadLearnings } from "../garage/flywheelStore.js";
import { HonchoContextSnapshotSchema, HonchoStatusSchema, type HonchoStatus } from "../honcho/schemas.js";
import {
  mergeFactSourceInjection,
  type FactInjectionSource,
  type LearningInjectionSource
} from "../memory/inject.js";
import { createMarkdownMemoryStore, type MemoryFactStore } from "../memory/provider.js";
import { buildRecallIndex, queryRecall } from "../memory/recall.js";
import { MEMORY_SCOPES, createScopedMemory, type MemoryScope, type ScopedMemoryOptions } from "../memory/scopes.js";
import type { FileMemoryStore } from "../memory/store.js";
import type { ToolObservation } from "../tools/registry.js";
import type { ChatTurnMessage } from "../model/directChat.js";

export type MemorySlashCommand = "/remember" | "/memory" | "/recall";
export type MemoryLineTone = "plain" | "muted" | "heading" | "success" | "warning";
export type MemorySegmentTone = "plain" | "muted" | "heading" | "info";

export interface MemoryCommandSegment {
  readonly tone: MemorySegmentTone;
  readonly text: string;
}

export interface MemoryCommandLine {
  readonly tone: MemoryLineTone;
  readonly text: string;
  readonly segments?: readonly MemoryCommandSegment[];
}

export interface MemoryCommandResult {
  readonly lines: readonly MemoryCommandLine[];
  readonly contextChanged: boolean;
}

export interface MemoryRefreshOptions {
  readonly query?: string;
  readonly toolContext?: MemoryToolContext;
}

export interface MemoryToolRuntime {
  executeTool(sessionId: string, toolId: string, input: unknown): Promise<ToolObservation>;
}

export interface MemoryToolContext {
  readonly sessionId: string;
  readonly runtime: MemoryToolRuntime;
}

export type MemoryHonchoStatus =
  | HonchoStatus
  | { readonly status: "unavailable"; readonly writeEnabled: false; readonly missingEnvNames: readonly string[]; readonly summary: string };

export interface MemorySessionServiceOptions {
  readonly baseStore: FileMemoryStore;
  readonly configuredStore: MemoryFactStore;
  readonly memoryConfig: MemoryConfig;
  readonly scopedMemoryOptions?: ScopedMemoryOptions;
  readonly now?: () => Date;
  /** Test seam; production keeps the TUI's fixed two-second integration budget. */
  readonly honchoTimeoutMs?: number;
}

export interface MemorySessionService {
  readonly contextBlock: string;
  readonly canonicalFactCount: number;
  readonly injectedLearningIds: readonly string[];
  readonly providerLabel: "Markdown" | "PostgreSQL";
  readonly storageDescription: string;
  bindRepoRoot(repoRoot: string | null): void;
  bindRole(roleSlug: string | null): void;
  localStoreFor(scope: MemoryScope): FileMemoryStore | null;
  composeSystemPrompt(basePrompt: string): string;
  briefingLines(honcho: Pick<MemoryHonchoStatus, "status" | "summary">): readonly string[];
  refresh(options?: MemoryRefreshOptions): Promise<string>;
  honchoStatus(context?: MemoryToolContext): Promise<MemoryHonchoStatus>;
  recordTurn(context: MemoryToolContext | undefined, userSummary: string, assistantSummary: string): void;
  runCommand(command: MemorySlashCommand, args: readonly string[], context?: MemoryToolContext): Promise<MemoryCommandResult>;
}

const MEMORY_SLASH_COMMANDS = new Set<MemorySlashCommand>(["/remember", "/memory", "/recall"]);

export function isMemorySlashCommand(command: string): command is MemorySlashCommand {
  return MEMORY_SLASH_COMMANDS.has(command as MemorySlashCommand);
}

export function describeMemoryStorage(storage: MemoryStorageConfig): string {
  return storage.provider === "postgres"
    ? `postgres (${storage.postgres.connectionStringEnvVar}; ${storage.postgres.schema}.${storage.postgres.table})`
    : "markdown (Markdown vault + MEMORY.md index)";
}

export function formatMemoryBriefingStatus(
  providerLabel: MemorySessionService["providerLabel"],
  honcho: Pick<MemoryHonchoStatus, "status" | "summary">,
  injectedLearningCount: number
): readonly string[] {
  return [
    `${providerLabel} fact memory · honcho ${honcho.status} · ${injectedLearningCount} learning(s) injected (decay-ranked, with provenance)`,
    `honcho: ${honcho.summary}`
  ];
}

/** Refresh live memory first, then replace only the mutable system head. */
export async function refreshMemorySystemHead(
  memory: Pick<MemorySessionService, "refresh" | "composeSystemPrompt">,
  history: ChatTurnMessage[],
  basePrompt: string,
  options?: MemoryRefreshOptions
): Promise<void> {
  await memory.refresh(options);
  if (history[0]?.role === "system") {
    history[0] = { role: "system", content: memory.composeSystemPrompt(basePrompt) };
  }
}

/**
 * Own one interactive session's fact-memory selection, scoped Markdown stores,
 * and injected prompt block. Construction is inert: no store is read until a
 * command or refresh explicitly asks for it.
 */
export function createMemorySessionService(options: MemorySessionServiceOptions): MemorySessionService {
  const scoped = createScopedMemory(options.baseStore, options.scopedMemoryOptions ?? {});
  const migrationSource = createMarkdownMemoryStore(options.baseStore);
  const markdownFacades = new WeakMap<FileMemoryStore, MemoryFactStore>();
  let canonicalBlock = "";
  let honchoBlock = "";
  let injectedLearningIds: readonly string[] = [];
  let injectedLearningPreview: readonly Learning[] = [];
  let canonicalFactCount = 0;

  const markdownFacade = (store: FileMemoryStore): MemoryFactStore => {
    if (store === options.baseStore && options.configuredStore.provider === "markdown") {
      return options.configuredStore;
    }
    const existing = markdownFacades.get(store);
    if (existing) {
      return existing;
    }
    const created = createMarkdownMemoryStore(store);
    markdownFacades.set(store, created);
    return created;
  };

  const activeFactStores = (): readonly { scope: MemoryScope; store: MemoryFactStore }[] => {
    if (options.configuredStore.provider === "postgres") {
      return [{ scope: "global", store: options.configuredStore }];
    }
    return scoped.activeStores().map(({ scope, store }) => ({ scope, store: markdownFacade(store) }));
  };

  const activeLearningSources = (): readonly LearningInjectionSource[] => {
    const sources: LearningInjectionSource[] = [];
    for (const { scope, store } of scoped.activeStores()) {
      try {
        sources.push({ scope, learnings: loadLearnings(store) });
      } catch {
        // Local flywheel state is additive. One unavailable scope must not hide
        // healthy canonical facts or make PostgreSQL recall fail.
      }
    }
    return sources;
  };

  const refresh = async (refreshOptions: MemoryRefreshOptions = {}): Promise<string> => {
    honchoBlock = "";
    try {
      const factSources: FactInjectionSource[] = await Promise.all(
        activeFactStores().map(async ({ scope, store }) => ({ scope, entries: await store.list() }))
      );
      const learningSources = activeLearningSources();
      const injection = mergeFactSourceInjection(factSources, learningSources, {
        ...(refreshOptions.query ? { query: refreshOptions.query } : {}),
        ...(options.now ? { now: options.now } : {})
      });
      const learningById = new Map<string, Learning>();
      for (const { learnings } of learningSources) {
        for (const learning of learnings) {
          if (!learningById.has(learning.id)) learningById.set(learning.id, learning);
        }
      }
      canonicalBlock = injection.block;
      canonicalFactCount = factSources.reduce((sum, source) => sum + source.entries.length, 0);
      injectedLearningIds = injection.injectedLearningIds;
      injectedLearningPreview = injectedLearningIds.flatMap((id) => {
        const learning = learningById.get(id);
        return learning ? [learning] : [];
      });
    } catch {
      // Markdown preserves its last known-good block. A selected PostgreSQL store
      // must never leave stale content behind or consult Markdown as a fallback.
      if (options.configuredStore.provider === "postgres") {
        canonicalBlock = "";
        canonicalFactCount = 0;
        injectedLearningIds = [];
        injectedLearningPreview = [];
      }
    }
    const honcho = options.memoryConfig.honcho;
    if (refreshOptions.toolContext && honcho.enabled && honcho.syncOnTurn) {
      try {
        const observation = await withTimeout(
          refreshOptions.toolContext.runtime.executeTool(refreshOptions.toolContext.sessionId, "honcho_context", { maxTokens: honcho.contextTokenBudget }),
          options.honchoTimeoutMs ?? 2_000
        );
        const output = HonchoContextSnapshotSchema.safeParse(observation?.output);
        if (observation?.status === "succeeded" && output.success && output.data.status === "succeeded") {
          honchoBlock = `\n\n## Honcho memory context (derived — verify against current state)\n${output.data.snapshot}`;
        }
      } catch {
        // Honcho is additive: canonical fact context remains available on failure.
      }
    }
    return `${canonicalBlock}${honchoBlock}`;
  };

  const honchoStatus = async (context?: MemoryToolContext): Promise<MemoryHonchoStatus> => {
    if (!context) {
      return { status: "unavailable", writeEnabled: false, missingEnvNames: [], summary: "Honcho status is unavailable before a session starts." };
    }
    try {
      const observation = await context.runtime.executeTool(context.sessionId, "honcho_memory_status", {});
      const parsed = HonchoStatusSchema.safeParse(observation.output);
      if (observation.status === "succeeded" && parsed.success) {
        return parsed.data;
      }
    } catch {
      // Fall through to the honest unavailable result.
    }
    return { status: "unavailable", writeEnabled: false, missingEnvNames: [], summary: "Honcho status is unavailable." };
  };

  const recordTurn = (context: MemoryToolContext | undefined, userSummary: string, assistantSummary: string): void => {
    const honcho = options.memoryConfig.honcho;
    if (!context || !honcho.enabled || !honcho.syncOnTurn || assistantSummary.trim().length === 0) {
      return;
    }
    void context.runtime.executeTool(context.sessionId, "honcho_log_turn", {
      userSummary,
      assistantSummary,
      writeEnabled: true,
      userApproved: true
    }).catch(() => {
      // Background integration failures never hold or reject the chat turn.
    });
  };

  const remember = async (args: readonly string[]): Promise<MemoryCommandResult> => {
    let scope: MemoryScope = "global";
    let words = [...args];
    const firstWord = (words[0] ?? "").toLowerCase();
    if ((MEMORY_SCOPES as readonly string[]).includes(firstWord)) {
      scope = firstWord as MemoryScope;
      words = words.slice(1);
    }
    const textInput = words.join(" ").trim();
    if (textInput.length === 0) {
      return { lines: [{ tone: "muted", text: "Usage: /remember [global|space|role] <fact to persist>" }], contextChanged: false };
    }

    const lines: MemoryCommandLine[] = [];
    const available = activeFactStores();
    let target = available.find((source) => source.scope === scope);
    if (!target) {
      if (options.configuredStore.provider === "postgres") {
        lines.push({ tone: "muted", text: `  PostgreSQL fact memory currently uses its configured global namespace; saving this ${scope} fact there.` });
      } else {
        lines.push({ tone: "muted", text: `  no ${scope} scope active (${scope === "space" ? "no repo bound" : "no suit worn"}) — saving to global` });
      }
      scope = "global";
      target = available.find((source) => source.scope === "global");
    }
    if (!target) {
      return { lines: [...lines, { tone: "warning", text: "No global memory store is available." }], contextChanged: false };
    }

    const firstSentence = textInput.split(/(?<=[.!?])\s+/u)[0] ?? textInput;
    const title = (firstSentence.length > 80 ? `${firstSentence.slice(0, 77)}...` : firstSentence).trim();
    const description = (textInput.length > 200 ? `${textInput.slice(0, 197)}...` : textInput).replace(/\s+/gu, " ").trim();
    const result = await target.store.remember({ title, description, body: textInput, type: "project", edit: "replace", confidence: 1 });
    if (result.status === "blocked") {
      return {
        lines: [
          ...lines,
          { tone: "warning", text: result.summary },
          ...result.blockers.map((blocker): MemoryCommandLine => ({ tone: "muted", text: `  ${blocker}` }))
        ],
        contextChanged: false
      };
    }

    await refresh();
    const scopeNote = scope === "global" ? "" : ` (${scope} scope)`;
    lines.push({ tone: "success", text: `${result.summary}${scopeNote} It will be in every future boot briefing.` });
    return { lines, contextChanged: true };
  };

  const migrate = async (): Promise<MemoryCommandResult> => {
    if (options.configuredStore.provider !== "postgres") {
      return {
        lines: [{ tone: "muted", text: "Memory migration is available after setting memory.storage.provider to postgres and restarting Guru." }],
        contextChanged: false
      };
    }
    const storage = await options.configuredStore.status();
    if (storage.status !== "ready") {
      return {
        lines: [{ tone: "warning", text: `PostgreSQL memory is ${storage.status}; migration did not run. ${storage.summary}` }],
        contextChanged: false
      };
    }

    const candidates = (await migrationSource.list()).filter(({ fact }) => !["learning", "loadout", "path-outcome"].includes(fact.type));
    let created = 0;
    let updated = 0;
    let blocked = 0;
    for (const { fact, body } of candidates) {
      const result = await options.configuredStore.remember({
        name: fact.name,
        title: fact.title,
        description: fact.description,
        body,
        type: fact.type,
        edit: "replace",
        confidence: fact.confidence
      });
      if (result.status === "created") created += 1;
      else if (result.status === "updated") updated += 1;
      else blocked += 1;
    }
    await refresh();
    return {
      lines: [{ tone: blocked === 0 ? "success" : "warning", text: `Migrated ${created} Markdown fact(s), updated ${updated}; ${blocked} blocked. Source Markdown files were left untouched.` }],
      contextChanged: true
    };
  };

  const recall = async (args: readonly string[]): Promise<MemoryCommandResult> => {
    const query = args.join(" ").trim();
    if (query.length === 0) {
      return { lines: [{ tone: "muted", text: "Usage: /recall <what you're looking for>" }], contextChanged: false };
    }
    const docs: { id: string; text: string }[] = [];
    const meta = new Map<string, { label: string; kind: "fact" | "learning"; scope: MemoryScope }>();
    try {
      const sources = await Promise.all(
        activeFactStores().map(async ({ scope, store }) => ({ scope, entries: await store.list() }))
      );
      for (const { scope, entries } of sources) {
        for (const { fact } of entries) {
          if (fact.type === "learning") continue;
          const id = `${scope}:${fact.name}`;
          if (meta.has(id)) continue;
          docs.push({ id, text: `${fact.title} ${fact.description}` });
          meta.set(id, { label: `${fact.title} — ${fact.description}`, kind: "fact", scope });
        }
      }
    } catch {
      const message = options.configuredStore.provider === "postgres"
        ? "PostgreSQL memory is unavailable; no fallback was used. Run /memory status to recover."
        : "Markdown memory is unavailable. Run /memory status to recover.";
      return { lines: [{ tone: "warning", text: message }], contextChanged: false };
    }
    for (const { scope, learnings } of activeLearningSources()) {
      for (const learning of learnings) {
        const id = `${scope}:learning:${learning.id}`;
        if (meta.has(id)) continue;
        docs.push({ id, text: `${learning.statement} ${learning.subject} ${learning.tools.join(" ")}` });
        meta.set(id, { label: `(${learning.level}) ${learning.statement}`, kind: "learning", scope });
      }
    }
    const hits = queryRecall(buildRecallIndex(docs), query, 10);
    if (hits.length === 0) {
      return { lines: [{ tone: "muted", text: `No memory related to "${query}" (searched ${docs.length} item(s)).` }], contextChanged: false };
    }
    const heading = `recall — ${hits.length} related to "${query}"`;
    const suffix = `  (BM25 over ${docs.length} item(s))`;
    const lines: MemoryCommandLine[] = [{
      tone: "heading",
      text: `${heading}${suffix}`,
      segments: [{ tone: "heading", text: heading }, { tone: "muted", text: suffix }]
    }];
    for (const hit of hits) {
      const entry = meta.get(hit.id);
      if (!entry) continue;
      const tag = entry.scope === "global" ? "" : ` ·${entry.scope}`;
      const score = hit.score.toFixed(2).padStart(5);
      lines.push({
        tone: "plain",
        text: `  ${score} ${entry.kind}${tag}  ${entry.label}`,
        segments: [
          { tone: "plain", text: "  " },
          { tone: "info", text: score },
          { tone: "muted", text: ` ${entry.kind}${tag}` },
          { tone: "plain", text: `  ${entry.label}` }
        ]
      });
    }
    return { lines, contextChanged: false };
  };

  const doctor = async (): Promise<MemoryCommandResult> => {
    const report = await options.configuredStore.doctor();
    const lines: MemoryCommandLine[] = [{ tone: "success", text: report.summary }];
    lines.push(...report.corruptSkipped.map((corrupt): MemoryCommandLine => ({ tone: "muted", text: `  corrupt (skipped): ${corrupt}` })));
    lines.push(...report.danglingLinks.map((link): MemoryCommandLine => ({ tone: "muted", text: `  dangling link: ${link}` })));
    await refresh();
    return { lines, contextChanged: true };
  };

  const status = async (context?: MemoryToolContext): Promise<MemoryCommandResult> => {
    const [storage, honcho] = await Promise.all([options.configuredStore.status(), honchoStatus(context)]);
    const statusLines: MemoryCommandLine[] = [
      { tone: "muted", text: `  storage  ${storage.status} · ${storage.location}` },
      { tone: "muted", text: `  honcho   ${honcho.status} (optional context layer) · ${honcho.summary}` }
    ];
    if (options.configuredStore.provider === "postgres") {
      const lines = [...statusLines];
      if (storage.status !== "ready") {
        lines.push({ tone: "warning", text: "  PostgreSQL memory is not usable; no Markdown fallback is active. Fix the status above, then retry." });
        return { lines, contextChanged: false };
      }
      try {
        const facts = await options.configuredStore.list();
        lines.push({ tone: "heading", text: `memory — ${facts.length} PostgreSQL fact(s)` });
        lines.push(...facts.slice(0, 15).map(({ fact }): MemoryCommandLine => {
          const name = fact.name.padEnd(34);
          const metadata = ` ${fact.type} · updated ${fact.updatedAt.slice(0, 10)}`;
          return {
            tone: "plain",
            text: `  ${name}${metadata}`,
            segments: [{ tone: "plain", text: "  " }, { tone: "info", text: name }, { tone: "muted", text: metadata }]
          };
        }));
        if (facts.length === 0) {
          lines.push({ tone: "muted", text: "  Nothing remembered yet — /remember <fact> or the memory_remember tool." });
        }
      } catch {
        lines.push({ tone: "warning", text: "  PostgreSQL memory became unavailable while listing facts; no fallback was used." });
      }
      return { lines, contextChanged: false };
    }

    try {
      const sources = await Promise.all(
        activeFactStores().map(async ({ scope, store }) => ({ scope, store, entries: await store.list() }))
      );
      const totalFacts = sources.reduce((sum, source) => sum + source.entries.length, 0);
      const lines: MemoryCommandLine[] = [{ tone: "heading", text: `memory — ${totalFacts} fact(s) across ${sources.length} scope(s)` }];
      for (const { scope, store, entries } of sources) {
        lines.push({ tone: "muted", text: `  ${scope.padEnd(6)} ${entries.length} fact(s)  (${store.directory})` });
      }
      const global = sources.find((source) => source.scope === "global")?.entries ?? [];
      lines.push(...global.slice(0, 15).map(({ fact }): MemoryCommandLine => {
        const name = fact.name.padEnd(34);
        const metadata = ` ${fact.type} · updated ${fact.updatedAt.slice(0, 10)}`;
        return {
          tone: "plain",
          text: `  ${name}${metadata}`,
          segments: [{ tone: "plain", text: "  " }, { tone: "info", text: name }, { tone: "muted", text: metadata }]
        };
      }));
      if (global.length > 15) {
        lines.push({ tone: "muted", text: `  ...and ${global.length - 15} more in global (memory_search)` });
      }
      if (totalFacts === 0) {
        lines.push({ tone: "muted", text: "  Nothing remembered yet — /remember [global|space|role] <fact> or the memory_remember tool." });
      }
      lines.push({ tone: "muted", text: "  Obsidian-compatible vault: open a scope directory above as a vault to browse/graph it." });
      lines.push(...statusLines);
      return { lines, contextChanged: false };
    } catch {
      return { lines: [...statusLines, { tone: "warning", text: "  Markdown memory became unavailable while listing facts." }], contextChanged: false };
    }
  };

  return {
    get contextBlock() {
      return `${canonicalBlock}${honchoBlock}`;
    },
    get canonicalFactCount() {
      return canonicalFactCount;
    },
    get injectedLearningIds() {
      return injectedLearningIds;
    },
    get providerLabel() {
      return options.configuredStore.provider === "postgres" ? "PostgreSQL" : "Markdown";
    },
    get storageDescription() {
      return describeMemoryStorage(options.memoryConfig.storage);
    },
    bindRepoRoot(repoRoot) {
      scoped.setRepoRoot(repoRoot);
    },
    bindRole(roleSlug) {
      scoped.setRole(roleSlug);
    },
    localStoreFor(scope) {
      return scoped.storeFor(scope);
    },
    composeSystemPrompt(basePrompt) {
      return `${basePrompt}${canonicalBlock}${honchoBlock}`;
    },
    briefingLines(honcho) {
      const lines = [...formatMemoryBriefingStatus(
        options.configuredStore.provider === "postgres" ? "PostgreSQL" : "Markdown",
        honcho,
        injectedLearningIds.length
      )];
      for (const learning of injectedLearningPreview.slice(0, 4)) {
        lines.push(`↳ (${learning.level}·cited ${learning.citations.length}×${learning.lastCitedSession !== null ? `·last #${learning.lastCitedSession}` : ""}) ${learning.statement}`);
      }
      return lines;
    },
    refresh,
    honchoStatus,
    recordTurn,
    async runCommand(command, args, context) {
      if (command === "/remember") {
        return remember(args);
      }
      if (command === "/memory" && (args[0] ?? "status").toLowerCase() === "migrate") {
        return migrate();
      }
      if (command === "/memory" && (args[0] ?? "status").toLowerCase() === "doctor") {
        return doctor();
      }
      if (command === "/memory") {
        return status(context);
      }
      if (command === "/recall") {
        return recall(args);
      }
      return { lines: [{ tone: "muted", text: `Usage: ${command}` }], contextChanged: false };
    }
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
