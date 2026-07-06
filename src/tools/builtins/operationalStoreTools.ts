import { z } from "zod";

import {
  CreateBacklogItemInputSchema,
  CreateImplementationInputSchema,
  ListBacklogItemsInputSchema,
  ListStateSnapshotsInputSchema,
  OperationalBacklogItemSchema,
  OperationalDecisionSchema,
  OperationalImplementationSchema,
  OperationalProjectSchema,
  OperationalStateSnapshotSchema,
  ProjectSlugSchema,
  RecordedBlockerSchema,
  RecordBlockerInputSchema,
  UpsertDecisionInputSchema,
  WriteStateSnapshotInputSchema,
  type CreateBacklogItemInput,
  type CreateImplementationInput,
  type OperationalBacklogItem,
  type OperationalDecision,
  type OperationalImplementation,
  type OperationalProject,
  type OperationalStateSnapshot,
  type RecordedBlocker,
  type UpsertDecisionInput,
  type WriteStateSnapshotInput
} from "../../operational/schemas.js";
import type { OperationalStore } from "../../operational/store.js";
import { guardContent, type ToolPolicy } from "../../safety/policyGuard.js";
import type { ToolDefinition } from "../registry.js";

export const GetOperationalProjectToolInputSchema = z.object({
  projectSlug: ProjectSlugSchema
});

export const GetOperationalProjectToolOutputSchema = z.object({
  project: OperationalProjectSchema.nullable()
});

export type GetOperationalProjectToolInput = z.infer<typeof GetOperationalProjectToolInputSchema>;
export type GetOperationalProjectToolOutput = z.infer<typeof GetOperationalProjectToolOutputSchema>;

export function createGetOperationalProjectTool(
  store: OperationalStore
): ToolDefinition<typeof GetOperationalProjectToolInputSchema, typeof GetOperationalProjectToolOutputSchema> {
  return {
    id: "operational.project.get",
    title: "Get operational project",
    description: "Read a GuruHarness operational project by slug from the runtime store.",
    inputSchema: GetOperationalProjectToolInputSchema,
    outputSchema: GetOperationalProjectToolOutputSchema,
    async execute(input) {
      const project = await store.getProjectBySlug(input.projectSlug);

      return { project: project ? materializeProject(project) : null };
    }
  };
}

export const RecordOperationalBlockerToolInputSchema = RecordBlockerInputSchema;
export const RecordOperationalBlockerToolOutputSchema = RecordedBlockerSchema;

export type RecordOperationalBlockerToolInput = z.infer<typeof RecordOperationalBlockerToolInputSchema>;
export type RecordOperationalBlockerToolOutput = z.infer<typeof RecordOperationalBlockerToolOutputSchema>;

export function createRecordOperationalBlockerTool(
  store: OperationalStore
): ToolDefinition<typeof RecordOperationalBlockerToolInputSchema, typeof RecordOperationalBlockerToolOutputSchema> {
  return {
    id: "operational.blocker.record",
    title: "Record operational blocker",
    description: "Write a blocker as both a risk state snapshot and blocked backlog item in the runtime store.",
    inputSchema: RecordOperationalBlockerToolInputSchema,
    outputSchema: RecordOperationalBlockerToolOutputSchema,
    async execute(input) {
      return materializeBlocker(await store.recordBlocker(input));
    }
  };
}

const OperationalMutationOutputBaseSchema = z
  .object({
    dryRun: z.boolean(),
    blockers: z.array(z.string()),
    summary: z.string()
  })
  .strict();

export const WriteOperationalStateSnapshotToolInputSchema = WriteStateSnapshotInputSchema.extend({
  dryRun: z.boolean().default(true)
}).strict();
export const WriteOperationalStateSnapshotToolOutputSchema = OperationalMutationOutputBaseSchema.extend({
  snapshot: OperationalStateSnapshotSchema.nullable()
}).strict();

