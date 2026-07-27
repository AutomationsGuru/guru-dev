import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseFactFile, serializeFactFile } from "./frontmatter.js";
import { detectPotentialSecrets } from "../safety/policyGuard.js";
import { containsSecretValue } from "../safety/secretSafety.js";
import {
  MemoryRememberInputSchema,
  slugifyFactName,
  type MemoryFact,
  type MemoryFactType
} from "./schemas.js";

/**
 * Correction ritual — when validation fails or the operator corrects the
 * harness, draft a scoped LEARN note and hold it for explicit approval.
 *
 * The product's five hard limits always resolve before YOLO, and the
 * constitution/mandate paths are structurally off-limits: this module can
 * propose a garage note or skill tip, but it will never write directly to
 * mandates, constitution, safety policy, or review gates. Actual write-back
 * requires operator approval plus a review/done packet (governed self-mutation).
 *
 * Design archive: Vision §3.5 (no ungoverned self-improvement) and the LEARN
 * door from §1.5: when a gap is solved by technique, capture it as a durable
 * learning at the correct scope.
 */

/** A proposed LEARN write-back, ready for operator review. */
export interface CorrectionDraft {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** Suggested memory type for the note. */
  readonly type: MemoryFactType;
  /** Draft body with citations/why/how. */
  readonly body: string;
  /** Original failure or correction signal that triggered the draft. */
  readonly trigger: CorrectionTrigger;
  /** Confidence in the learning (0..1), never 1 until independently verified. */
  readonly confidence: number;
}

export interface CorrectionTrigger {
  readonly kind: "validation-failure" | "operator-correction" | "stuck-recovery";
  readonly summary: string;
  /** Free-form evidence/citations — must not contain secret values. */
  readonly evidence: readonly string[];
}

export interface CorrectionContext {
  /** Current working directory or project root for scoping the note. */
  readonly projectPath?: string;
  /** Optional session identifier for originSessionId. */
  readonly sessionId?: string;
  readonly now?: () => Date;
}

export type CorrectionDestination =
  | { readonly kind: "memory"; readonly directory: string }
  | { readonly kind: "garage-note"; readonly directory: string }
  | { readonly kind: "skill-tip"; readonly directory: string }
  | { readonly kind: "constitution" }
  | { readonly kind: "mandate" };

export type CorrectionDraftResult =
  | { readonly status: "drafted"; readonly draft: CorrectionDraft; readonly summary: string }
  | { readonly status: "blocked"; readonly summary: string; readonly blockers: readonly string[] };

export type CorrectionWriteResult =
  | { readonly status: "approved-written"; readonly name: string; readonly path: string; readonly summary: string }
  | { readonly status: "rejected"; readonly summary: string }
  | { readonly status: "blocked"; readonly summary: string; readonly blockers: readonly string[] };

/** Paths that are structurally off-limits for a correction write-back. */
const FORBIDDEN_CONSTITUTION_PATHS = [
  ".claude/AGENTS.md",
  "AGENTS.md",
  "constitution",
  "mandates",
  "src/safety",
  "src/mandate",
  ".guru/constitution",
  ".guru/mandates"
];

const FORBIDDEN_CONSTITUTION_NAMES = [
  "constitution",
  "mandates",
  "mandate",
  "safety-policy",
  "review-gates",
  "self-build-rules"
];

const DEFAULT_MEMORY_TYPES: readonly MemoryFactType[] = ["learning", "feedback", "project", "reference"];

/**
 * Build a LEARN draft from a failure or correction signal.
 *
 * The draft is **staged** only; nothing is persisted until `approveCorrectionDraft`
 * is called and the destination passes the hard-limit path check.
 */
export function buildCorrectionDraft(
  trigger: CorrectionTrigger,
  context: CorrectionContext = {}
): CorrectionDraftResult {
  const blockers = correctionDraftBlockers(trigger);
  if (blockers.length > 0) {
    return {
      status: "blocked",
      summary: "Correction draft blocked by safety/policy gates.",
      blockers
    };
  }

  const title = draftTitle(trigger);
  const name = slugifyFactName(title);
  const type = preferredType(trigger);
  const description = draftDescription(trigger);
  const body = draftBody(trigger, context);
  const confidence = 0.75; // learning is provisional until verified

  return {
    status: "drafted",
    draft: {
      name,
      title,
      description,
      type,
      body,
      trigger,
      confidence
    },
    summary: `Drafted LEARN note [[${name}]] (${type}) — awaiting operator approval.`
  };
}

/**
 * Approve a drafted LEARN note and write it to the destination.
 *
 * If the destination is a forbidden constitution/mandate path, the write is
 * structurally refused, regardless of YOLO mode or any session grant.
 */
export function approveCorrectionDraft(
  draft: CorrectionDraft,
  destination: CorrectionDestination,
  context: CorrectionContext = {}
): CorrectionWriteResult {
  const pathBlockers = destinationBlockers(destination);
  if (pathBlockers.length > 0) {
    return {
      status: "blocked",
      summary: "Write refused: destination is a constitution/mandate path.",
      blockers: pathBlockers
    };
  }

  if (destination.kind === "memory" || destination.kind === "garage-note" || destination.kind === "skill-tip") {
    return writeDraftToDirectory(draft, destination.directory, context);
  }

  // Defensive exhaustive fallback — forbidden kinds should be caught above.
  return {
    status: "blocked",
    summary: `Write refused: unsupported destination '${(destination as CorrectionDestination).kind}'.`,
    blockers: ["unsupported-destination"]
  };
}

