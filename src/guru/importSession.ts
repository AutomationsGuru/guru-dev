import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { scrubSecretValues, scrubSecretValuesReport } from "../safety/secretSafety.js";
import type { ReconstructedSession, SessionLogStore } from "./sessionLog.js";

/**
 * Cross-harness session import (Cross-Harness Import wave, ADR
 * 2026-07-05-cross-harness-import, THERE v2 §16). `guru --continue pi|claude`
 * reads the most recent session from another harness's on-disk JSONL and maps it
 * into a fresh, durable GURU session so the operator picks up the conversation.
 *
 * IMPORT-ONLY, by construction: the mappers read TEXT and never execute anything.
 * Tool calls in the foreign transcript become a compact `[used tools: …]`
 * annotation on the assistant turn — context, not a replay. Foreign content is
 * untrusted, so every imported message is redacted for secret-SHAPED values (not
 * just guru's registered ones) before it is persisted — presence-over-value.
 */

export type ForeignHarness = "pi" | "claude";

export interface ImportedMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ImportedConversation {
  readonly harness: ForeignHarness;
  /** A short provenance label, e.g. "Pi · fugu-ultra" / "Claude Code". */
  readonly sourceLabel: string;
  readonly title: string;
  /** ISO timestamp of the foreign session's creation (best-effort). */
  readonly createdAt: string;
  readonly messages: readonly ImportedMessage[];
  /** Non-turn lines skipped (bookkeeping / control / tool-result / meta). */
  readonly skipped: number;
}

export interface ImportSummary {
  readonly harness: ForeignHarness;
  readonly sourceLabel: string;
  readonly sourcePath: string;
  readonly imported: number;
  readonly skipped: number;
  /** Count of messages that had at least one secret-shaped value redacted. */
  readonly redactedMessages: number;
  /** The kinds of secret that fired (names only, never values). */
  readonly redactionKinds: readonly string[];
}

export type ImportResult =
  | { readonly ok: true; readonly session: ReconstructedSession; readonly summary: ImportSummary }
  | { readonly ok: false; readonly reason: string };

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Parse JSONL text into objects, skipping blank / malformed / partial lines. */
function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A torn trailing line (session still being written) or a corrupt record —
      // skip it; the rest of the transcript still imports.
    }
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Merge consecutive same-role messages into one (a cleaner, readable history). */
function mergeConsecutive(messages: readonly ImportedMessage[]): ImportedMessage[] {
  const merged: ImportedMessage[] = [];
  for (const message of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) {
      merged[merged.length - 1] = { role: last.role, content: `${last.content}\n${message.content}`.trim() };
    } else {
      merged.push(message);
    }
  }
  return merged;
}

function titleFrom(messages: readonly ImportedMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  const basis = (firstUser?.content ?? messages[0]?.content ?? "imported session").replace(/\s+/gu, " ").trim();
  return basis.length > 60 ? `${basis.slice(0, 57)}...` : basis;
}

function toolAnnotation(names: readonly string[]): string {
  const unique = [...new Set(names.filter((name) => typeof name === "string" && name.length > 0))];
  return unique.length > 0 ? `[used tools: ${unique.join(", ")}]` : "";
}

// ---------------------------------------------------------------------------
// Foreign transcript mapper (~/.claude/projects/<slug>/<uuid>.jsonl)
// ---------------------------------------------------------------------------

/** True for synthetic "user" lines that are command echoes / caveats, not speech. */
function isClaudeCommandNoise(content: string): boolean {
  const head = content.trimStart();
  return (
    head.startsWith("<local-command") ||
    head.startsWith("<command-name") ||
    head.startsWith("<command-message") ||
    head.startsWith("<command-args") ||
    head.startsWith("<bash-") // bash-input / bash-stdout echoes
  );
}