export const ListOperationalStateSnapshotsToolInputSchema = ListStateSnapshotsInputSchema;
export const ListOperationalStateSnapshotsToolOutputSchema = z
  .object({
    snapshots: z.array(OperationalStateSnapshotSchema),
    summary: z.string()
  })
  .strict();

export const UpsertOperationalDecisionToolInputSchema = UpsertDecisionInputSchema.extend({
  dryRun: z.boolean().default(true)
}).strict();
export const UpsertOperationalDecisionToolOutputSchema = OperationalMutationOutputBaseSchema.extend({
  decision: OperationalDecisionSchema.nullable()
}).strict();

export const CreateOperationalBacklogItemToolInputSchema = CreateBacklogItemInputSchema.extend({
  dryRun: z.boolean().default(true)
}).strict();
export const CreateOperationalBacklogItemToolOutputSchema = OperationalMutationOutputBaseSchema.extend({
  item: OperationalBacklogItemSchema.nullable()
}).strict();

export const ListOperationalBacklogItemsToolInputSchema = ListBacklogItemsInputSchema;
export const ListOperationalBacklogItemsToolOutputSchema = z
  .object({
    items: z.array(OperationalBacklogItemSchema),
    summary: z.string()
  })
  .strict();

export const CreateOperationalImplementationToolInputSchema = CreateImplementationInputSchema.extend({
  dryRun: z.boolean().default(true)
}).strict();
export const CreateOperationalImplementationToolOutputSchema = OperationalMutationOutputBaseSchema.extend({
  implementation: OperationalImplementationSchema.nullable()
}).strict();

export type WriteOperationalStateSnapshotToolInput = z.infer<typeof WriteOperationalStateSnapshotToolInputSchema>;
export type WriteOperationalStateSnapshotToolOutput = z.infer<typeof WriteOperationalStateSnapshotToolOutputSchema>;
export type ListOperationalStateSnapshotsToolInput = z.infer<typeof ListOperationalStateSnapshotsToolInputSchema>;
export type ListOperationalStateSnapshotsToolOutput = z.infer<typeof ListOperationalStateSnapshotsToolOutputSchema>;
export type UpsertOperationalDecisionToolInput = z.infer<typeof UpsertOperationalDecisionToolInputSchema>;
export type UpsertOperationalDecisionToolOutput = z.infer<typeof UpsertOperationalDecisionToolOutputSchema>;
export type CreateOperationalBacklogItemToolInput = z.infer<typeof CreateOperationalBacklogItemToolInputSchema>;
export type CreateOperationalBacklogItemToolOutput = z.infer<typeof CreateOperationalBacklogItemToolOutputSchema>;
export type ListOperationalBacklogItemsToolInput = z.infer<typeof ListOperationalBacklogItemsToolInputSchema>;
export type ListOperationalBacklogItemsToolOutput = z.infer<typeof ListOperationalBacklogItemsToolOutputSchema>;
export type CreateOperationalImplementationToolInput = z.infer<typeof CreateOperationalImplementationToolInputSchema>;
export type CreateOperationalImplementationToolOutput = z.infer<typeof CreateOperationalImplementationToolOutputSchema>;

export interface OperationalStoreToolOptions {
  readonly secretAllowList?: readonly string[];
}

export function createWriteOperationalStateSnapshotTool(
  store: OperationalStore,
  options: OperationalStoreToolOptions = {}
): ToolDefinition<typeof WriteOperationalStateSnapshotToolInputSchema, typeof WriteOperationalStateSnapshotToolOutputSchema> {
  return {
    id: "operational.state.write",
    title: "Write operational state snapshot",
    description: "Write a current/future/path/risk/note snapshot with dry-run by default and secret-content checks.",
    inputSchema: WriteOperationalStateSnapshotToolInputSchema,
    outputSchema: WriteOperationalStateSnapshotToolOutputSchema,
    async execute(input) {
      const blockers = guardOperationalInput(input, options.secretAllowList ?? []);
      if (blockers.length > 0 || input.dryRun) {
        return mutationOutput("snapshot", null, input.dryRun, blockers, blockers.length > 0 ? "Operational state snapshot blocked by policy." : "Dry run only; state snapshot was not written.");
      }

      return mutationOutput("snapshot", materializeStateSnapshot(await store.writeStateSnapshot(toStateSnapshotInput(input))), false, [], "Operational state snapshot written.");
    }
  };
}

