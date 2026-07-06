import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import type { ChatTurnMessage } from "../model/directChat.js";
import { CompactionStateSchema } from "../compaction/schemas.js";
import { scrubRegisteredSecretValues } from "../safety/secretSafety.js";

/**
 * Local durable conversation store for `guru`.
 *
 * One JSON file per session under a USER/runtime dir (~/.guruharness/sessions/) —
 * NOT the repo (file-placement guardrail: runtime state is local, not canonical
 * source). Local-only; never transmitted. Message content may contain whatever the
 * user typed / the model returned, so these files live under the user's own home dir
 * and are the operator's data — the store adds no secret guards beyond that boundary.
 */

export const ConversationMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string()
  })
  .strict();

export const ConversationRecordSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    routeId: z.string().trim().min(1).nullable(),
    modelIdOverride: z.string().trim().min(1).nullable(),
    messages: z.array(ConversationMessageSchema),
    turnCount: z.number().int().nonnegative(),
    createdAt: z.string().trim().min(1),
    updatedAt: z.string().trim().min(1),
    /** Latest compaction state (Runtime Survival wave); absent until first compaction. */
    compaction: CompactionStateSchema.optional()
  })
  .strict();

export type ConversationRecord = z.infer<typeof ConversationRecordSchema>;

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly routeId: string | null;
  readonly turnCount: number;
  readonly updatedAt: string;
}

export interface ConversationStore {
  save(record: ConversationRecord): void;
  load(id: string): ConversationRecord | undefined;
  list(): readonly ConversationSummary[];
  readonly directory: string;
}

export interface ConversationStoreOptions {
  /** Base dir override (tests). Defaults to ~/.guruharness/sessions. */
  readonly directory?: string;
  readonly now?: () => Date;
}

const DEFAULT_SUBDIR = join(".guruharness", "sessions");

export function resolveStoreDirectory(options: ConversationStoreOptions = {}): string {
  return options.directory ?? join(homedir(), DEFAULT_SUBDIR);
}

export function createConversationStore(options: ConversationStoreOptions = {}): ConversationStore {
  const directory = resolveStoreDirectory(options);

  const ensureDir = (): void => {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
  };

  const store: ConversationStore = {
    directory,
    save(record) {
      ensureDir();
      const parsed = ConversationRecordSchema.parse(record);
      // Transcript secret-scrub (FR-21, 2026-07-04): a credential value the harness
      // RESOLVED this session must never persist to disk. Registered-values only —
      // shape patterns are not applied here because operators may legitimately
      // discuss token formats in conversation.
      const safe: typeof parsed = {
        ...parsed,
        title: scrubRegisteredSecretValues(parsed.title),
        messages: parsed.messages.map((message) => ({ ...message, content: scrubRegisteredSecretValues(message.content) })),
        // Compaction summaries are scrubbed in the engine too; scrub again at the
        // disk boundary (defense in depth — same rule as message content). File
        // paths get the same treatment: a path can embed a resolved value.
        ...(parsed.compaction
          ? {
              compaction: {
                ...parsed.compaction,
                summary: scrubRegisteredSecretValues(parsed.compaction.summary),
                details: {
                  readFiles: parsed.compaction.details.readFiles.map((file) => scrubRegisteredSecretValues(file)),
                  modifiedFiles: parsed.compaction.details.modifiedFiles.map((file) => scrubRegisteredSecretValues(file))
                }
              }
            }
          : {})
      };
      writeFileSync(join(directory, `${sanitizeId(safe.id)}.json`), JSON.stringify(safe, null, 2), "utf8");
    },
    load(id) {
      const file = join(directory, `${sanitizeId(id)}.json`);
      if (!existsSync(file)) {
        return undefined;
      }
      try {
        const parsed = ConversationRecordSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));

        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    },
    list() {
      if (!existsSync(directory)) {
        return [];
      }
      const records: ConversationRecord[] = [];
      for (const entry of readdirSync(directory)) {
        if (!entry.endsWith(".json")) {
          continue;
        }
        try {
          const parsed = ConversationRecordSchema.safeParse(JSON.parse(readFileSync(join(directory, entry), "utf8")));
          if (parsed.success) {
            records.push(parsed.data);
          }
        } catch {
          // Skip unreadable/corrupt records rather than failing the whole list.
        }
      }

      return records
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((record) => ({
          id: record.id,
          title: record.title,
          routeId: record.routeId,
          turnCount: record.turnCount,
          updatedAt: record.updatedAt
        }));
    }
  };

  return store;
}

/** Derive a short human title from the first user message. */
export function deriveConversationTitle(messages: readonly ChatTurnMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  const raw = firstUser?.content.trim().replace(/\s+/gu, " ") ?? "";
  if (raw.length === 0) {
    return "Untitled session";
  }

  return raw.length > 60 ? `${raw.slice(0, 57)}...` : raw;
}

/** Session ids are UUID-ish; keep the filename to a safe charset regardless. */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/gu, "_");
}
