import type { FileMemoryStore } from "../memory/store.js";
import { GapRecordSchema, type GapRecord } from "./manifest.js";

/**
 * Gap records + machine-evaluable triggers (Boot Ritual wave). The GapRecord type
 * shipped stubbed in v0.15; this makes the trigger evaluable via a small
 * presence mini-language and persists records so Phase 4 of the boot ritual can
 * re-evaluate them every wake — a satisfied trigger CLOSES the record (the
 * anti-obsolescence loop, §11). Records ride the memory organ as one JSON fact.
 */

export interface GapTriggerProbe {
  /** Is a tool with this id registered this session? */
  readonly toolPresent: (id: string) => boolean;
  /** Is this command on PATH (presence only)? */
  readonly cmdPresent: (name: string) => boolean;
}

/**
 * Evaluate a gap record's trigger. Grammar (presence only):
 *   tool:<id>  → a native tool now covers it
 *   cmd:<name> → a command is on PATH
 *   always     → always satisfied
 *   (empty)    → never auto-closes (manual only)
 */
export function evaluateGapTrigger(trigger: string, probe: GapTriggerProbe): boolean {
  const value = trigger.trim();
  if (value === "always") return true;
  if (value.startsWith("tool:")) return probe.toolPresent(value.slice("tool:".length).trim());
  if (value.startsWith("cmd:")) return probe.cmdPresent(value.slice("cmd:".length).trim());
  return false;
}

/** The closing condition for an unmet need: a native tool covering it now exists. */
export function deriveTrigger(need: string): string {
  const slug = need.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48);
  return `tool:${slug.length > 0 ? slug : "capability"}`;
}

export function makeGapRecord(need: string, move: GapRecord["move"], note: string, createdAt: string): GapRecord {
  return GapRecordSchema.parse({
    id: `gap-${need.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40) || "cap"}`,
    capability: need,
    move,
    note,
    trigger: deriveTrigger(need),
    createdAt
  });
}

const GAP_FACT_NAME = "gap-records";

function extractJson(body: string): string | undefined {
  return /```json\n([\s\S]*?)\n```/u.exec(body)?.[1];
}

/** Load the persisted gap records (empty when none). */
export function loadGapRecords(memory: FileMemoryStore): GapRecord[] {
  const fact = memory.get(GAP_FACT_NAME);
  if (!fact.found || !fact.body) {
    return [];
  }
  const raw = extractJson(fact.body);
  if (!raw) {
    return [];
  }
  try {
    const parsed = z_array_safe(JSON.parse(raw));
    return parsed;
  } catch {
    return [];
  }
}

function z_array_safe(value: unknown): GapRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const records: GapRecord[] = [];
  for (const entry of value) {
    const parsed = GapRecordSchema.safeParse(entry);
    if (parsed.success) {
      records.push(parsed.data);
    }
  }
  return records;
}

/** Persist gap records as one JSON memory fact (atomic + scrubbed by the organ). */
export function saveGapRecords(memory: FileMemoryStore, records: readonly GapRecord[]): void {
  const body = [
    `${records.length} open gap record(s) — each carries a presence trigger re-evaluated every boot.`,
    "",
    "```json",
    JSON.stringify(records, null, 2),
    "```"
  ].join("\n");
  memory.remember({
    name: GAP_FACT_NAME,
    title: "Gap records",
    description: `${records.length} open capability gap(s) with boot-evaluated triggers`,
    body,
    type: "capability",
    edit: "replace",
    confidence: 1
  });
}

export interface GapEvaluation {
  readonly open: GapRecord[];
  readonly closed: GapRecord[];
}

/** Re-evaluate every record's trigger; a satisfied trigger closes the record. */
export function evaluateAndClose(records: readonly GapRecord[], probe: GapTriggerProbe): GapEvaluation {
  const open: GapRecord[] = [];
  const closed: GapRecord[] = [];
  for (const record of records) {
    if (evaluateGapTrigger(record.trigger, probe)) {
      closed.push(record);
    } else {
      open.push(record);
    }
  }
  return { open, closed };
}

/** Merge new records into the set by id (upsert), keeping the earliest createdAt. */
export function upsertGapRecords(existing: readonly GapRecord[], incoming: readonly GapRecord[]): GapRecord[] {
  const byId = new Map(existing.map((record) => [record.id, record]));
  for (const record of incoming) {
    if (!byId.has(record.id)) {
      byId.set(record.id, record);
    }
  }
  return [...byId.values()];
}