/** Reject a draft. Returns a deterministic rejected result. */
export function rejectCorrectionDraft(draft: CorrectionDraft): CorrectionWriteResult {
  return {
    status: "rejected",
    summary: `Draft [[${draft.name}]] rejected by operator; nothing was written.`
  };
}

function draftTitle(trigger: CorrectionTrigger): string {
  const prefix =
    trigger.kind === "operator-correction"
      ? "learn operator correction"
      : trigger.kind === "stuck-recovery"
        ? "learn stuck recovery"
        : "learn validation failure";
  const safeSummary = trigger.summary.replace(/[^a-zA-Z0-9]+/gu, " ").trim();
  return `${prefix}: ${safeSummary}`.slice(0, 120);
}

function draftDescription(trigger: CorrectionTrigger): string {
  return `Learning from ${trigger.kind.replace(/-/gu, " ")}: ${trigger.summary}`.slice(0, 300);
}

function preferredType(trigger: CorrectionTrigger): MemoryFactType {
  if (trigger.kind === "operator-correction") return "feedback";
  if (trigger.kind === "stuck-recovery") return "learning";
  return "learning";
}

function draftBody(trigger: CorrectionTrigger, context: CorrectionContext): string {
  const lines: string[] = [
    `## What happened`,
    "",
    `- **Kind:** ${trigger.kind}`,
    `- **Summary:** ${trigger.summary}`,
    "",
    `## Evidence`,
    ""
  ];
  for (const item of trigger.evidence) {
    lines.push(`- ${item}`);
  }
  lines.push("");
  lines.push("## Why it matters");
  lines.push("");
  lines.push(
    "This pattern was missed, corrected, or recovered. Recording it makes the next session sharper at the same situation."
  );
  lines.push("");
  lines.push("## How to apply");
  lines.push("");
  lines.push(
    context.projectPath
      ? `Apply in project scope (${context.projectPath}). Link related facts with [[slug]].`
      : "Apply at the appropriate scope (global, project, or role). Link related facts with [[slug]]."
  );
  lines.push("");
  lines.push("---");
  lines.push(`Drafted by correction ritual; confidence is provisional until reviewed.`);
  return lines.join("\n");
}

function correctionDraftBlockers(trigger: CorrectionTrigger): string[] {
  const blockers: string[] = [];
  if (!trigger.summary || trigger.summary.trim().length === 0) {
    blockers.push("trigger.summary is required");
  }
  for (const item of trigger.evidence) {
    if (containsSecretValue(item)) {
      blockers.push("evidence contains token-shaped value — redact secrets before drafting");
    }
  }
  const secretMatches = detectPotentialSecrets([
    { name: "trigger.summary", value: trigger.summary },
    ...trigger.evidence.map((value, index) => ({ name: `trigger.evidence[${index}]`, value }))
  ]);
  for (const match of secretMatches) {
    blockers.push(`potential secret (${match.kind}) in ${match.name} — redact before drafting`);
  }
  return blockers;
}

function destinationBlockers(destination: CorrectionDestination): string[] {
  if (destination.kind === "constitution" || destination.kind === "mandate") {
    return ["forbidden-destination: constitution/mandate paths are structurally off-limits"];
  }

  if ("directory" in destination) {
    const normalized = destination.directory.toLowerCase().replace(/\\/gu, "/");
    for (const forbidden of FORBIDDEN_CONSTITUTION_PATHS) {
      if (normalized.includes(forbidden.toLowerCase())) {
        return [`forbidden-destination: directory overlaps ${forbidden}`];
      }
    }
  }
  return [];
}

function writeDraftToDirectory(
  draft: CorrectionDraft,
  directory: string,
  context: CorrectionContext
): CorrectionWriteResult {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }

  const now = context.now ? context.now() : new Date();
  const timestamp = now.toISOString();
  const fact: MemoryFact = {
    name: draft.name,
    title: draft.title,
    description: draft.description,
    type: draft.type,
    createdAt: timestamp,
    updatedAt: timestamp,
    confidence: draft.confidence,
    ...(context.sessionId ? { originSessionId: context.sessionId } : {})
  };

  // Verify we are not accidentally overwriting a forbidden name.
  if (FORBIDDEN_CONSTITUTION_NAMES.includes(fact.name)) {
    return {
      status: "blocked",
      summary: `Write refused: fact name '${fact.name}' is a constitution/mandate name.`,
      blockers: ["forbidden-fact-name"]
    };
  }

  const path = join(directory, `${fact.name}.md`);
  const content = serializeFactFile(fact, draft.body);
  writeFileSync(path, content, "utf8");

  return {
    status: "approved-written",
    name: fact.name,
    path,
    summary: `Approved and wrote [[${fact.name}]] to ${path}.`
  };
}

/** Read back a written correction note for verification. */
export function readCorrectionNote(directory: string, name: string): { readonly found: boolean; readonly body: string | undefined } {
  const path = join(directory, `${name}.md`);
  if (!existsSync(path)) {
    return { found: false };
  }
  const parsed = parseFactFile(readFileSync(path, "utf8"));
  return { found: parsed !== undefined, body: parsed?.body };
}

/** @internal List the allowed memory types for correction drafts. */
export function allowedCorrectionTypes(): readonly MemoryFactType[] {
  return DEFAULT_MEMORY_TYPES;
}
