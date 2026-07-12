import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import { CompactionStateSchema, type CompactionState } from "../compaction/schemas.js";
import { scrubSecretValues } from "../safety/secretSafety.js";
import {
  ConversationRecordSchema,
  deriveConversationTitle,
  resolveStoreDirectory,
  type ConversationStoreOptions,
  type ConversationSummary
} from "./conversationStore.js";

/**
 * Append-only JSONL session log — the durable source of truth for `guru`
 * (Session Tree wave, ADR 2026-07-05-session-tree, THERE v2 §6).
 *
 * One file per session under ~/.guruharness/sessions/<id>.jsonl, one JSON object
 * per line, ONLY ever appended. Each line is a {@link SessionLogEntry}: a
 * `parentId` chain that is a DAG (a linear session chains each entry to the
 * prior one; branches — `/fork`, `/clone` — are separate sessions whose `meta`
 * carries `lineage` back to the entry they forked from). The stream is LOSSLESS:
 * a compaction entry is a marker, never a rewrite, so every branch stays alive
 * indefinitely (degrade-never-destroy). Legacy flat-JSON sessions still load.
 */

export const SESSION_LOG_SCHEMA_VERSION = 1;

const baseFields = {
  schemaVersion: z.number().int().positive(),
  id: z.string().trim().min(1),
  /** The entry this one follows; null at the root. A DAG edge, not a list index. */
  parentId: z.string().trim().min(1).nullable(),
  ts: z.string().trim().min(1)
};

export const SessionLineageSchema = z
  .object({
    parentSessionId: z.string().trim().min(1),
    parentEntryId: z.string().trim().min(1)
  })
  .strict();
export type SessionLineage = z.infer<typeof SessionLineageSchema>;

/** Session-level metadata; folded last-wins on replay. */
export const MetaEntrySchema = z
  .object({
    ...baseFields,
    kind: z.literal("meta"),
    title: z.string(),
    routeId: z.string().trim().min(1).nullable(),
    modelIdOverride: z.string().trim().min(1).nullable(),
    createdAt: z.string().trim().min(1),
    /** Set when this session was forked/cloned from another (the cross-session DAG edge). */
    lineage: SessionLineageSchema.optional(),
    /** Branch memory — a summary of this branch, injected when a parent is re-entered. */
    branchSummary: z.string().optional()
  })
  .strict();

/** A turn message, with audit markers (mode, and approver where a gate fired). */
export const MessageEntrySchema = z
  .object({
    ...baseFields,
    kind: z.literal("message"),
    role: z.enum(["system", "user", "assistant"]),
    content: z.string(),
    mode: z.enum(["normal", "yolo"]),
    approver: z.string().trim().min(1).optional()
  })
  .strict();

/** A compaction snapshot — restores summary count + continuity on replay; never deletes lines. */
export const CompactionEntrySchema = z
  .object({
    ...baseFields,
    kind: z.literal("compaction"),
    compaction: CompactionStateSchema
  })
  .strict();

export const SessionLogEntrySchema = z.discriminatedUnion("kind", [MetaEntrySchema, MessageEntrySchema, CompactionEntrySchema]);
export type SessionLogEntry = z.infer<typeof SessionLogEntrySchema>;
export type SessionMessageEntry = z.infer<typeof MessageEntrySchema>;

export interface ReconstructedMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** A session replayed from its log (or a legacy flat record). */
export interface ReconstructedSession {
  readonly id: string;
  readonly title: string;
  readonly routeId: string | null;
  readonly modelIdOverride: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly ReconstructedMessage[];
  /** Log entry id parallel to each message (synthetic `${id}:m<index>` for legacy). */
  readonly entryIds: readonly string[];
  readonly compaction?: CompactionState;
  readonly lineage?: SessionLineage;
  readonly branchSummary?: string;
  /** True when this session came from a legacy flat `.json` file. */
  readonly legacy: boolean;
}

/** A child branch of some parent session (read from `lineage`). */
export interface ChildBranch {
  readonly sessionId: string;
  readonly title: string;
  readonly parentEntryId: string;
  readonly branchSummary?: string;
  readonly turnCount: number;
  readonly updatedAt: string;
}

export interface ForestNode {
  readonly id: string;
  readonly title: string;
  readonly turnCount: number;
  readonly updatedAt: string;
  readonly children: readonly ForestNode[];
}

