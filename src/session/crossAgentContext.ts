import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { scrubSecretValues } from "../safety/secretSafety.js";

/**
 * Durable summaries exchanged when a session changes agents. Entries are either
 * shared with every subsequent agent or private to the agent that created them.
 * Secret values are scrubbed at both the append and read boundaries.
 */
export const CrossAgentContextEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    agentId: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    scope: z.enum(["shared", "agent"]),
    createdAt: z.string().trim().min(1)
  })
  .strict();

export type CrossAgentContextEntry = z.infer<typeof CrossAgentContextEntrySchema>;
export type CrossAgentContextScope = CrossAgentContextEntry["scope"];

export interface CrossAgentContextStore {
  readonly directory: string;
  append(agentId: string, summary: string, options?: { readonly scope?: CrossAgentContextScope }): CrossAgentContextEntry;
  loadForAgent(agentId: string): readonly CrossAgentContextEntry[];
}

export interface CrossAgentContextStoreOptions {
  /** Base directory override (tests). Defaults to ~/.guruharness/cross-agent-context. */
  readonly directory?: string;
  readonly now?: () => Date;
}

const DEFAULT_SUBDIR = join(".guruharness", "cross-agent-context");
const CONTEXT_FILE = "context.jsonl";

export function resolveCrossAgentContextDirectory(options: CrossAgentContextStoreOptions = {}): string {
  return options.directory ?? join(homedir(), DEFAULT_SUBDIR);
}

/** Create the local-only append log used to resume a session under another agent. */
export function createCrossAgentContextStore(options: CrossAgentContextStoreOptions = {}): CrossAgentContextStore {
  const directory = resolveCrossAgentContextDirectory(options);
  const now = options.now ?? (() => new Date());
  const file = join(directory, CONTEXT_FILE);

  const readEntries = (): CrossAgentContextEntry[] => {
    if (!existsSync(file)) {
      return [];
    }
    const entries: CrossAgentContextEntry[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const parsed = CrossAgentContextEntrySchema.safeParse(JSON.parse(line));
        if (parsed.success) {
          entries.push({ ...parsed.data, summary: scrubSecretValues(parsed.data.summary) });
        }
      } catch {
        // A torn or malformed append must not block later valid context.
      }
    }
    return entries;
  };

  return {
    directory,
    append(agentId, summary, appendOptions = {}) {
      const entry = CrossAgentContextEntrySchema.parse({
        schemaVersion: 1,
        agentId,
        summary: scrubSecretValues(summary),
        scope: appendOptions.scope ?? "shared",
        createdAt: now().toISOString()
      });
      if (!existsSync(directory)) {
        mkdirSync(directory, { recursive: true });
      }
      appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
      return entry;
    },
    loadForAgent(agentId) {
      const normalizedAgentId = z.string().trim().min(1).parse(agentId);
      return readEntries().filter((entry) => entry.scope === "shared" || entry.agentId === normalizedAgentId);
    }
  };
}
