import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { commandExists } from "../review/gates.js";
import type { StageVerdict } from "./devCycle.js";

/**
 * SHIP stage (self-build P5) — deliver WITHOUT assuming any tool exists. Probe presence:
 * git present → commit/push (+ PR iff gh); git absent → write a DURABLE on-disk
 * change-record so a git-optional machine degrades to a legible YELLOW, never RED-by-absence.
 * The git delivery is injected (and, per the gap, must route through the runtime spend
 * gate — deploy verbs escalate); the local-record sink is real and injectable for tests.
 */

export const ChangeRecordSchema = z
  .object({
    taskId: z.string().trim().min(1).default("unnamed-task"),
    summary: z.string().default(""),
    overallVerdict: z.enum(["GREEN", "YELLOW", "RED"]).default("YELLOW"),
    stages: z
      .array(z.object({ stage: z.string(), verdict: z.string(), evidence: z.string() }).strict())
      .default([]),
    note: z.string().default("")
  })
  .strict();
export type ChangeRecord = z.infer<typeof ChangeRecordSchema>;

export type ShipTarget = "git" | "git+pr" | "local-record";

export interface ShipStageResult {
  readonly verdict: StageVerdict;
  readonly target: ShipTarget;
  readonly evidence: string;
  readonly recordPath?: string;
}

export interface GitDeliveryContext {
  readonly gitPresent: boolean;
  readonly ghPresent: boolean;
}

export interface ShipStageDeps {
  readonly cwd: string;
  /** What shipped — persisted verbatim into the change-record on the local-fallback path. */
  readonly payload: ChangeRecord;
  /** Presence probe (injectable); defaults to the real PATH probe. */
  readonly commandExists?: (name: string) => boolean;
  /** git commit/push/PR delivery — injected by the P5 wiring so it can route through the gate. */
  readonly gitDelivery?: (ctx: GitDeliveryContext) => Promise<ShipStageResult>;
  /** Change-record sink (injectable); defaults to writing JSON on disk. */
  readonly writeChangeRecord?: (record: ChangeRecord, path: string) => Promise<void> | void;
  /** Where local records go; defaults to `<cwd>/.guru/change-records`. */
  readonly changeRecordDir?: string;
}

function slugify(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "task";
}

export async function runShipStage(deps: ShipStageDeps): Promise<ShipStageResult> {
  const exists = deps.commandExists ?? commandExists;
  const gitPresent = exists("git");

  // git present + a delivery wired → real git ship (commit/push, PR iff gh).
  if (gitPresent && deps.gitDelivery) {
    return deps.gitDelivery({ gitPresent, ghPresent: exists("gh") });
  }

  // git absent (or delivery not wired) → durable on-disk change-record. Never RED-by-absence.
  const record = ChangeRecordSchema.parse(deps.payload);
  const dir = deps.changeRecordDir ?? join(deps.cwd, ".guru", "change-records");
  const recordPath = join(dir, `${slugify(record.taskId)}.json`);

  if (deps.writeChangeRecord) {
    await deps.writeChangeRecord(record, recordPath);
  } else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  const reason = gitPresent
    ? "git present but no delivery wired — wrote a durable on-disk change-record"
    : "git absent — degraded to a durable on-disk change-record (not RED-by-absence)";
  return { verdict: "YELLOW", target: "local-record", evidence: reason, recordPath };
}
