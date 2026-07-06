import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

/**
 * Persisted session counter (Boot Ritual wave). A monotonically increasing count
 * of boots, incremented once per wake, stored atomically at
 * ~/.guruharness/session-count.json. It gives the knowledge flywheel a REAL
 * session clock (retiring the v0.16 days-proxy) and powers "last worn N sessions
 * ago" in the garage-inspection phase.
 */

const SUBPATH = join(".guruharness", "session-count.json");

const SessionCountSchema = z.object({ count: z.number().int().nonnegative(), updatedAt: z.string() }).strict();

export interface SessionCounterOptions {
  /** Override the state file directory (tests). Defaults to the home dir. */
  readonly directory?: string;
  readonly now?: () => Date;
}

function counterPath(options: SessionCounterOptions): string {
  return options.directory ? join(options.directory, "session-count.json") : join(homedir(), SUBPATH);
}

/** Read the current session number (0 when never booted). */
export function readSessionCounter(options: SessionCounterOptions = {}): number {
  const path = counterPath(options);
  if (!existsSync(path)) {
    return 0;
  }
  try {
    const parsed = SessionCountSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data.count : 0;
  } catch {
    return 0;
  }
}

/** Increment and persist (atomic tmp+rename). Returns the NEW session number. */
export function incrementSessionCounter(options: SessionCounterOptions = {}): number {
  const now = options.now ?? (() => new Date());
  const path = counterPath(options);
  const dir = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
  const next = readSessionCounter(options) + 1;
  try {
    if (dir.length > 0 && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ count: next, updatedAt: now().toISOString() }), "utf8");
    renameSync(tmp, path);
  } catch {
    // A failure to persist must never break boot — the in-memory number still advances.
  }
  return next;
}
