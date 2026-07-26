import { verbsForCall } from "./evaluate.js";
import { HARD_EDGE_VERBS, type MandateVerb } from "./schema.js";

/**
 * Allowlist-propose (IDEA-F13 / R-CC-ALLOW, 2026-07-18) — scans recent tool
 * denials and PROPOSES non-hard-edge mandate grants for operator approval.
 *
 * Constitution posture (Vision Reset §3, THERE v2 §2.3 Article 3):
 *
 * - Hard-edge verbs (destructive / spend / secret-edge / auth-edge) are
 *   PERMANENTLY excluded from any proposal. They escalate in every mode
 *   including YOLO and may never be covered by a standing grant, so proposing
 *   them as allowlist material would be a constitution breach. This exclusion
 *   is enforced in code here, not left as a prompt rule.
 * - The output is a proposal artifact ONLY. Nothing in this module mutates
 *   mandate state, writes a grant, or auto-approves a future call. The
 *   operator (or a governed approval path) decides what happens next.
 * - Denials classified with zero verbs (read-only tools) are not proposals —
 *   they are always-allowed floor traffic and carry no grant value.
 */

/** One observed tool denial, extracted from session/transcript evidence. */
export interface ToolDenialRecord {
  /** The tool that was denied (e.g. "bash", "write", "web_fetch"). */
  readonly toolId: string;
  /** The exact input the call carried (used to re-derive verbs). */
  readonly input: unknown;
  /** Why the call was denied, as recorded (evaluator reason or approver note). */
  readonly reason?: string;
}

/** One proposed grant line: everything an operator needs to approve or reject it. */
export interface AllowlistProposal {
  readonly toolId: string;
  /** The non-hard-edge verbs a grant would need to cover for this denial class. */
  readonly verbs: MandateVerb[];
  /** How many denials in the scanned window collapsed into this proposal. */
  readonly occurrences: number;
  /** A redacted, representative sample of the denied input for operator review. */
  readonly sampleInputSummary: string;
}

/** A denial that was scanned but excluded from proposals, with the reason why. */
export interface ExcludedDenial {
  readonly toolId: string;
  readonly verbs: MandateVerb[];
  /** Why this denial can never become a standing allowlist grant. */
  readonly exclusion: "hard-edge" | "read-only";
}

/** The proposal artifact — a snapshot for operator decision (never auto-applied). */
export interface AllowlistProposalArtifact {
  readonly schemaVersion: 1;
  readonly scanned: number;
  readonly proposals: AllowlistProposal[];
  readonly excluded: ExcludedDenial[];
}

const MAX_SAMPLE_INPUT_CHARS = 120;

/**
 * Redacts a denied input to a short, review-safe summary string. The input is
 * JSON-serialized and truncated; secret-VALUE content must already have been
 * scrubbed upstream at the log boundary (sessionLog scrubs on append), so this
 * only bounds length — it never re-introduces values.
 */
function summarizeInput(input: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(input) ?? "";
  } catch {
    raw = String(input);
  }
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  return collapsed.length > MAX_SAMPLE_INPUT_CHARS ? `${collapsed.slice(0, MAX_SAMPLE_INPUT_CHARS)}…` : collapsed;
}

function hasHardEdge(verbs: readonly MandateVerb[]): boolean {
  return verbs.some((verb) => HARD_EDGE_VERBS.has(verb));
}

/**
 * Scans a window of recent tool denials and builds a proposal artifact.
 *
 * Each denial's verbs are re-derived with {@link verbsForCall} — the same
 * classifier the live mandate evaluator uses — so a proposal can never cover
 * verbs the evaluator would not also see. Classification order:
 *
 * 1. Any hard-edge verb → excluded permanently (`hard-edge`).
 * 2. Zero verbs (read-only floor) → excluded (`read-only`); nothing to grant.
 * 3. Otherwise → folded into a proposal keyed by (toolId, sorted verbs).
 *
 * The function is pure: same denials in → same artifact out, no I/O, no clock,
 * no mandate-state mutation.
 */
export function proposeAllowlistFromDenials(denials: readonly ToolDenialRecord[]): AllowlistProposalArtifact {
  const excluded: ExcludedDenial[] = [];
  const buckets = new Map<string, { toolId: string; verbs: readonly MandateVerb[]; occurrences: number; sample: string }>();

  for (const denial of denials) {
    const verbs = verbsForCall(denial.toolId, denial.input);

    if (hasHardEdge(verbs)) {
      excluded.push({ toolId: denial.toolId, verbs, exclusion: "hard-edge" });
      continue;
    }
    if (verbs.length === 0) {
      excluded.push({ toolId: denial.toolId, verbs, exclusion: "read-only" });
      continue;
    }

    const sortedVerbs = [...verbs].sort();
    const key = `${denial.toolId}::${sortedVerbs.join("+")}`;
    const existing = buckets.get(key);
    if (existing) {
      buckets.set(key, { ...existing, occurrences: existing.occurrences + 1 });
    } else {
      buckets.set(key, {
        toolId: denial.toolId,
        verbs: sortedVerbs,
        occurrences: 1,
        sample: summarizeInput(denial.input)
      });
    }
  }

  const proposals: AllowlistProposal[] = [...buckets.values()]
    .map((bucket) => ({
      toolId: bucket.toolId,
      verbs: bucket.verbs,
      occurrences: bucket.occurrences,
      sampleInputSummary: bucket.sample
    }))
    .sort((left, right) => right.occurrences - left.occurrences || left.toolId.localeCompare(right.toolId));

  return { schemaVersion: 1, scanned: denials.length, proposals, excluded };
}
