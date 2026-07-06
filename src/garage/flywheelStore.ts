import type { FileMemoryStore } from "../memory/store.js";
import { LearningSchema, type Learning } from "./flywheel.js";

/**
 * Flywheel persistence (Flywheel wave) — typed learnings ride the memory organ,
 * one fact per learning (`learning` type), reusing its atomic scrubbed writes and
 * `.trash/` soft-delete. The learning id is a deterministic hash, so re-storing
 * the same learning updates its fact in place (idempotent). Learnings are
 * EXCLUDED from the general boot index and injected separately, decay-ranked
 * (see memory/inject.ts).
 */

export const LEARNING_FACT_PREFIX = "learning-";

export function learningFactName(id: string): string {
  return `${LEARNING_FACT_PREFIX}${id}`;
}

function renderBody(learning: Learning): string {
  return [
    `${learning.level} learning (${learning.scope}${learning.roleSlug ? `:${learning.roleSlug}` : ""}) — cited ${learning.citations.length}×.`,
    "",
    "```json",
    JSON.stringify(learning, null, 2),
    "```",
    "",
    `Evidence: ${learning.evidence || "—"}`
  ].join("\n");
}

function parseLearning(body: string): Learning | undefined {
  const match = /```json\n([\s\S]*?)\n```/u.exec(body);
  if (!match?.[1]) {
    return undefined;
  }
  try {
    const parsed = LearningSchema.safeParse(JSON.parse(match[1]));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Store (create or update-in-place) a learning as a `learning` memory fact. */
export function storeLearning(memory: FileMemoryStore, learning: Learning): string {
  const parsed = LearningSchema.parse(learning);
  const result = memory.remember({
    name: learningFactName(parsed.id),
    title: parsed.statement.slice(0, 120),
    description: `${parsed.level} · ${parsed.scope}${parsed.roleSlug ? `:${parsed.roleSlug}` : ""} · cited ${parsed.citations.length}× · ${parsed.validated ? "validated" : "self-gen"}`,
    body: renderBody(parsed),
    type: "learning",
    edit: "replace",
    confidence: parsed.confidence
  });
  return result.summary;
}

/** Load all stored learnings (optionally filtered by role slug). */
export function loadLearnings(memory: FileMemoryStore, roleSlug?: string): Learning[] {
  const learnings: Learning[] = [];
  for (const entry of memory.list()) {
    if (entry.fact.type !== "learning" || !entry.fact.name.startsWith(LEARNING_FACT_PREFIX)) {
      continue;
    }
    const learning = parseLearning(entry.body);
    if (learning && (roleSlug === undefined || learning.roleSlug === roleSlug)) {
      learnings.push(learning);
    }
  }
  return learnings;
}

/** Prune a learning to `.trash/` with a decay reason (DECAY stage). */
export function pruneLearning(memory: FileMemoryStore, id: string, reason: string): void {
  memory.forget({ name: learningFactName(id), reason });
}

/**
 * Fold legacy global-store learnings tagged for `roleSlug` into the role store
 * (Memory Scopes wave, §7). Before scopes, every role learning lived in the flat
 * global store; on first suit-up we move each one into its role namespace so the
 * suit's flywheel compounds in one place. Idempotent — a moved learning is no
 * longer in the source, so re-running is a no-op. Returns the count moved.
 */
export function migrateRoleLearnings(from: FileMemoryStore, to: FileMemoryStore, roleSlug: string): number {
  if (from.directory === to.directory) {
    return 0;
  }
  let moved = 0;
  for (const learning of loadLearnings(from, roleSlug)) {
    storeLearning(to, learning);
    pruneLearning(from, learning.id, `memory scopes: moved to role:${roleSlug}`);
    moved += 1;
  }
  return moved;
}