export function createListOperationalStateSnapshotsTool(
  store: OperationalStore
): ToolDefinition<typeof ListOperationalStateSnapshotsToolInputSchema, typeof ListOperationalStateSnapshotsToolOutputSchema> {
  return {
    id: "operational.state.list",
    title: "List operational state snapshots",
    description: "List operational state snapshots by kind, source, and metadata filter.",
    inputSchema: ListOperationalStateSnapshotsToolInputSchema,
    outputSchema: ListOperationalStateSnapshotsToolOutputSchema,
    async execute(input) {
      const snapshots = await store.listStateSnapshots(input);

      return { snapshots: snapshots.map(materializeStateSnapshot), summary: `Found ${snapshots.length} operational state snapshot(s).` };
    }
  };
}

export function createUpsertOperationalDecisionTool(
  store: OperationalStore,
  options: OperationalStoreToolOptions = {}
): ToolDefinition<typeof UpsertOperationalDecisionToolInputSchema, typeof UpsertOperationalDecisionToolOutputSchema> {
  return {
    id: "operational.decision.upsert",
    title: "Upsert operational decision",
    description: "Create or update a project decision with dry-run by default and secret-content checks.",
    inputSchema: UpsertOperationalDecisionToolInputSchema,
    outputSchema: UpsertOperationalDecisionToolOutputSchema,
    async execute(input) {
      const blockers = guardOperationalInput(input, options.secretAllowList ?? []);
      if (blockers.length > 0 || input.dryRun) {
        return mutationOutput("decision", null, input.dryRun, blockers, blockers.length > 0 ? "Operational decision blocked by policy." : "Dry run only; decision was not upserted.");
      }

      return mutationOutput("decision", materializeDecision(await store.upsertDecision(toDecisionInput(input))), false, [], "Operational decision upserted.");
    }
  };
}

export function createCreateOperationalBacklogItemTool(
  store: OperationalStore,
  options: OperationalStoreToolOptions = {}
): ToolDefinition<typeof CreateOperationalBacklogItemToolInputSchema, typeof CreateOperationalBacklogItemToolOutputSchema> {
  return {
    id: "operational.backlog.create",
    title: "Create operational backlog item",
    description: "Create a project backlog item with dry-run by default and secret-content checks.",
    inputSchema: CreateOperationalBacklogItemToolInputSchema,
    outputSchema: CreateOperationalBacklogItemToolOutputSchema,
    async execute(input) {
      const blockers = guardOperationalInput(input, options.secretAllowList ?? []);
      if (blockers.length > 0 || input.dryRun) {
        return mutationOutput("item", null, input.dryRun, blockers, blockers.length > 0 ? "Operational backlog item blocked by policy." : "Dry run only; backlog item was not created.");
      }

      return mutationOutput("item", materializeBacklogItem(await store.createBacklogItem(toBacklogInput(input))), false, [], "Operational backlog item created.");
    }
  };
}

export function createListOperationalBacklogItemsTool(
  store: OperationalStore
): ToolDefinition<typeof ListOperationalBacklogItemsToolInputSchema, typeof ListOperationalBacklogItemsToolOutputSchema> {
  return {
    id: "operational.backlog.list",
    title: "List operational backlog items",
    description: "List operational backlog items by status.",
    inputSchema: ListOperationalBacklogItemsToolInputSchema,
    outputSchema: ListOperationalBacklogItemsToolOutputSchema,
    async execute(input) {
      const items = await store.listBacklogItems(input);

      return { items: items.map(materializeBacklogItem), summary: `Found ${items.length} operational backlog item(s).` };
    }
  };
}

