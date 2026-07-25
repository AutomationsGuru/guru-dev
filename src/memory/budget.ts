import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

/**
 * Global memory size budget (IDEA-E1, R-CC-MEM + R-AS-MEM).
 *
 * Memory that only grows is not intelligence; it is future confusion — and an
 * UNBOUNDED memory directory is a quiet disk/leanness failure. This module is
 * the structural byte budget for a memory store: it measures the on-disk bytes
 * a memory directory holds and reports headroom against a hard ceiling, so a
 * writer can be told "you are at the cap — prune or stow before you add more"
 * instead of the store silently accreting forever.
 *
 * This module only MEASURES and REPORTS. The enforcement choke point lives in
 * the caller (the write path checks `evaluateMemoryBudget` before committing a
 * new fact); keeping this module pure of writes keeps it unit-testable and lets
 * different scopes apply the same policy.
 */

export const MemoryBudgetSchema = z
  .object({
    /** Hard ceiling on total fact bytes in the directory. Default 1 MiB. */
    maxBytes: z.number().int().positive().max(64 * 1024 * 1024).default(1024 * 1024),
    /** Soft warning threshold as a fraction of maxBytes (0–1). Default 0.8. */
    warnAtFraction: z.number().min(0).max(1).default(0.8)
  })
  .strict();
export type MemoryBudget = z.infer<typeof MemoryBudgetSchema>;

export const DEFAULT_MEMORY_BUDGET: MemoryBudget = MemoryBudgetSchema.parse({});

export const MemoryBudgetStatusSchema = z.enum(["ok", "warn", "exceeded"]);
export type MemoryBudgetStatus = z.infer<typeof MemoryBudgetStatusSchema>;

export const MemoryBudgetReportSchema = z
  .object({
    directory: z.string().trim().min(1),
    /** Total bytes of durable fact files (excludes .trash and the derived index). */
    usedBytes: z.number().int().nonnegative(),
    /** Bytes inside .trash (recoverable; counted separately so GC frees real headroom). */
    trashBytes: z.number().int().nonnegative(),
    factFiles: z.number().int().nonnegative(),
    budget: MemoryBudgetSchema,
    status: MemoryBudgetStatusSchema,
    /** Bytes of headroom before the hard ceiling (0 when exceeded). */
    headroomBytes: z.number().int().nonnegative(),
    summary: z.string().trim().min(1)
  })
  .strict();
export type MemoryBudgetReport = z.infer<typeof MemoryBudgetReportSchema>;

const TRASH_DIR = ".trash";
const INDEX_FILE = "MEMORY.md";

function sumMarkdownBytes(directory: string): { bytes: number; files: number } {
  if (!existsSync(directory)) {
    return { bytes: 0, files: 0 };
  }
  let bytes = 0;
  let files = 0;
  for (const file of readdirSync(directory)) {
    const path = join(directory, file);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    bytes += stat.size;
    files += 1;
  }
  return { bytes, files };
}

/**
 * Measure a memory directory against the budget. Durable fact bytes are the
 * top-level `*.md` files EXCLUDING the derived `MEMORY.md` index (rebuilt, not
 * stored knowledge) and excluding `.trash/` (soft-deleted, recoverable — counted
 * on its own so a GC sweep is visible as reclaimed headroom).
 */
export function evaluateMemoryBudget(directory: string, budget: Partial<MemoryBudget> = {}): MemoryBudgetReport {
  const parsedBudget = MemoryBudgetSchema.parse(budget);
  let usedBytes = 0;
  let factFiles = 0;
  if (existsSync(directory)) {
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".md") || file === INDEX_FILE) {
        continue;
      }
      try {
        const stat = statSync(join(directory, file));
        if (stat.isFile()) {
          usedBytes += stat.size;
          factFiles += 1;
        }
      } catch {
        // unreadable entries are skipped, not fatal
      }
    }
  }
  const trash = sumMarkdownBytes(join(directory, TRASH_DIR));
  const headroomBytes = Math.max(0, parsedBudget.maxBytes - usedBytes);
  const warnBytes = Math.floor(parsedBudget.maxBytes * parsedBudget.warnAtFraction);
  const status: MemoryBudgetStatus = usedBytes > parsedBudget.maxBytes ? "exceeded" : usedBytes >= warnBytes ? "warn" : "ok";
  const summary =
    status === "exceeded"
      ? `Memory budget EXCEEDED: ${usedBytes}B of durable facts over the ${parsedBudget.maxBytes}B ceiling — prune or stow before adding more.`
      : status === "warn"
        ? `Memory budget warning: ${usedBytes}B of ${parsedBudget.maxBytes}B used (${headroomBytes}B headroom) — consider pruning or stowing.`
        : `Memory budget ok: ${usedBytes}B of ${parsedBudget.maxBytes}B used (${headroomBytes}B headroom).`;
  return MemoryBudgetReportSchema.parse({
    directory,
    usedBytes,
    trashBytes: trash.bytes,
    factFiles,
    budget: parsedBudget,
    status,
    headroomBytes,
    summary
  });
}

/**
 * The write-path check: would committing `additionalBytes` keep the directory
 * inside the hard ceiling? Returns the report plus a boolean so the caller can
 * refuse the write with evidence rather than discover the overflow after.
 */
export function wouldExceedBudget(
  directory: string,
  additionalBytes: number,
  budget: Partial<MemoryBudget> = {}
): { readonly allowed: boolean; readonly report: MemoryBudgetReport } {
  const parsedBudget = MemoryBudgetSchema.parse(budget);
  const report = evaluateMemoryBudget(directory, parsedBudget);
  const allowed = report.usedBytes + Math.max(0, additionalBytes) <= parsedBudget.maxBytes;
  return { allowed, report };
}
