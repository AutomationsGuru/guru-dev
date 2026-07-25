import { z } from "zod";

import { LearningSchema, gateLearning, learningId, type Learning, type LearningLevel, type LearningScope } from "../garage/flywheel.js";
import { learningFactName, storeLearning } from "../garage/flywheelStore.js";
import type { FileMemoryStore } from "./store.js";
import { MemoryFactNameSchema, slugifyFactName } from "./schemas.js";

/**
 * Stow / park → garage (IDEA-E1, R-AS-STOW + R-AS-MEM).
 *
 * When work finishes, what it taught must be PARKED back at home base as a
 * typed, decay-ready learning artifact — not dumped as an untyped note, and
 * never dropped (amnesia drift). "Decay-ready" means the artifact carries the
 * full GATE field set the flywheel's decay clock, citation counter, and
 * promotion diagonal already operate on: level, scope, subject, polarity,
 * validated, confidence, citations, created/last-cited stamps, and the
 * session-anchored decay clock.
 *
 * The flow is EXTRACT-shaped → GATE → STORE:
 *   1. EXTRACT-shaped input (statement + evidence + subject + tools).
 *   2. GATE — `gateLearning` admits only actionable + specific + unique
 *      learnings; a duplicate or a too-vague statement is REFUSED, not stowed.
 *   3. STORE — the admitted learning is written through the memory organ as a
 *      `learning` fact (atomic, secret-scrubbed, idempotent by deterministic
 *      id), ready for decay-ranked injection and later citation/decay.
 *
 * This module owns shaping + the gate decision; the memory organ owns the
 * durable, scrubbed write. No learning is stowed unvalidated past the GATE.
 */

export const StowLearningInputSchema = z
  .object({
    /** The durable, actionable statement (what future sessions should know). */
    statement: z.string().trim().min(1).max(400),
    /** Grounded evidence for the statement (session/output reference). */
    evidence: z.string().default(""),
    /** Compression level the learning parks at. Default L1 (episodic). */
    level: z.enum(["L0", "L1", "L2", "L3"]).default("L1"),
    /** Scope the learning belongs to. */
    scope: z.enum(["global", "space", "role"]).default("global"),
    /** Role slug when scope is role. */
    roleSlug: z.string().trim().min(1).optional(),
    /** Subject key for conflict detection / supersession. Derived from statement when omitted. */
    subject: z.string().trim().min(1).optional(),
    polarity: z.enum(["affirm", "deny"]).default("affirm"),
    /** Tools this learning is about (drives CITE). */
    tools: z.array(z.string().min(1)).default([]),
    /**
     * Curated/validated learnings earn promotion weight; self-generated earn
     * none (the GATE). Stow accepts the caller's claim but records it — the
     * diagonal still refuses to promote unvalidated learnings.
     */
    validated: z.boolean().default(false),
    confidence: z.number().min(0).max(1).default(0.5),
    /** Current boot session number — stamps the learning's decay clock. */
    currentSession: z.number().int().nonnegative().default(0)
  })
  .strict();
/** Call-site input: fields with defaults may be omitted (parsed by schema). */
export type StowLearningInput = z.input<typeof StowLearningInputSchema>;

export const StowReceiptSchema = z
  .object({
    status: z.enum(["stowed", "refused", "updated"]),
    /** The learning id (deterministic hash) when stowed/updated. */
    learningId: z.string().trim().min(1).optional(),
    /** The memory fact name the learning was parked under. */
    factName: MemoryFactNameSchema.optional(),
    /** GATE outcome recorded on the receipt for audit. */
    gateReason: z.string().trim().min(1),
    summary: z.string().trim().min(1)
  })
  .strict();
export type StowReceipt = z.infer<typeof StowReceiptSchema>;

function normalizeSubject(statement: string, subject: string | undefined): string {
  if (subject && subject.trim().length > 0) {
    const slug = subject.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48);
    if (slug.length > 0) {
      return slug;
    }
  }
  return slugifyFactName(statement).slice(0, 48);
}

/** Shape stow input into a full, decay-ready Learning (all GATE fields present). */
export function shapeStowedLearning(rawInput: StowLearningInput, now: Date): Learning {
  const input = StowLearningInputSchema.parse(rawInput);
  const scope: LearningScope = input.scope;
  const level: LearningLevel = input.level;
  const stamp = now.toISOString();
  return LearningSchema.parse({
    id: learningId(scope, level, input.statement),
    scope,
    ...(input.roleSlug ? { roleSlug: input.roleSlug } : {}),
    level,
    statement: input.statement,
    evidence: input.evidence,
    subject: normalizeSubject(input.statement, input.subject),
    polarity: input.polarity,
    tools: [...input.tools],
    validated: input.validated,
    citations: [],
    createdAt: stamp,
    lastCitedAt: null,
    confidence: input.confidence,
    createdSession: input.currentSession,
    lastCitedSession: null
  });
}

/**
 * Stow a learning into the garage through the GATE. Existing stored learnings
 * are read first so the GATE's uniqueness check is real; an exact duplicate is
 * reported as `updated` (the deterministic id re-stores in place) rather than
 * admitted as new. Returns a receipt naming the gate outcome.
 */
export function stowLearning(
  memory: FileMemoryStore,
  rawInput: StowLearningInput,
  options: { readonly now?: () => Date; readonly existingIds?: ReadonlySet<string> } = {}
): StowReceipt {
  const now = options.now ?? (() => new Date());
  const learning = shapeStowedLearning(rawInput, now());

  // GATE: actionable + specific + unique. Pull existing ids from the store when
  // the caller didn't supply them, so the uniqueness check reflects reality.
  const existingIds = options.existingIds ?? new Set(memory.list()
    .filter((entry) => entry.fact.type === "learning")
    .map((entry) => entry.fact.name.slice(learningFactName("").length)));
  const gate = gateLearning(learning, existingIds);

  if (!gate.admit) {
    // A duplicate re-stow is idempotent: refresh it in place and say so.
    if (gate.reason.startsWith("duplicate")) {
      const summary = storeLearning(memory, learning);
      return StowReceiptSchema.parse({
        status: "updated",
        learningId: learning.id,
        factName: learningFactName(learning.id),
        gateReason: gate.reason,
        summary: `Re-stowed existing learning ${learning.id} in place (idempotent). ${summary}`
      });
    }
    return StowReceiptSchema.parse({
      status: "refused",
      gateReason: gate.reason,
      summary: `Stow refused by the GATE: ${gate.reason}.`
    });
  }

  const summary = storeLearning(memory, learning);
  return StowReceiptSchema.parse({
    status: "stowed",
    learningId: learning.id,
    factName: learningFactName(learning.id),
    gateReason: gate.reason,
    summary: `Stowed learning ${learning.id} (${learning.level}/${learning.scope}) to garage — decay-ready. ${summary}`
  });
}