export function createCreateOperationalImplementationTool(
  store: OperationalStore,
  options: OperationalStoreToolOptions = {}
): ToolDefinition<typeof CreateOperationalImplementationToolInputSchema, typeof CreateOperationalImplementationToolOutputSchema> {
  return {
    id: "operational.implementation.create",
    title: "Create operational implementation record",
    description: "Create an implementation/status record with dry-run by default and secret-content checks.",
    inputSchema: CreateOperationalImplementationToolInputSchema,
    outputSchema: CreateOperationalImplementationToolOutputSchema,
    async execute(input) {
      const blockers = guardOperationalInput(input, options.secretAllowList ?? []);
      if (blockers.length > 0 || input.dryRun) {
        return mutationOutput("implementation", null, input.dryRun, blockers, blockers.length > 0 ? "Operational implementation blocked by policy." : "Dry run only; implementation was not created.");
      }

      return mutationOutput("implementation", materializeImplementation(await store.createImplementation(toImplementationInput(input))), false, [], "Operational implementation created.");
    }
  };
}

function guardOperationalInput(input: Record<string, unknown>, secretAllowList: readonly string[]): string[] {
  const textFields = Object.entries(input)
    .filter(([key]) => key !== "dryRun")
    .map(([key, value]) => ({ name: key, value: typeof value === "string" ? value : JSON.stringify(value) }));
  const policy: ToolPolicy = {
    repoRoot: process.cwd(),
    riskyPathPatterns: [],
    secretAllowList,
    allowRiskyPaths: false
  };

  return [...guardContent(textFields, policy).blockers];
}

function mutationOutput<TKey extends string, TValue>(
  key: TKey,
  value: TValue,
  dryRun: boolean,
  blockers: readonly string[],
  summary: string
): { readonly [K in TKey]: TValue } & { readonly dryRun: boolean; readonly blockers: string[]; readonly summary: string } {
  return {
    [key]: value,
    dryRun,
    blockers: [...blockers],
    summary
  } as { readonly [K in TKey]: TValue } & { readonly dryRun: boolean; readonly blockers: string[]; readonly summary: string };
}

function toStateSnapshotInput(input: WriteOperationalStateSnapshotToolInput): WriteStateSnapshotInput {
  const { dryRun: _dryRun, ...rest } = input;

  return rest;
}

function toDecisionInput(input: UpsertOperationalDecisionToolInput): UpsertDecisionInput {
  const { dryRun: _dryRun, ...rest } = input;

  return rest;
}

function toBacklogInput(input: CreateOperationalBacklogItemToolInput): CreateBacklogItemInput {
  const { dryRun: _dryRun, ...rest } = input;

  return rest;
}

function toImplementationInput(input: CreateOperationalImplementationToolInput): CreateImplementationInput {
  const { dryRun: _dryRun, ...rest } = input;

  return rest;
}

function materializeProject(project: OperationalProject): OperationalProject {
  return { ...project, metadata: structuredClone(project.metadata) };
}

function materializeStateSnapshot(snapshot: OperationalStateSnapshot): OperationalStateSnapshot {
  return { ...snapshot, metadata: structuredClone(snapshot.metadata) };
}

function materializeDecision(decision: OperationalDecision): OperationalDecision {
  return { ...decision, metadata: structuredClone(decision.metadata) };
}

function materializeBacklogItem(item: OperationalBacklogItem): OperationalBacklogItem {
  return { ...item, metadata: structuredClone(item.metadata) };
}

function materializeImplementation(implementation: OperationalImplementation): OperationalImplementation {
  return { ...implementation, metadata: structuredClone(implementation.metadata) };
}

function materializeBlocker(blocker: RecordedBlocker): RecordedBlocker {
  return {
    stateSnapshot: materializeStateSnapshot(blocker.stateSnapshot),
    backlogItem: materializeBacklogItem(blocker.backlogItem)
  };
}
