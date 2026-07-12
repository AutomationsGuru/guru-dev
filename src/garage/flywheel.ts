import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * The knowledge flywheel (Flywheel wave, ADR 2026-07-05-knowledge-flywheel,
 * THERE v2 §8 + §7 + §17.10). Pure logic for the six stages — EXTRACT, GATE,
 * INJECT (decay-ranked selection), CITE, DECAY — plus the cross-level conflict
 * detector. Persistence rides the memory organ (see flywheelStore.ts); this
 * module is deterministic and unit-testable, no I/O.
 */

export const LearningScopeSchema = z.enum(["global", "space", "role"]);
export type LearningScope = z.infer<typeof LearningScopeSchema>;

/** L0 raw → L1 episodic → L2 skill → L3 rule (the four compression levels). */
export const LearningLevelSchema = z.enum(["L0", "L1", "L2", "L3"]);
export type LearningLevel = z.infer<typeof LearningLevelSchema>;

export const CitationSchema = z
  .object({
    at: z.string().trim().min(1),
    outcome: z.string().default(""),
    sessionId: z.string().trim().min(1).optional()
  })
  .strict();
export type Citation = z.infer<typeof CitationSchema>;

export const LearningSchema = z
  .object({
    id: z.string().trim().min(1),
    scope: LearningScopeSchema,
    roleSlug: z.string().trim().min(1).optional(),
    level: LearningLevelSchema,
    statement: z.string().trim().min(1).max(400),
    evidence: z.string().default(""),
    /** Normalized key for conflict detection (same subject + opposite polarity = conflict). */
    subject: z.string().trim().min(1),
    polarity: z.enum(["affirm", "deny"]).default("affirm"),
    /** Tools this learning is about — used to CITE (injected + tools-used = a citation). */
    tools: z.array(z.string().min(1)).default([]),
    /** Curated/validated = earns promotion weight; self-generated = earns none (the GATE). */
    validated: z.boolean().default(false),
    citations: z.array(CitationSchema).default([]),
    createdAt: z.string().trim().min(1),
    lastCitedAt: z.string().nullable().default(null),
    confidence: z.number().min(0).max(1).default(0.5),
    /** Boot session number at creation / last citation — the REAL decay clock (§8). */
    createdSession: z.number().int().nonnegative().default(0),
    lastCitedSession: z.number().int().nonnegative().nullable().default(null)
  })
  .strict();
export type Learning = z.infer<typeof LearningSchema>;

/** Promotion weight for a validated learning (curated earns; self-generated earns nothing). */
export const VALIDATED_PROMOTION_WEIGHT = 16;
/** Keep at most this many citations on a learning (bounded body). */
const MAX_CITATIONS = 24;

/** Deterministic id: the same (scope, level, statement) always maps to the same learning. */
export function learningId(scope: LearningScope, level: LearningLevel, statement: string): string {
  const normalized = statement.trim().toLowerCase().replace(/\s+/gu, " ");
  return `l${createHash("sha256").update(`${scope} ${level} ${normalized}`).digest("hex").slice(0, 12)}`;
}

function normalizeSubject(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48);
  return slug.length > 0 ? slug : "general";
}

export interface ExtractInput {
  readonly roleSlug: string;
  readonly toolsUsed: readonly string[];
  readonly routeId: string;
  readonly turns: number;
  readonly now: () => Date;
  /** Current boot session number — stamps the learning's decay clock. */
  readonly currentSession?: number;
}

/**
 * EXTRACT — turn a suited session's grounded signal into L1 episodic learnings.
 * Never invents: the evidence is the real session (suit + tools observed used +
 * route + turns). Self-generated ⇒ validated:false (GATE gives it 0 promotion).
 */
