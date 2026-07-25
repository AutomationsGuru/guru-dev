import type { FileMemoryStore } from "../memory/store.js";
import { SkillIdSchema } from "../skills/schemas.js";
import { z } from "zod";

/**
 * Skill promotion stages (IDEA-F164-SKILL-STAGE — K4 from the zagens review:
 * "draft→promote safe skill flywheel"). A skill is marked `draft` or
 * `promoted`; only `promoted` skills auto-load into the session catalog. The
 * stage store rides the memory organ as one JSON fact (atomic tmp+rename +
 * secret-scrub gate, reused from the garage spine), keyed by skill id.
 *
 * Scope of this module: the stage store itself — set/get/list — nothing more.
 * The auto-load wiring into the session catalog consumes `listPromoted` and is
 * owned elsewhere.
 */

export const SkillStageSchema = z.enum(["draft", "promoted"]);
export type SkillStage = z.infer<typeof SkillStageSchema>;

export const SkillStageRecordSchema = z
  .object({
    id: SkillIdSchema,
    stage: SkillStageSchema,
    updatedAt: z.string().min(1)
  })
  .strict();
export type SkillStageRecord = z.infer<typeof SkillStageRecordSchema>;

export const SKILL_STAGE_FACT_NAME = "skill-promotion-stages";

function extractJsonBlock(body: string): string | undefined {
  return /```json\n([\s\S]*?)\n```/u.exec(body)?.[1];
}

/** Load the persisted stage records (empty when none or malformed). */
export function loadSkillStages(memory: FileMemoryStore): SkillStageRecord[] {
  const fact = memory.get(SKILL_STAGE_FACT_NAME);
  if (!fact.found || !fact.body) {
    return [];
  }
  const raw = extractJsonBlock(fact.body);
  if (!raw) {
    return [];
  }
  try {
    return z_array_safe(JSON.parse(raw));
  } catch {
    return [];
  }
}

function z_array_safe(value: unknown): SkillStageRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const records: SkillStageRecord[] = [];
  for (const entry of value) {
    const parsed = SkillStageRecordSchema.safeParse(entry);
    if (parsed.success) {
      records.push(parsed.data);
    }
  }
  return records;
}

/** Persist stage records as one JSON memory fact (atomic write via the organ). */
export function saveSkillStages(memory: FileMemoryStore, records: readonly SkillStageRecord[]): void {
  const promoted = records.filter((r) => r.stage === "promoted").length;
  const body = [
    `${records.length} skill stage record(s) — ${promoted} promoted, ${records.length - promoted} draft. Only promoted skills auto-load into the session catalog.`,
    "",
    "```json",
    JSON.stringify(records, null, 2),
    "```"
  ].join("\n");
  memory.remember({
    name: SKILL_STAGE_FACT_NAME,
    title: "Skill promotion stages",
    description: `${promoted} promoted / ${records.length} tracked skill stage(s)`,
    body,
    type: "capability",
    edit: "replace",
    confidence: 1
  });
}

/**
 * Set a skill's stage, upserting by id. Returns the persisted record. `now` is
 * injectable for deterministic tests (mirrors `loadManifest`'s signature).
 */
export function setStage(
  memory: FileMemoryStore,
  id: string,
  stage: SkillStage,
  now: () => Date = () => new Date()
): SkillStageRecord {
  const validId = SkillIdSchema.parse(id);
  const record: SkillStageRecord = {
    id: validId,
    stage,
    updatedAt: now().toISOString()
  };
  const existing = loadSkillStages(memory);
  const byId = new Map(existing.map((r) => [r.id, r]));
  byId.set(validId, record);
  saveSkillStages(memory, [...byId.values()]);
  return record;
}

/**
 * Get a skill's stage. Returns `undefined` for a never-set skill — treat that as
 * effectively `draft` when filtering (an unset skill never auto-loads). The
 * explicit `undefined` lets callers distinguish "unset" from "deliberately
 * drafted" if they ever need to.
 */
export function getStage(memory: FileMemoryStore, id: string): SkillStage | undefined {
  const validId = SkillIdSchema.safeParse(id);
  if (!validId.success) {
    return undefined;
  }
  return loadSkillStages(memory).find((r) => r.id === validId.data)?.stage;
}

/** Convenience: is this skill promoted (and thus auto-loadable)? */
export function isPromoted(memory: FileMemoryStore, id: string): boolean {
  return getStage(memory, id) === "promoted";
}

/** Skill ids whose stage is `promoted`, sorted ascending. */
export function listPromoted(memory: FileMemoryStore): readonly string[] {
  return loadSkillStages(memory)
    .filter((r) => r.stage === "promoted")
    .map((r) => r.id)
    .sort();
}
