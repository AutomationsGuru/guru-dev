import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

/**
 * Scout report artifact (IDEA-A2, 2026-07-18) — the durable evidence a scout MUST
 * leave behind. A scout's dispatch is not "done" until a report with an objective,
 * evidence references, risks, and a recommended next move exists under the project
 * or session store. This module owns the schema, the on-disk layout, and the
 * structural validation the manager uses to fail closed when a report is missing
 * or malformed.
 *
 * Layout: one JSON file per report under a scouts/ directory. The default root is
 * the user runtime dir (~/.guruharness/scouts); a sessionId scopes it per session;
 * a directory override (tests) targets the project/session store directly. Presence
 * of the FILE is necessary but not sufficient — the artifact must also parse and
 * carry all four required sections, so a truncated/garbage write still fails closed.
 */

export const ScoutReportSchema = z
  .object({
    /** Stable id, matches the spawned task id. */
    taskId: z.string().trim().min(1),
    /** What the scout was sent to find out. */
    objective: z.string().trim().min(1),
    /** Evidence references (paths, ids, URLs, tool outputs) backing the findings. */
    evidenceRefs: z.array(z.string().trim().min(1)),
    /** Risks / unknowns the scout surfaced. */
    risks: z.array(z.string().trim().min(1)),
    /** The recommended next move (never "cannot proceed" without a stated move). */
    recommendedNext: z.string().trim().min(1),
    /** ISO timestamp the report was finalized. */
    completedAt: z.string().trim().min(1).optional()
  })
  .strict();

export type ScoutReport = z.infer<typeof ScoutReportSchema>;

export interface ScoutReportStoreOptions {
  /** Base dir override (tests / project store). Defaults to ~/.guruharness/scouts. */
  readonly directory?: string;
  /** Scope the reports under a per-session subdirectory. */
  readonly sessionId?: string;
}

export interface ScoutReportStore {
  readonly directory: string;
  /** Persist a validated report; returns the durable path recorded on the task. */
  save(report: ScoutReport): string;
  /** The durable path a report for this task WOULD live at (for completion refs). */
  reportPath(taskId: string): string;
  /**
   * Structural fail-closed check: does a VALID report exist for this task?
   * False when the file is absent, unreadable, or fails schema validation — a
   * partial artifact never satisfies completion.
   */
  hasValidReport(taskId: string): boolean;
  /** Read + validate a report, or undefined when absent/invalid. */
  read(taskId: string): ScoutReport | undefined;
}

const DEFAULT_SUBDIR = join(".guruharness", "scouts");

function sanitizeId(id: string): string {
  // Keep the on-disk name safe and reversible enough to locate by task id. Strip
  // path separators AND dot-segments so a hostile id can never traverse out of the
  // store directory (`..` / `.` are not valid on-disk name components here).
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/gu, "_");
  // Collapse any run that is only dots/underscores left over from separators, and
  // guarantee a non-empty, non-dot name.
  const safe = cleaned.replace(/^[_]+/u, "");
  return safe.length > 0 ? safe : "report";
}

function resolveDirectory(options: ScoutReportStoreOptions): string {
  const base = options.directory ?? join(homedir(), DEFAULT_SUBDIR);
  return options.sessionId ? join(base, sanitizeId(options.sessionId)) : base;
}

export function createScoutReportStore(options: ScoutReportStoreOptions = {}): ScoutReportStore {
  const directory = resolveDirectory(options);

  const pathFor = (taskId: string): string => join(directory, `${sanitizeId(taskId)}.json`);

  return {
    directory,
    save(report) {
      const parsed = ScoutReportSchema.parse(report);
      if (!existsSync(directory)) {
        mkdirSync(directory, { recursive: true });
      }
      const path = pathFor(parsed.taskId);
      writeFileSync(path, JSON.stringify(parsed, null, 2), "utf8");
      return path;
    },
    reportPath(taskId) {
      return pathFor(taskId);
    },
    hasValidReport(taskId) {
      return this.read(taskId) !== undefined;
    },
    read(taskId) {
      const path = pathFor(taskId);
      if (!existsSync(path)) {
        return undefined;
      }
      try {
        const parsed = ScoutReportSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined; // unreadable / non-JSON — fail closed
      }
    }
  };
}
