import { z } from "zod";

/**
 * Package-default completion gate set + empty starter config for long multi-step
 * GuruHarness sessions.
 *
 * Vision-binding (see /mnt/p/guruharness/handoffs/loops/VISION.md §1, §3, §6):
 *
 *  - Lightweight: pure-data + zod; no new runtime dependency, no new module
 *    wiring into core. Capability is registered through the existing runtime
 *    surface; this module only *describes* a defaults package.
 *  - Hard-limit enforcing: every value here either preserves or *tightens* the
 *    five hard limits. The schema refuses any package that would weaken them,
 *    so a caller cannot accidentally turn defaults into a license to act.
 *  - Empty starter goal/rubric: defaults do not pre-bake acceptance criteria or
 *    grading behavior. Long-horizon sessions start with an objective-shaped
 *    envelope; the operator or session fills it in, so defaults can never
 *    auto-complete a multi-step turn.
 *  - Bounded budget: explicit max-turns / wall-clock / tool-calls / cost /
 *    fanout, with `unknownCostBlocks = true` so unapproved spend is a stop.
 *  - Stateless factory: every call returns a fresh, deeply-frozen object so the
 *    defaults cannot be mutated into something that violates the schema or the
 *    hard limits downstream.
 */

export const HARD_LIMIT_GATE_IDS = Object.freeze([
  "hard-limit.preserve.before-risk",
  "hard-limit.no-unapproved-spend",
  "hard-limit.no-leaked-secrets",
  "hard-limit.scope-narrowing.evidence",
  "hard-limit.governed-self-mutation"
] as const);
export type HardLimitGateId = (typeof HARD_LIMIT_GATE_IDS)[number];

export const LongHorizonApprovalPolicySchema = z
  .object({
    autoCommitPushPr: z.literal(false),
    allowLocalMerge: z.literal(false),
    allowForcePush: z.literal(false)
  })
  .strict();
export type LongHorizonApprovalPolicy = z.infer<typeof LongHorizonApprovalPolicySchema>;

export const LongHorizonReviewGateSchema = z
  .object({
    provider: z.literal("native-critic-panel"),
    required: z.literal(true)
  })
  .strict();
export type LongHorizonReviewGate = z.infer<typeof LongHorizonReviewGateSchema>;

