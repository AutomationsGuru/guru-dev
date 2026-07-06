import { z } from "zod";

export const JsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObjectSchema>;

export const ProjectSlugSchema = z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u);

export const OperationalProjectSchema = z
  .object({
    id: z.string().trim().min(1),
    slug: ProjectSlugSchema,
    name: z.string().trim().min(1),
    purpose: z.string().trim().min(1),
    status: z.enum(["active", "paused", "archived"]),
    metadata: JsonObjectSchema.default({})
  })
  .strict();
export type OperationalProject = z.infer<typeof OperationalProjectSchema>;

export const StateSnapshotKindSchema = z.enum(["current", "future", "path", "risk", "note"]);
export const OperationalStateSnapshotSchema = z
  .object({
    id: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    kind: StateSnapshotKindSchema,
    title: z.string().trim().min(1),
    body: z.string().trim().min(1),
    source: z.string().trim().min(1),
    confidence: z.number().min(0).max(1),
    metadata: JsonObjectSchema.default({})
  })
  .strict();
export type OperationalStateSnapshot = z.infer<typeof OperationalStateSnapshotSchema>;

export const WriteStateSnapshotInputSchema = z
  .object({
    projectSlug: ProjectSlugSchema,
    kind: StateSnapshotKindSchema,
    title: z.string().trim().min(1),
    body: z.string().trim().min(1),
    source: z.string().trim().min(1).default("runtime"),
    confidence: z.number().min(0).max(1).default(1),
    metadata: JsonObjectSchema.default({})
  })
  .strict();
export type WriteStateSnapshotInput = z.input<typeof WriteStateSnapshotInputSchema>;

export const ListStateSnapshotsInputSchema = z
  .object({
    projectSlug: ProjectSlugSchema,
    kinds: z.array(StateSnapshotKindSchema).default(["current", "future", "path", "risk", "note"]),
    source: z.string().trim().min(1).optional(),
    metadata: JsonObjectSchema.default({})
  })
  .strict();
export type ListStateSnapshotsInput = z.input<typeof ListStateSnapshotsInputSchema>;

export const DecisionStatusSchema = z.enum(["proposed", "accepted", "superseded", "rejected"]);
export const OperationalDecisionSchema = z
  .object({
    id: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    decisionKey: z.string().trim().min(1),
    title: z.string().trim().min(1),
    status: DecisionStatusSchema,
    owner: z.string().trim().min(1),
    context: z.string().trim().min(1),
    decision: z.string().trim().min(1),
    consequences: z.string().trim().min(1),
    metadata: JsonObjectSchema.default({})
  })
  .strict();
export type OperationalDecision = z.infer<typeof OperationalDecisionSchema>;

export const UpsertDecisionInputSchema = z
  .object({
    projectSlug: ProjectSlugSchema,
    decisionKey: z.string().trim().min(1),
    title: z.string().trim().min(1),
    status: DecisionStatusSchema.default("accepted"),
    owner: z.string().trim().min(1).default("Matthew"),
    context: z.string().trim().min(1),
    decision: z.string().trim().min(1),
    consequences: z.string().trim().min(1),
    metadata: JsonObjectSchema.default({})
  })
  .strict();
export type UpsertDecisionInput = z.input<typeof UpsertDecisionInputSchema>;

export const BacklogPrioritySchema = z.enum(["now", "next", "later", "parking_lot"]);
export const BacklogStatusSchema = z.enum(["inbox", "ready", "in_progress", "blocked", "done", "cancelled"]);
export const OperationalBacklogItemSchema = z
  .object({
    id: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    description: z.string(),
    priority: BacklogPrioritySchema,
    status: BacklogStatusSchema,
    source: z.string().trim().min(1),
    metadata: JsonObjectSchema.default({})
  })
  .strict();
export type OperationalBacklogItem = z.infer<typeof OperationalBacklogItemSchema>;

export const CreateBacklogItemInputSchema = z
  .object({
    projectSlug: ProjectSlugSchema,
    title: z.string().trim().min(1),
    description: z.string().default(""),
    priority: BacklogPrioritySchema.default("next"),
    status: BacklogStatusSchema.default("ready"),
    source: z.string().trim().min(1).default("runtime"),
    metadata: JsonObjectSchema.default({})
  })
  .strict();
export type CreateBacklogItemInput = z.input<typeof CreateBacklogItemInputSchema>;

export const ImplementationStatusSchema = z.enum(["planned", "in_progress", "in_review", "shipped", "rolled_back", "blocked"]);
export const OperationalImplementationSchema = z
  .object({
    id: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    backlogItemId: z.string().trim().min(1).nullable(),
    title: z.string().trim().min(1),
    status: ImplementationStatusSchema,
    branchName: z.string().trim().min(1).nullable(),
    commitSha: z.string().trim().min(1).nullable(),
    prUrl: z.string().trim().min(1).nullable(),
    summary: z.string(),
    metadata: JsonObjectSchema.default({})
  })
  .strict();
export type OperationalImplementation = z.infer<typeof OperationalImplementationSchema>;

export const CreateImplementationInputSchema = z
  .object({
    projectSlug: ProjectSlugSchema,
    backlogItemId: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1),
    status: ImplementationStatusSchema.default("planned"),
    branchName: z.string().trim().min(1).optional(),
    commitSha: z.string().trim().min(1).optional(),
    prUrl: z.string().trim().min(1).optional(),
    summary: z.string().default(""),
    metadata: JsonObjectSchema.default({})
  })
  .strict();
export type CreateImplementationInput = z.input<typeof CreateImplementationInputSchema>;

export const RecordBlockerInputSchema = z
  .object({
    projectSlug: ProjectSlugSchema,
    title: z.string().trim().min(1),
    body: z.string().trim().min(1),
    source: z.string().trim().min(1).default("runtime"),
    metadata: JsonObjectSchema.default({})
  })
  .strict();
export type RecordBlockerInput = z.input<typeof RecordBlockerInputSchema>;

export const RecordedBlockerSchema = z
  .object({
    stateSnapshot: OperationalStateSnapshotSchema,
    backlogItem: OperationalBacklogItemSchema
  })
  .strict();
export type RecordedBlocker = z.infer<typeof RecordedBlockerSchema>;

export const ListBacklogItemsInputSchema = z
  .object({
    projectSlug: ProjectSlugSchema,
    statuses: z.array(BacklogStatusSchema).default(["ready", "in_progress", "blocked"])
  })
  .strict();
export type ListBacklogItemsInput = z.input<typeof ListBacklogItemsInputSchema>;