export function extractLearnings(input: ExtractInput): Learning[] {
  if (input.turns <= 0 || input.toolsUsed.length === 0) {
    return [];
  }
  const stamp = input.now().toISOString();
  const scope: LearningScope = "role";
  const learnings: Learning[] = [];
  const mk = (statement: string, subject: string, tools: readonly string[]): Learning =>
    LearningSchema.parse({
      id: learningId(scope, "L1", statement),
      scope,
      roleSlug: input.roleSlug,
      level: "L1",
      statement,
      evidence: `session: ${input.turns} turn(s) on route ${input.routeId}; tools ${input.toolsUsed.join(", ")}`,
      subject: normalizeSubject(subject),
      polarity: "affirm",
      tools: [...tools],
      validated: false,
      citations: [],
      createdAt: stamp,
      lastCitedAt: null,
      confidence: 0.5,
      createdSession: input.currentSession ?? 0,
      lastCitedSession: null
    });

  // A suit-level episodic: this loadout got real work done on this route.
  learnings.push(
    mk(
      `The "${input.roleSlug}" suit completed work with tools [${input.toolsUsed.join(", ")}] on route ${input.routeId}.`,
      `${input.roleSlug}-loadout`,
      input.toolsUsed
    )
  );
  // Per-tool episodics: this tool earned its place in this suit.
  for (const tool of input.toolsUsed) {
    learnings.push(mk(`Tool "${tool}" was useful for the "${input.roleSlug}" suit.`, `${input.roleSlug}-tool-${tool}`, [tool]));
  }
  return learnings;
}

export interface GateResult {
  readonly admit: boolean;
  readonly promoteWeight: number;
  readonly reason: string;
}

/**
 * GATE — admit only actionable + specific + unique learnings, and apply
 * validation-gated promotion (validated ⇒ weight 16; self-generated ⇒ 0).
 */
export function gateLearning(learning: Learning, existingIds: ReadonlySet<string>): GateResult {
  const promoteWeight = learning.validated ? VALIDATED_PROMOTION_WEIGHT : 0;
  if (learning.statement.trim().length < 12) {
    return { admit: false, promoteWeight, reason: "not specific enough (statement too short)" };
  }
  if (existingIds.has(learning.id)) {
    // Not novel — the caller updates the existing fact instead of admitting a dup.
    return { admit: false, promoteWeight, reason: "duplicate (same learning already stored)" };
  }
  return { admit: true, promoteWeight, reason: learning.validated ? "validated — promotable" : "actionable + specific + unique (self-generated, not promotable)" };
}

const MS_PER_DAY = 86_400_000;

/**
 * Decay-ranked injection score: confidence, lifted by citations, decayed by age
 * since last use, and boosted by task-term overlap. Higher = inject first.
 */
export function decayScore(learning: Learning, now: Date, taskTerms: ReadonlySet<string> = new Set()): number {
  const anchor = learning.lastCitedAt ?? learning.createdAt;
  const ageDays = Math.max(0, (now.getTime() - Date.parse(anchor)) / MS_PER_DAY);
  const recency = 1 / (1 + ageDays / 7); // half-weight ~ a week stale
  const citationLift = 1 + learning.citations.length;
  let taskBoost = 1;
  if (taskTerms.size > 0) {
    const hay = `${learning.statement} ${learning.subject} ${learning.tools.join(" ")}`.toLowerCase();
    let hits = 0;
    for (const term of taskTerms) {
      if (term.length > 2 && hay.includes(term)) hits += 1;
    }
    taskBoost = 1 + hits;
  }
  return learning.confidence * citationLift * recency * taskBoost;
}

export interface InjectionBudget {
  readonly maxLines: number;
  readonly maxChars: number;
}