export interface AppendMessageInput {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  readonly mode: "normal" | "yolo";
  readonly approver?: string;
}

export interface AppendMetaInput {
  readonly title: string;
  readonly routeId: string | null;
  readonly modelIdOverride: string | null;
  readonly createdAt?: string;
  readonly lineage?: SessionLineage;
  readonly branchSummary?: string;
}

export interface SessionLogStore {
  readonly directory: string;
  appendMessage(sessionId: string, message: AppendMessageInput): SessionLogEntry;
  appendMeta(sessionId: string, meta: AppendMetaInput): SessionLogEntry;
  appendCompaction(sessionId: string, compaction: CompactionState): SessionLogEntry;
  head(sessionId: string): string | null;
  readEntries(sessionId: string): readonly SessionLogEntry[];
  /** Replay the log (or a legacy record) into a working session view. */
  load(sessionId: string): ReconstructedSession | undefined;
  list(): readonly ConversationSummary[];
  children(sessionId: string): readonly ChildBranch[];
  forest(): readonly ForestNode[];
  /** New session seeded with messages from root THROUGH `throughEntryId` (inclusive). */
  fork(sessionId: string, throughEntryId: string): { readonly newId: string; readonly session: ReconstructedSession } | undefined;
  /** New session duplicating the entire active branch (for destructive experiments). */
  clone(sessionId: string): { readonly newId: string; readonly session: ReconstructedSession } | undefined;
}

export interface SessionLogStoreOptions extends ConversationStoreOptions {
  readonly newId?: () => string;
}

/** Session ids are UUID-ish; keep the filename to a safe charset regardless. */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/gu, "_");
}