export const LongHorizonGatePackageSchema = z
  .object({
    completionGateIds: z
      .array(z.string().trim().min(1))
      .superRefine((ids, ctx) => {
        const seen = new Set<string>();
        for (const id of ids) {
          if (seen.has(id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `completionGateIds must be unique; duplicate "${id}".`
            });
          }
          seen.add(id);
        }
        for (const hardId of HARD_LIMIT_GATE_IDS) {
          if (!seen.has(hardId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Missing hard-limit completion gate id "${hardId}".`
            });
          }
        }
      }),
    approvalPolicy: LongHorizonApprovalPolicySchema,
    reviewGate: LongHorizonReviewGateSchema
  })
  .strict();
export type LongHorizonGatePackage = z.infer<typeof LongHorizonGatePackageSchema>;

export const LongHorizonGoalStarterSchema = z
  .object({
    status: z.enum(["active", "paused", "completed", "blocked"]),
    acceptanceCriteria: z.array(z.string().trim().min(1)),
    sticky: z.boolean()
  })
  .strict()
  .refine((goal) => goal.acceptanceCriteria.length === 0, {
    message: "Long-horizon defaults must start with no implicit acceptance criteria; populate from F208."
  });
export type LongHorizonGoalStarter = z.infer<typeof LongHorizonGoalStarterSchema>;

export const LongHorizonRubricStarterSchema = z
  .object({
    sticky: z.boolean(),
    criteria: z.array(z.string().trim().min(1))
  })
  .strict()
  .refine((rubric) => rubric.criteria.length === 0, {
    message: "Long-horizon defaults must start with no implicit grading criteria; populate from F209."
  });
export type LongHorizonRubricStarter = z.infer<typeof LongHorizonRubricStarterSchema>;

export const LongHorizonPlanDefaultsSchema = z
  .object({
    rePlanOnBlocked: z.literal(true),
    requireEvidenceOnResume: z.literal(true)
  })
  .strict();
export type LongHorizonPlanDefaults = z.infer<typeof LongHorizonPlanDefaultsSchema>;

export const LongHorizonBudgetSchema = z
  .object({
    maxTurns: z.number().int().positive().finite(),
    maxWallClockMs: z.number().positive().finite(),
    maxToolCalls: z.number().int().positive().finite(),
    maxCostMicrousd: z.number().nonnegative().finite(),
    maxFanout: z.number().int().nonnegative().finite(),
    unknownCostBlocks: z.literal(true)
  })
  .strict();
export type LongHorizonBudget = z.infer<typeof LongHorizonBudgetSchema>;

export const LongHorizonDefaultsSchema = z
  .object({
    gates: LongHorizonGatePackageSchema,
    goal: LongHorizonGoalStarterSchema,
    rubric: LongHorizonRubricStarterSchema,
    plan: LongHorizonPlanDefaultsSchema,
    budget: LongHorizonBudgetSchema
  })
  .strict();
export type LongHorizonDefaults = z.infer<typeof LongHorizonDefaultsSchema>;

const FROZEN_DEFAULT_GATE_IDS: ReadonlyArray<string> = Object.freeze([
  ...HARD_LIMIT_GATE_IDS,
  "session.operator-attended.resume",
  "session.tests-stub.returned-zero",
  "session.required-files.present",
  "session.done-packet.bound"
]);

export const DEFAULT_COMPLETION_GATE_IDS: ReadonlyArray<string> = FROZEN_DEFAULT_GATE_IDS;

const DEFAULT_MAX_TURNS = 64;
const DEFAULT_MAX_WALL_CLOCK_MS = 30 * 60 * 1000;
const DEFAULT_MAX_TOOL_CALLS = 256;
const DEFAULT_MAX_COST_MICROUSD = 0;
const DEFAULT_MAX_FANOUT = 4;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested !== null && typeof nested === "object" && !Object.isFrozen(nested)) {
      deepFreeze(nested);
    }
  }

  return value;
}

/**
 * Build a fresh, deeply-frozen long-horizon defaults package.
 *
 * Each call returns a NEW object so callers can compare identity safely,
 * never mutate a shared default, and never reach in to widen the hard-limit
 * posture by hand. Returned objects are validated through
 * `LongHorizonDefaultsSchema`, which is the structural choke point that
 * refuses to widen the five hard limits.
 */
export function buildLongHorizonDefaults(): Readonly<LongHorizonDefaults> {
  const draft: LongHorizonDefaults = {
    gates: {
      completionGateIds: Array.from(FROZEN_DEFAULT_GATE_IDS),
      approvalPolicy: {
        autoCommitPushPr: false,
        allowLocalMerge: false,
        allowForcePush: false
      },
      reviewGate: {
        provider: "native-critic-panel",
        required: true
      }
    },
    goal: {
      status: "active",
      acceptanceCriteria: [],
      sticky: false
    },
    rubric: {
      sticky: false,
      criteria: []
    },
    plan: {
      rePlanOnBlocked: true,
      requireEvidenceOnResume: true
    },
    budget: {
      maxTurns: DEFAULT_MAX_TURNS,
      maxWallClockMs: DEFAULT_MAX_WALL_CLOCK_MS,
      maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
      maxCostMicrousd: DEFAULT_MAX_COST_MICROUSD,
      maxFanout: DEFAULT_MAX_FANOUT,
      unknownCostBlocks: true
    }
  };

  const parsed = LongHorizonDefaultsSchema.parse(draft);
  deepFreeze(parsed);

  return Object.freeze(parsed);
}