/** INJECT — pick the top learnings by decay score within a line/char budget. */
export function rankForInjection(
  learnings: readonly Learning[],
  opts: { readonly now: Date; readonly taskTerms?: ReadonlySet<string>; readonly budget: InjectionBudget }
): Learning[] {
  // Score each learning, dropping any with a non-finite score (a malformed date
  // yields NaN via Date.parse → ageDays NaN → score NaN). Previously such a
  // learning poisoned the sort comparator AND could throw upstream, blanking
  // all boot memory via the blunt catch in refreshBootMemoryBlock (review 2026-07-08).
  const scored: Array<{ learning: Learning; score: number }> = [];
  for (const learning of learnings) {
    const score = decayScore(learning, opts.now, opts.taskTerms);
    if (Number.isFinite(score)) {
      scored.push({ learning, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const picked: Learning[] = [];
  let chars = 0;
  for (const { learning } of scored) {
    if (picked.length >= opts.budget.maxLines) break;
    const cost = learning.statement.length + 24;
    if (chars + cost > opts.budget.maxChars) continue;
    chars += cost;
    picked.push(learning);
  }
  return picked;
}

/** CITE — record an application of an injected learning (bumps count + lastCitedAt). */
export function citeLearning(learning: Learning, citation: Citation, currentSession?: number): Learning {
  const citations = [...learning.citations, citation].slice(-MAX_CITATIONS);
  return {
    ...learning,
    citations,
    lastCitedAt: citation.at,
    confidence: Math.min(1, learning.confidence + 0.05),
    ...(currentSession !== undefined ? { lastCitedSession: currentSession } : {})
  };
}

export type DecayVerdict = "keep" | "review" | "prune";

export interface DecayThresholds {
  readonly reviewAfterDays: number;
  readonly pruneAfterDays: number;
}

/** The REAL decay clock (§8): review after N sessions, prune after 2N. */
export interface SessionDecayContext {
  readonly currentSession: number;
  readonly reviewAfterSessions: number;
  readonly pruneAfterSessions: number;
}

/** Age in days since the learning was last cited (or created if never cited). */
export function idleDays(learning: Learning, now: Date): number {
  const anchor = learning.lastCitedAt ?? learning.createdAt;
  return Math.max(0, (now.getTime() - Date.parse(anchor)) / MS_PER_DAY);
}

/** Sessions elapsed since the learning was last cited (or created). */
export function idleSessions(learning: Learning, currentSession: number): number {
  const anchor = learning.lastCitedSession ?? learning.createdSession;
  return Math.max(0, currentSession - anchor);
}

/**
 * Classify a single learning by staleness. Prefers the SESSION clock when a
 * session context is given and the learning carries session data; otherwise
 * falls back to the days proxy (learnings that predate the session counter).
 */
export function classifyDecay(learning: Learning, now: Date, thresholds: DecayThresholds, session?: SessionDecayContext): DecayVerdict {
  const hasSessionData = learning.lastCitedSession !== null || learning.createdSession > 0;
  if (session && hasSessionData) {
    const idle = idleSessions(learning, session.currentSession);
    if (idle > session.pruneAfterSessions) return "prune";
    if (idle > session.reviewAfterSessions) return "review";
    return "keep";
  }
  const idle = idleDays(learning, now);
  if (idle > thresholds.pruneAfterDays) return "prune";
  if (idle > thresholds.reviewAfterDays) return "review";
  return "keep";
}

export interface CrossLevelConflict {
  readonly subject: string;
  readonly rule: Learning; // the L3
  readonly skill: Learning; // the L2
}

/**
 * Detect the one cross-level conflict class §8 names: an L3 RULE contradicting an
 * L2 SKILL (same subject, opposite polarity). These trigger REVIEW — never
 * silent coexistence.
 */
export function detectCrossLevelConflicts(learnings: readonly Learning[]): CrossLevelConflict[] {
  const conflicts: CrossLevelConflict[] = [];
  const rules = learnings.filter((l) => l.level === "L3");
  const skills = learnings.filter((l) => l.level === "L2");
  for (const rule of rules) {
    for (const skill of skills) {
      if (rule.subject === skill.subject && rule.polarity !== skill.polarity) {
        conflicts.push({ subject: rule.subject, rule, skill });
      }
    }
  }
  return conflicts;
}

export interface SupersedeResult {
  /** The surviving learnings after same-subject/level opposite-polarity supersession. */
  readonly kept: Learning[];
  /** Older learnings superseded by a newer contradicting one (prune with a receipt). */
  readonly superseded: Learning[];
}

/**
 * A newer learning at the same level + subject with OPPOSITE polarity supersedes
 * (contradicts) the older — replace, don't silently coexist.
 */
export function resolveSupersessions(learnings: readonly Learning[]): SupersedeResult {
  const superseded: Learning[] = [];
  const kept: Learning[] = [];
  for (const candidate of learnings) {
    const contradictor = learnings.find(
      (other) =>
        other.id !== candidate.id &&
        other.level === candidate.level &&
        other.subject === candidate.subject &&
        other.polarity !== candidate.polarity &&
        Date.parse(other.createdAt) > Date.parse(candidate.createdAt)
    );
    if (contradictor) {
      superseded.push(candidate);
    } else {
      kept.push(candidate);
    }
  }
  return { kept, superseded };
}

export interface DecaySweep {
  readonly keep: Learning[];
  readonly review: Learning[];
  readonly prune: Learning[];
  readonly superseded: Learning[];
  readonly conflicts: CrossLevelConflict[];
}

/** DECAY — the full write-side sweep: supersession, staleness, cross-level conflicts. */
export function decaySweep(learnings: readonly Learning[], now: Date, thresholds: DecayThresholds, session?: SessionDecayContext): DecaySweep {
  const { kept, superseded } = resolveSupersessions(learnings);
  const keep: Learning[] = [];
  const review: Learning[] = [];
  const prune: Learning[] = [...superseded];
  for (const learning of kept) {
    const verdict = classifyDecay(learning, now, thresholds, session);
    if (verdict === "prune") prune.push(learning);
    else if (verdict === "review") review.push(learning);
    else keep.push(learning);
  }
  return { keep, review, prune, superseded, conflicts: detectCrossLevelConflicts(kept) };
}

// ---------------------------------------------------------------------------
// The L0→L3 promotion diagonal (§8): cited episodics cluster UP into skills/
// rules; uncited skills/rules fall DOWN. Validation-gated — self-generated
// learnings never promote (the GATE is the point).

const LEVEL_ORDER: readonly LearningLevel[] = ["L0", "L1", "L2", "L3"];
function lowerLevel(level: LearningLevel): LearningLevel {
  const index = LEVEL_ORDER.indexOf(level);
  return index > 0 ? (LEVEL_ORDER[index - 1] as LearningLevel) : level;
}

export interface PromotionThresholds {
  /** Validated L1 → L2 when citations reach this. */
  readonly promoteToSkill: number;
  /** Validated L2 → L3 when citations reach this. */
  readonly promoteToRule: number;
  /** An uncited L2/L3 demotes one level after this many idle sessions. */
  readonly demoteAfterSessions: number;
}

export interface LevelChange {
  /** The learning at its new level (its id is re-hashed for the new level). */
  readonly learning: Learning;
  readonly oldId: string;
  readonly from: LearningLevel;
  readonly to: LearningLevel;
}

export interface PromotionResult {
  readonly promoted: LevelChange[];
  readonly demoted: LevelChange[];
  readonly unchanged: Learning[];
}

/** Move a learning to a new level, re-hashing its id (id = hash of scope+level+statement). */
function relevel(learning: Learning, to: LearningLevel): Learning {
  return { ...learning, level: to, id: learningId(learning.scope, to, learning.statement) };
}

/**
 * The diagonal. One level change per learning per sweep (demotion first):
 * - DEMOTE: an L3/L2 learning idle (uncited) past the threshold falls one level.
 * - PROMOTE: only a VALIDATED learning is eligible (unvalidated earns nothing and
 *   stays L1 forever — auto-promoting unvetted self-generated knowledge would be
 *   unsafe); among validated learnings, citations drive the level (L1→L2→L3).
 */
export function promoteSweep(learnings: readonly Learning[], currentSession: number, thresholds: PromotionThresholds): PromotionResult {
  const promoted: LevelChange[] = [];
  const demoted: LevelChange[] = [];
  const unchanged: Learning[] = [];
  for (const learning of learnings) {
    if ((learning.level === "L3" || learning.level === "L2") && idleSessions(learning, currentSession) > thresholds.demoteAfterSessions) {
      const to = lowerLevel(learning.level);
      demoted.push({ learning: relevel(learning, to), oldId: learning.id, from: learning.level, to });
      continue;
    }
    if (learning.validated) {
      const cites = learning.citations.length;
      if (learning.level === "L1" && cites >= thresholds.promoteToSkill) {
        promoted.push({ learning: relevel(learning, "L2"), oldId: learning.id, from: "L1", to: "L2" });
        continue;
      }
      if (learning.level === "L2" && cites >= thresholds.promoteToRule) {
        promoted.push({ learning: relevel(learning, "L3"), oldId: learning.id, from: "L2", to: "L3" });
        continue;
      }
    }
    unchanged.push(learning);
  }
  return { promoted, demoted, unchanged };
}