export function createSessionLogStore(options: SessionLogStoreOptions = {}): SessionLogStore {
  const directory = resolveStoreDirectory(options);
  const now = options.now ?? (() => new Date());
  const mkId = options.newId ?? (() => randomUUID());
  const headCache = new Map<string, string | null>();

  const ensureDir = (): void => {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
  };
  const jsonlFile = (id: string): string => join(directory, `${sanitizeId(id)}.jsonl`);
  const legacyFile = (id: string): string => join(directory, `${sanitizeId(id)}.json`);

  const readEntries = (sessionId: string): SessionLogEntry[] => {
    const file = jsonlFile(sessionId);
    if (!existsSync(file)) {
      return [];
    }
    const entries: SessionLogEntry[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        // Torn trailing line from a crash mid-append (or any unparseable line):
        // skip it. The valid prefix still replays deterministically.
        continue;
      }
      const parsed = SessionLogEntrySchema.safeParse(obj);
      if (parsed.success) {
        entries.push(parsed.data);
      }
    }
    return entries;
  };

  const head = (sessionId: string): string | null => {
    if (headCache.has(sessionId)) {
      return headCache.get(sessionId) ?? null;
    }
    const entries = readEntries(sessionId);
    const value = entries.length > 0 ? (entries[entries.length - 1] as SessionLogEntry).id : null;
    headCache.set(sessionId, value);
    return value;
  };

  const append = (sessionId: string, partial: Record<string, unknown>): SessionLogEntry => {
    ensureDir();
    const entry = SessionLogEntrySchema.parse({
      schemaVersion: SESSION_LOG_SCHEMA_VERSION,
      id: mkId(),
      parentId: head(sessionId),
      ts: now().toISOString(),
      ...partial
    });
    appendFileSync(jsonlFile(sessionId), `${JSON.stringify(entry)}\n`, "utf8");
    headCache.set(sessionId, entry.id);
    return entry;
  };

  const appendMessage = (sessionId: string, message: AppendMessageInput): SessionLogEntry =>
    append(sessionId, {
      kind: "message",
      role: message.role,
      // Secret scrub at the disk boundary — a RESOLVED credential value must never
      // land in the durable log (same rule as the legacy store, per-append).
      content: scrubSecretValues(message.content),
      mode: message.mode,
      ...(message.approver ? { approver: message.approver } : {})
    });

  const appendMeta = (sessionId: string, meta: AppendMetaInput): SessionLogEntry =>
    append(sessionId, {
      kind: "meta",
      title: scrubSecretValues(meta.title),
      routeId: meta.routeId,
      modelIdOverride: meta.modelIdOverride,
      createdAt: meta.createdAt ?? now().toISOString(),
      ...(meta.lineage ? { lineage: meta.lineage } : {}),
      ...(meta.branchSummary ? { branchSummary: scrubSecretValues(meta.branchSummary) } : {})
    });

  const appendCompaction = (sessionId: string, compaction: CompactionState): SessionLogEntry =>
    append(sessionId, {
      kind: "compaction",
      compaction: {
        ...compaction,
        summary: scrubSecretValues(compaction.summary),
        details: {
          readFiles: compaction.details.readFiles.map((file) => scrubSecretValues(file)),
          modifiedFiles: compaction.details.modifiedFiles.map((file) => scrubSecretValues(file))
        }
      }
    });

  const reconstructFromEntries = (sessionId: string, entries: readonly SessionLogEntry[]): ReconstructedSession => {
    const messages: ReconstructedMessage[] = [];
    const entryIds: string[] = [];
    let title = "";
    let routeId: string | null = null;
    let modelIdOverride: string | null = null;
    let createdAt = "";
    let lineage: SessionLineage | undefined;
    let branchSummary: string | undefined;
    let compaction: CompactionState | undefined;
    let updatedAt = "";
    for (const entry of entries) {
      updatedAt = entry.ts;
      if (entry.kind === "meta") {
        title = entry.title || title;
        routeId = entry.routeId;
        modelIdOverride = entry.modelIdOverride;
        if (createdAt === "") {
          createdAt = entry.createdAt;
        }
        if (entry.lineage) {
          lineage = entry.lineage;
        }
        if (entry.branchSummary !== undefined) {
          branchSummary = entry.branchSummary;
        }
      } else if (entry.kind === "message") {
        // Skip empty messages at load (defensive normalization): an aborted
        // turn's empty assistant line would re-poison a resumed session on
        // strict providers that reject empty content (anthropic-messages 400).
        if (entry.content.trim().length > 0) {
          messages.push({ role: entry.role, content: entry.content });
          entryIds.push(entry.id);
        }
      } else {
        compaction = entry.compaction;
      }
    }
    const firstTs = entries.length > 0 ? (entries[0] as SessionLogEntry).ts : now().toISOString();
    return {
      id: sessionId,
      title: title.trim().length > 0 ? title : deriveConversationTitle(messages),
      routeId,
      modelIdOverride,
      createdAt: createdAt || firstTs,
      updatedAt: updatedAt || firstTs,
      messages,
      entryIds,
      ...(compaction ? { compaction } : {}),
      ...(lineage ? { lineage } : {}),
      ...(branchSummary !== undefined ? { branchSummary } : {}),
      legacy: false
    };
  };

  const loadLegacy = (sessionId: string): ReconstructedSession | undefined => {
    const file = legacyFile(sessionId);
    if (!existsSync(file)) {
      return undefined;
    }
    try {
      const parsed = ConversationRecordSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (!parsed.success) {
        return undefined;
      }
      const record = parsed.data;
      // Same empty-message normalization as the jsonl path — filter BEFORE the
      // positional entry ids are synthesized so messages/entryIds stay parallel.
      const kept = record.messages
        .map((message, index) => ({ role: message.role, content: message.content, id: `${record.id}:m${index}` }))
        .filter((message) => message.content.trim().length > 0);
      return {
        id: record.id,
        title: record.title,
        routeId: record.routeId,
        modelIdOverride: record.modelIdOverride,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        messages: kept.map(({ role, content }) => ({ role, content })),
        // Legacy records have no per-entry ids; synthesize stable positional ones
        // so /fork can still target a prior message.
        entryIds: kept.map((message) => message.id),
        ...(record.compaction ? { compaction: record.compaction } : {}),
        legacy: true
      };
    } catch {
      return undefined;
    }
  };

  const load = (sessionId: string): ReconstructedSession | undefined => {
    const entries = readEntries(sessionId);
    if (entries.length > 0) {
      return reconstructFromEntries(sessionId, entries);
    }
    return loadLegacy(sessionId);
  };

  /** Every session id present in the store dir (jsonl preferred; legacy .json too). */
  const allSessionIds = (): string[] => {
    if (!existsSync(directory)) {
      return [];
    }
    const ids = new Set<string>();
    const legacyIds = new Set<string>();
    for (const entry of readdirSync(directory)) {
      if (entry.endsWith(".jsonl")) {
        ids.add(entry.slice(0, -".jsonl".length));
      } else if (entry.endsWith(".json")) {
        legacyIds.add(entry.slice(0, -".json".length));
      }
    }
    for (const id of legacyIds) {
      if (!ids.has(id)) {
        ids.add(id);
      }
    }
    return [...ids];
  };

  const summaryOf = (session: ReconstructedSession): ConversationSummary => ({
    id: session.id,
    title: session.title,
    routeId: session.routeId,
    turnCount: session.messages.filter((message) => message.role === "assistant").length,
    updatedAt: session.updatedAt
  });

  const list = (): ConversationSummary[] => {
    const summaries: ConversationSummary[] = [];
    for (const id of allSessionIds()) {
      const session = load(id);
      if (session) {
        summaries.push(summaryOf(session));
      }
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  };

  const children = (sessionId: string): ChildBranch[] => {
    const branches: ChildBranch[] = [];
    for (const id of allSessionIds()) {
      if (id === sessionId) {
        continue;
      }
      const session = load(id);
      if (session?.lineage && session.lineage.parentSessionId === sessionId) {
        branches.push({
          sessionId: session.id,
          title: session.title,
          parentEntryId: session.lineage.parentEntryId,
          ...(session.branchSummary !== undefined ? { branchSummary: session.branchSummary } : {}),
          turnCount: session.messages.filter((message) => message.role === "assistant").length,
          updatedAt: session.updatedAt
        });
      }
    }
    return branches.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  };

  const forest = (): ForestNode[] => {
    const sessions = allSessionIds()
      .map((id) => load(id))
      .filter((session): session is ReconstructedSession => session !== undefined);
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const childrenByParent = new Map<string, ReconstructedSession[]>();
    const roots: ReconstructedSession[] = [];
    for (const session of sessions) {
      const parentId = session.lineage?.parentSessionId;
      if (parentId !== undefined && byId.has(parentId)) {
        const bucket = childrenByParent.get(parentId) ?? [];
        bucket.push(session);
        childrenByParent.set(parentId, bucket);
      } else {
        roots.push(session);
      }
    }
    const build = (session: ReconstructedSession): ForestNode => ({
      id: session.id,
      title: session.title,
      turnCount: session.messages.filter((message) => message.role === "assistant").length,
      updatedAt: session.updatedAt,
      children: (childrenByParent.get(session.id) ?? [])
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
        .map(build)
    });
    return roots.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map(build);
  };

  const seedBranch = (
    source: ReconstructedSession,
    throughIndex: number,
    parentEntryId: string
  ): { newId: string; session: ReconstructedSession } => {
    const newId = mkId();
    appendMeta(newId, {
      title: source.title,
      routeId: source.routeId,
      modelIdOverride: source.modelIdOverride,
      createdAt: now().toISOString(),
      lineage: { parentSessionId: source.id, parentEntryId }
    });
    for (let index = 0; index <= throughIndex; index += 1) {
      const message = source.messages[index] as ReconstructedMessage;
      // Copied history carries no audit weight; the branch's NEW turns get real
      // markers. Mode defaults to normal on the copy.
      appendMessage(newId, { role: message.role, content: message.content, mode: "normal" });
    }
    const session = load(newId);
    if (!session) {
      throw new Error(`Failed to seed branch ${newId}.`);
    }
    return { newId, session };
  };

  const fork = (sessionId: string, throughEntryId: string): { newId: string; session: ReconstructedSession } | undefined => {
    const source = load(sessionId);
    if (!source) {
      return undefined;
    }
    const index = source.entryIds.indexOf(throughEntryId);
    if (index < 0) {
      return undefined;
    }
    return seedBranch(source, index, throughEntryId);
  };

  const clone = (sessionId: string): { newId: string; session: ReconstructedSession } | undefined => {
    const source = load(sessionId);
    if (!source || source.messages.length === 0) {
      return undefined;
    }
    const lastIndex = source.messages.length - 1;
    const parentEntryId = source.entryIds[lastIndex] as string;
    return seedBranch(source, lastIndex, parentEntryId);
  };

  return {
    directory,
    appendMessage,
    appendMeta,
    appendCompaction,
    head,
    readEntries,
    load,
    list,
    children,
    forest,
    fork,
    clone
  };
}
