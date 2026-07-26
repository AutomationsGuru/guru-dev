import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import type { LearnedFact } from "./learn.js";
import type { TaskOutcomeHistory } from "./selectTask.js";

/**
 * Outcome persistence store (self-build hardening #12) — reads/writes
 * `<cwd>/.guru/task-outcomes.json` so the LEARN→SELECT feedback arc closes
 * across invocations.  Each run seeds its in-memory history from disk and
 * flushes learned facts back so the next run knows what was shipped or blocked.
 */

const SCHEMA_VERSION = 1 as const;

interface OutcomeStoreJson {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly completed: readonly string[];
  readonly recentBlockers: readonly string[];
  readonly updatedAt: string;
}

export interface TaskOutcomeStore {
  /** Read the persisted history.  Missing / corrupt → empty. */
  load(): Promise<TaskOutcomeHistory>;
  /** Record one fact (shipped → completed, blocked → recentBlockers) in memory. */
  recordFact(fact: LearnedFact): void;
  /** Write current in-memory state to disk. */
  flush(): Promise<void>;
}

function storePath(cwd: string): string {
  return join(resolve(cwd), ".guru", "task-outcomes.json");
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

export function createTaskOutcomeStore(cwd: string): TaskOutcomeStore {
  const completed = new Set<string>();
  const recentBlockers = new Set<string>();
  let dirty = false;

  async function load(): Promise<TaskOutcomeHistory> {
    const filePath = storePath(cwd);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      // Missing file → empty store.
      return { completed: new Set<string>(), recentBlockers: new Set<string>() };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      console.error(`[outcomeStore] unparseable ${filePath} — starting with empty store`);
      return { completed: new Set<string>(), recentBlockers: new Set<string>() };
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("schemaVersion" in parsed) ||
      (parsed as { schemaVersion: unknown }).schemaVersion !== SCHEMA_VERSION
    ) {
      console.error(`[outcomeStore] unknown schema version in ${filePath} — starting with empty store`);
      return { completed: new Set<string>(), recentBlockers: new Set<string>() };
    }

    const store = parsed as OutcomeStoreJson;
    if (!Array.isArray(store.completed) || !Array.isArray(store.recentBlockers)) {
      console.error(`[outcomeStore] malformed completed/recentBlockers in ${filePath} — starting with empty store`);
      return { completed: new Set<string>(), recentBlockers: new Set<string>() };
    }

    for (const id of store.completed) {
      completed.add(id);
    }
    for (const id of store.recentBlockers) {
      recentBlockers.add(id);
    }
    return { completed: new Set(completed), recentBlockers: new Set(recentBlockers) };
  }

  function recordFact(fact: LearnedFact): void {
    dirty = true;
    if (fact.outcome === "shipped") {
      completed.add(fact.taskId);
    } else {
      recentBlockers.add(fact.taskId);
    }
  }

  async function flush(): Promise<void> {
    if (!dirty) {
      return;
    }
    const filePath = storePath(cwd);
    await ensureDir(join(filePath, ".."));
    const json: OutcomeStoreJson = {
      schemaVersion: SCHEMA_VERSION,
      completed: [...completed].sort(),
      recentBlockers: [...recentBlockers].sort(),
      updatedAt: new Date().toISOString()
    };
    await writeFile(filePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
    dirty = false;
  }

  return { load, recordFact, flush };
}