export function mapClaudeTranscript(text: string): ImportedConversation {
  const raw: ImportedMessage[] = [];
  let skipped = 0;
  let createdAt = "";

  for (const value of parseJsonl(text)) {
    const obj = asRecord(value);
    if (!obj) {
      skipped += 1;
      continue;
    }
    if (createdAt === "" && typeof obj.timestamp === "string") {
      createdAt = obj.timestamp;
    }
    const type = obj.type;
    if (type !== "user" && type !== "assistant") {
      skipped += 1; // attachment / system / ai-title / pr-link / file-history-snapshot / …
      continue;
    }
    if (obj.isMeta === true) {
      skipped += 1; // synthetic command caveats / echoes
      continue;
    }
    const message = asRecord(obj.message);
    if (!message) {
      skipped += 1;
      continue;
    }
    if (type === "user") {
      const content = message.content;
      if (typeof content === "string") {
        if (isClaudeCommandNoise(content) || content.trim().length === 0) {
          skipped += 1;
          continue;
        }
        raw.push({ role: "user", content: content.trim() });
      } else {
        // Array content on a user line is a tool_result — foreign tool OUTPUT,
        // not human speech. Import-only: drop it (context lives on the asst turn).
        skipped += 1;
      }
      continue;
    }
    // assistant: concat text blocks, annotate tool_use blocks.
    const blocks = Array.isArray(message.content) ? (message.content as unknown[]) : [];
    const texts: string[] = [];
    const toolNames: string[] = [];
    for (const block of blocks) {
      const b = asRecord(block);
      if (!b) {
        continue;
      }
      if (b.type === "text" && typeof b.text === "string") {
        texts.push(b.text);
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        toolNames.push(b.name);
      }
    }
    const body = [texts.join("\n").trim(), toolAnnotation(toolNames)].filter((part) => part.length > 0).join("\n");
    if (body.length > 0) {
      raw.push({ role: "assistant", content: body });
    } else {
      skipped += 1;
    }
  }

  const messages = mergeConsecutive(raw);
  return {
    harness: "claude",
    sourceLabel: "Claude Code",
    title: titleFrom(messages),
    createdAt: createdAt || new Date(0).toISOString(),
    messages,
    skipped
  };
}

// ---------------------------------------------------------------------------
// Foreign transcript mapper (~/.pi/agent/sessions/<bucket>/<ts>_<uuid>.jsonl)
// ---------------------------------------------------------------------------

interface PiNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly record: Record<string, unknown>;
}

export function mapPiTranscript(text: string): ImportedConversation {
  const records = parseJsonl(text).map(asRecord).filter((r): r is Record<string, unknown> => r !== null);

  let createdAt = "";
  let model = "";
  const byId = new Map<string, PiNode>();
  const order: PiNode[] = [];
  for (const record of records) {
    if (record.type === "session") {
      if (typeof record.timestamp === "string") {
        createdAt = record.timestamp;
      }
      continue;
    }
    const id = typeof record.id === "string" ? record.id : "";
    if (id.length === 0) {
      continue;
    }
    const parentId = typeof record.parentId === "string" ? record.parentId : null;
    const node: PiNode = { id, parentId, record };
    byId.set(id, node);
    order.push(node);
  }

  // Reconstruct the ACTIVE conversation path: from the last message record, walk
  // parentId back to the root, then reverse. This follows the foreign transcript's
  // parent-pointer tree (branches don't pollute the path) — control records on the
  // chain are stepped through but not emitted.
  let tip: PiNode | undefined;
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const node = order[index];
    if (node && node.record.type === "message") {
      tip = node;
      break;
    }
  }
  const path: PiNode[] = [];
  const guard = new Set<string>();
  let cursor: PiNode | undefined = tip;
  while (cursor && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    if (cursor.record.type === "message") {
      path.push(cursor);
    }
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  path.reverse();

  const raw: ImportedMessage[] = [];
  let skipped = records.length - path.length; // everything not on the emitted path
  for (const node of path) {
    const message = asRecord(node.record.message);
    if (!message) {
      skipped += 1;
      continue;
    }
    const role = message.role;
    const parts = Array.isArray(message.content) ? (message.content as unknown[]) : [];
    const texts: string[] = [];
    const toolNames: string[] = [];
    for (const part of parts) {
      const p = asRecord(part);
      if (!p) {
        continue;
      }
      if (p.type === "text" && typeof p.text === "string") {
        texts.push(p.text);
      } else if (p.type === "toolCall" && typeof p.name === "string") {
        toolNames.push(p.name);
      }
      // {type:'thinking'} is dropped; {type:'image'} on toolResults is dropped.
    }
    if (role === "user") {
      const body = texts.join("\n").trim();
      if (body.length > 0) {
        raw.push({ role: "user", content: body });
      } else {
        skipped += 1;
      }
    } else if (role === "assistant") {
      if (model === "" && typeof message.model === "string") {
        model = message.model; // the foreign transcript stores the model INSIDE message (sibling to content)
      }
      const body = [texts.join("\n").trim(), toolAnnotation(toolNames)].filter((part) => part.length > 0).join("\n");
      if (body.length > 0) {
        raw.push({ role: "assistant", content: body });
      } else {
        skipped += 1;
      }
    } else {
      // role:'toolResult' (or unknown) — foreign tool OUTPUT, not a turn. Drop.
      skipped += 1;
    }
  }

  const messages = mergeConsecutive(raw);
  return {
    harness: "pi",
    sourceLabel: model ? `Pi · ${model}` : "Pi",
    title: titleFrom(messages),
    createdAt: createdAt || new Date(0).toISOString(),
    messages,
    skipped: Math.max(0, skipped)
  };
}

