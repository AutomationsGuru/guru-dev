import { z } from "zod";

/**
 * Plan branches (IDEA-F11-PLAN-BRANCH) — named forks of session plan state
 * (context snapshot + pending queue + conversation checkpoint) with no git
 * branch required. One branch is active at a time; resume injects the active
 * branch's checkpoint, and sibling branches stay isolated on disk.
 *
 * This module holds the schemas and pure helpers; the file-backed store lives
 * in planBranchStore.ts. Branch names are constrained to a safe slug so a
 * branch can never escape its store directory.
 */

export const PLAN_BRANCH_SCHEMA_VERSION = 1;
export const PLAN_BRANCH_MAINLINE = "main";
export const PLAN_BRANCH_CONVO_CAP = 200;
export const PLAN_BRANCH_PENDING_CAP = 200;

const PlanBranchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$|^[A-Za-z0-9]$/, "invalid plan branch name")
  .refine((name) => !name.includes(".."), "invalid plan branch name");
export type PlanBranchName = z.infer<typeof PlanBranchNameSchema>;

export const PlanBranchConvoMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string().trim().min(1),
    toolCallId: z.string().trim().min(1).optional()
  })
  .strict();
export type PlanBranchConvoMessage = z.infer<typeof PlanBranchConvoMessageSchema>;

export const PlanBranchPendingItemSchema = z
  .object({
    id: z.string().trim().min(1),
    /** Queue lane: a steer, a follow-up, or a tool approval still awaiting an answer. */
    kind: z.enum(["steer", "follow-up", "approval"]),
    content: z.string().trim().min(1)
  })
  .strict();
export type PlanBranchPendingItem = z.infer<typeof PlanBranchPendingItemSchema>;

export const PlanBranchCheckpointSchema = z
  .object({
    schemaVersion: z.literal(PLAN_BRANCH_SCHEMA_VERSION),
    sessionId: z.string().trim().min(1),
    /** Opaque context snapshot (objective, working set, scratch state). */
    context: z.record(z.string(), z.unknown()),
    pending: z.array(PlanBranchPendingItemSchema).max(PLAN_BRANCH_PENDING_CAP),
    convo: z.array(PlanBranchConvoMessageSchema).max(PLAN_BRANCH_CONVO_CAP),
    createdAt: z.string().trim().min(1)
  })
  .strict();
export type PlanBranchCheckpoint = z.infer<typeof PlanBranchCheckpointSchema>;

export const PlanBranchRecordSchema = z
  .object({
    schemaVersion: z.literal(PLAN_BRANCH_SCHEMA_VERSION),
    name: PlanBranchNameSchema,
    /** Branch this fork was taken from; the mainline has no source. */
    source: PlanBranchNameSchema.nullable(),
    active: z.boolean(),
    createdAt: z.string().trim().min(1),
    updatedAt: z.string().trim().min(1),
    checkpoint: PlanBranchCheckpointSchema
  })
  .strict();
export type PlanBranchRecord = z.infer<typeof PlanBranchRecordSchema>;

/** Caller-supplied plan state captured into a checkpoint. */
export interface PlanBranchStateInput {
  readonly sessionId: string;
  readonly context: Record<string, unknown>;
  readonly pending: readonly PlanBranchPendingItem[];
  readonly convo: readonly PlanBranchConvoMessage[];
}

export function isValidPlanBranchName(name: string): boolean {
  return PlanBranchNameSchema.safeParse(name).success;
}

export function planBranchFileName(name: string): string {
  return `${name}.json`;
}

/**
 * Trim message content, drop empties, and cap the checkpoint from the tail so
 * the most recent conversation survives.
 */
export function normalizePlanBranchMessages(
  messages: readonly PlanBranchConvoMessage[],
  cap: number = PLAN_BRANCH_CONVO_CAP
): PlanBranchConvoMessage[] {
  const cleaned = messages
    .map((message) => ({ ...message, content: message.content.trim() }))
    .filter((message) => message.content.length > 0);
  return cleaned.slice(Math.max(0, cleaned.length - cap));
}

function deepCopy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Build a validated checkpoint from caller state. The input is deep-copied so
 * later caller-side mutation cannot bleed into a stored branch.
 */
export function buildPlanBranchCheckpoint(
  input: PlanBranchStateInput,
  options: { now?: () => Date } = {}
): PlanBranchCheckpoint {
  const now = options.now ?? (() => new Date());
  return PlanBranchCheckpointSchema.parse({
    schemaVersion: PLAN_BRANCH_SCHEMA_VERSION,
    sessionId: input.sessionId,
    context: deepCopy(input.context),
    pending: deepCopy([...input.pending]),
    convo: normalizePlanBranchMessages(deepCopy([...input.convo])),
    createdAt: now().toISOString()
  });
}

/** Build a validated branch record around a checkpoint. */
export function createPlanBranchRecord(
  name: string,
  input: PlanBranchStateInput,
  options: { active: boolean; source?: string | null; now?: () => Date }
): PlanBranchRecord {
  const now = options.now ?? (() => new Date());
  const parsedName = PlanBranchNameSchema.parse(name);
  const source = options.source === undefined || options.source === null ? null : PlanBranchNameSchema.parse(options.source);
  const stamp = now().toISOString();
  return PlanBranchRecordSchema.parse({
    schemaVersion: PLAN_BRANCH_SCHEMA_VERSION,
    name: parsedName,
    source,
    active: options.active,
    createdAt: stamp,
    updatedAt: stamp,
    checkpoint: buildPlanBranchCheckpoint(input, { now })
  });
}
