import { z } from "zod";

/**
 * Quick plan bypass (IDEA-F145-QUICK-PLAN-01, R-KR-QUICK).
 *
 * A SpecPacket carries req/design/tasks artifacts plus per-phase status.
 * The default path is gated: implementation is allowed only after
 * `requirements` and `design` are approved (tasks may remain draft).
 *
 * `quickPlan: true` skips those phase-approval gates for well-understood
 * features, but still requires non-empty artifacts. Fail closed: empty or
 * malformed artifacts never open the implement path.
 *
 * Pure module: no IO, no side effects beyond returned data. Local SpecPacket
 * shape is defined here (F136 is not on this base tip).
 */

export const SPEC_PHASE_NAMES = ["requirements", "design", "tasks"] as const;
export type SpecPhaseName = (typeof SPEC_PHASE_NAMES)[number];

export const PHASE_STATUSES = ["draft", "approved"] as const;
export type PhaseStatus = (typeof PHASE_STATUSES)[number];

export const SpecArtifactsSchema = z
  .object({
    requirements: z.string(),
    design: z.string(),
    tasks: z.string()
  })
  .strict();
export type SpecArtifacts = z.infer<typeof SpecArtifactsSchema>;

export const SpecPacketSchema = z
  .object({
    id: z.string().trim().min(1),
    kind: z.enum(["feature", "bugfix"]),
    artifacts: SpecArtifactsSchema,
    phases: z
      .object({
        requirements: z.enum(PHASE_STATUSES),
        design: z.enum(PHASE_STATUSES),
        tasks: z.enum(PHASE_STATUSES)
      })
      .strict(),
    quickPlan: z.boolean()
  })
  .strict();
export type SpecPacket = z.infer<typeof SpecPacketSchema>;

export type EnableQuickPlanResult =
  | { readonly ok: true; readonly packet: SpecPacket }
  | { readonly ok: false; readonly reason: string };

const PLACEHOLDER_ARTIFACTS: SpecArtifacts = {
  requirements: "placeholder requirements",
  design: "placeholder design",
  tasks: "placeholder tasks"
};

function hasNonEmptyArtifacts(artifacts: SpecArtifacts | undefined | null): boolean {
  if (artifacts == null || typeof artifacts !== "object") {
    return false;
  }
  for (const key of ["requirements", "design", "tasks"] as const) {
    const value = artifacts[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      return false;
    }
  }
  return true;
}

function clonePacket(packet: SpecPacket): SpecPacket {
  return {
    id: packet.id,
    kind: packet.kind,
    artifacts: {
      requirements: packet.artifacts.requirements,
      design: packet.artifacts.design,
      tasks: packet.artifacts.tasks
    },
    phases: {
      requirements: packet.phases.requirements,
      design: packet.phases.design,
      tasks: packet.phases.tasks
    },
    quickPlan: packet.quickPlan
  };
}

/**
 * Factory for a gated SpecPacket (quickPlan: false, all phases draft) with
 * non-empty placeholder artifacts. Partial overrides merge shallowly.
 */
export function createSpecPacket(partial?: Partial<SpecPacket>): SpecPacket {
  const base: SpecPacket = {
    id: partial?.id?.trim() ? partial.id.trim() : "spec-1",
    kind: partial?.kind === "bugfix" || partial?.kind === "feature" ? partial.kind : "feature",
    artifacts: {
      requirements: partial?.artifacts?.requirements ?? PLACEHOLDER_ARTIFACTS.requirements,
      design: partial?.artifacts?.design ?? PLACEHOLDER_ARTIFACTS.design,
      tasks: partial?.artifacts?.tasks ?? PLACEHOLDER_ARTIFACTS.tasks
    },
    phases: {
      requirements: partial?.phases?.requirements === "approved" ? "approved" : "draft",
      design: partial?.phases?.design === "approved" ? "approved" : "draft",
      tasks: partial?.phases?.tasks === "approved" ? "approved" : "draft"
    },
    quickPlan: partial?.quickPlan === true
  };
  return base;
}

/** True when the packet has the quick-plan bypass flag set. */
export function isQuickPlan(packet: SpecPacket): boolean {
  return packet?.quickPlan === true;
}

/**
 * Immutably approve one phase. Returns a new packet; original is unchanged.
 * Unknown phase names are ignored (packet returned as a clone).
 */
export function approvePhase(packet: SpecPacket, phase: SpecPhaseName): SpecPacket {
  const next = clonePacket(packet);
  if (phase === "requirements" || phase === "design" || phase === "tasks") {
    next.phases[phase] = "approved";
  }
  return next;
}

/**
 * Enable the quick-plan bypass on a packet.
 *
 * Requires non-empty (trimmed) requirements, design, and tasks artifacts.
 * Fail closed with `{ ok: false, reason }` when artifacts are missing/empty
 * or the packet shape is invalid. Does not strip artifacts; does not mutate
 * the input.
 */
export function enableQuickPlan(packet: SpecPacket): EnableQuickPlanResult {
  const parsed = SpecPacketSchema.safeParse(packet);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid SpecPacket: malformed shape or fields"
    };
  }
  if (!hasNonEmptyArtifacts(parsed.data.artifacts)) {
    return {
      ok: false,
      reason:
        "quick plan requires non-empty requirements, design, and tasks artifacts"
    };
  }
  const next = clonePacket(parsed.data);
  next.quickPlan = true;
  return { ok: true, packet: next };
}

/**
 * Whether implementation may proceed for this packet.
 *
 * - quickPlan + non-empty artifacts → true immediately (phase gates skipped)
 * - gated (quickPlan false): true only when requirements AND design are
 *   `"approved"` (tasks may still be draft) and artifacts are non-empty
 * - malformed packet / empty artifacts → false (fail closed)
 */
export function canImplement(packet: SpecPacket): boolean {
  const parsed = SpecPacketSchema.safeParse(packet);
  if (!parsed.success) {
    return false;
  }
  const data = parsed.data;
  if (!hasNonEmptyArtifacts(data.artifacts)) {
    return false;
  }
  if (data.quickPlan === true) {
    return true;
  }
  return data.phases.requirements === "approved" && data.phases.design === "approved";
}