// ---------------------------------------------------------------------------
// Discovery — locate the most recently ACTIVE foreign session for this cwd
// ---------------------------------------------------------------------------

/** Claude project-dir slug: every non-alphanumeric char in the cwd → a dash. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/gu, "-");
}

/** Foreign-harness bucket dir: the cwd wrapped in `--`, every path separator → a dash. */
export function piBucketName(cwd: string): string {
  return `--${cwd.replace(/[:\\/]/gu, "-")}--`;
}

function newestJsonlIn(dir: string): string | null {
  if (!existsSync(dir)) {
    return null;
  }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".jsonl")) {
      continue;
    }
    const path = join(dir, entry);
    try {
      const mtimeMs = statSync(path).mtimeMs;
      if (!best || mtimeMs > best.mtimeMs) {
        best = { path, mtimeMs };
      }
    } catch {
      // unreadable entry — skip
    }
  }
  return best?.path ?? null;
}

/** Newest .jsonl across every immediate subdirectory of `root` (the scan-all fallback). */
function newestJsonlUnder(root: string): string | null {
  if (!existsSync(root)) {
    return null;
  }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const entry of readdirSync(root)) {
    const sub = join(root, entry);
    try {
      if (!statSync(sub).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    const candidate = newestJsonlIn(sub);
    if (candidate) {
      try {
        const mtimeMs = statSync(candidate).mtimeMs;
        if (!best || mtimeMs > best.mtimeMs) {
          best = { path: candidate, mtimeMs };
        }
      } catch {
        // skip
      }
    }
  }
  return best?.path ?? null;
}

export interface DiscoveryContext {
  readonly home?: string;
  readonly cwd: string;
}

/**
 * The most-recently-active foreign session file for this cwd, or null. Tries the
 * exact cwd-mapped directory first, then falls back to scanning ALL of the
 * harness's session buckets (the cwd may not match — foreign harnesses bucket by the dir
 * the harness was launched from, which can differ from guru's cwd).
 */
export function discoverLatestSession(harness: ForeignHarness, ctx: DiscoveryContext): string | null {
  const home = ctx.home ?? homedir();
  if (harness === "claude") {
    const root = join(home, ".claude", "projects");
    return newestJsonlIn(join(root, claudeProjectSlug(ctx.cwd))) ?? newestJsonlUnder(root);
  }
  const root = join(home, ".pi", "agent", "sessions");
  return newestJsonlIn(join(root, piBucketName(ctx.cwd))) ?? newestJsonlUnder(root);
}

// ---------------------------------------------------------------------------
// Redaction — foreign content is untrusted; strip secret shapes before persist
// ---------------------------------------------------------------------------

function redactConversation(messages: readonly ImportedMessage[]): {
  readonly messages: readonly ImportedMessage[];
  readonly redactedMessages: number;
  readonly kinds: readonly string[];
} {
  const kinds = new Set<string>();
  let redactedMessages = 0;
  const out = messages.map((message) => {
    const { text, matched } = scrubSecretValuesReport(message.content);
    if (matched.length > 0) {
      redactedMessages += 1;
      for (const kind of matched) {
        kinds.add(kind);
      }
    }
    return { role: message.role, content: text };
  });
  return { messages: out, redactedMessages, kinds: [...kinds] };
}

// ---------------------------------------------------------------------------
// Orchestration — read → map → redact → persist as a durable guru session
// ---------------------------------------------------------------------------

export interface ImportOptions {
  readonly cwd: string;
  readonly home?: string;
  /** An explicit transcript path; when set, discovery is skipped. */
  readonly path?: string;
  /** Guru's system prompt — injected as message[0] so the resumed session is well-formed. */
  readonly systemPrompt: string;
  /** New guru session id factory (tests). Defaults to crypto.randomUUID. */
  readonly newId?: () => string;
  /** Ceiling on transcript bytes read (defensive — foreign transcripts can reach 100MB+). */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024; // 64 MB

/**
 * Import the latest (or an explicit) foreign session into a NEW durable guru
 * session and return the reconstructed view for `switchToSession`. Read-only:
 * nothing from the transcript is executed.
 */
export function importExternalSession(harness: ForeignHarness, store: SessionLogStore, options: ImportOptions): ImportResult {
  const path = options.path ?? discoverLatestSession(harness, { cwd: options.cwd, ...(options.home ? { home: options.home } : {}) });
  if (!path) {
    return { ok: false, reason: `no ${harness === "pi" ? "Pi" : "Claude Code"} session found for this machine (looked under ${harness === "pi" ? "~/.pi/agent/sessions" : "~/.claude/projects"}).` };
  }
  if (!existsSync(path)) {
    return { ok: false, reason: `transcript not found: ${path}` };
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let text: string;
  try {
    const size = statSync(path).size;
    if (size > maxBytes) {
      return { ok: false, reason: `transcript is ${(size / 1_048_576).toFixed(0)}MB (> ${(maxBytes / 1_048_576).toFixed(0)}MB import ceiling); open it directly instead.` };
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { ok: false, reason: `could not read ${path}: ${(error as Error).message}` };
  }

  const conversation = harness === "claude" ? mapClaudeTranscript(text) : mapPiTranscript(text);
  if (conversation.messages.length === 0) {
    return { ok: false, reason: `no importable turns in ${path} (the transcript had only bookkeeping/tool lines).` };
  }

  const redacted = redactConversation(conversation.messages);

  // The banner + title also embed foreign-controlled strings (the source label
  // carries the foreign transcript's `message.model` field; the title is drawn from message text; the
  // path is machine-derived but printed alongside). The store only scrubs
  // REGISTERED values at the disk boundary, so shape-scrub these surfaces here too
  // — no foreign secret-shaped value may reach the durable log via metadata.
  const safeLabel = scrubSecretValues(conversation.sourceLabel);
  const safePath = scrubSecretValues(path);
  const safeTitle = scrubSecretValues(conversation.title);

  const banner =
    `Imported from ${safeLabel} — ${safePath}. ` +
    `${redacted.messages.length} message(s)` +
    (redacted.redactedMessages > 0 ? `, ${redacted.redactedMessages} redacted for secret-shaped values (${redacted.kinds.join(", ")})` : "") +
    `. Read-only import: nothing from the other harness was re-executed. Continue the conversation from here.`;

  const mkId = options.newId ?? randomUUID;
  const newId = mkId();
  store.appendMeta(newId, {
    title: `[${harness}] ${safeTitle}`,
    routeId: null,
    modelIdOverride: null,
    createdAt: conversation.createdAt
  });
  // message[0] = guru's system prompt + the provenance banner, so the resumed
  // history is well-formed (the model keeps its instructions) and self-documenting.
  store.appendMessage(newId, { role: "system", content: `${options.systemPrompt}\n\n${banner}`, mode: "normal" });
  for (const message of redacted.messages) {
    store.appendMessage(newId, { role: message.role, content: message.content, mode: "normal" });
  }

  const session = store.load(newId);
  if (!session) {
    return { ok: false, reason: `failed to persist the imported session (${newId}).` };
  }
  return {
    ok: true,
    session,
    summary: {
      harness,
      sourceLabel: safeLabel,
      sourcePath: safePath,
      imported: redacted.messages.length,
      skipped: conversation.skipped,
      redactedMessages: redacted.redactedMessages,
      redactionKinds: redacted.kinds
    }
  };
}
