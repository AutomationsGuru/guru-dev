import { randomUUID } from "node:crypto";
import type { z } from "zod";

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
  RecordBlockerInputSchema,
  UpsertDecisionInputSchema,
  WriteStateSnapshotInputSchema,
  type CreateBacklogItemInput,
  type CreateImplementationInput,
  type JsonObject,
  type ListBacklogItemsInput,
  type ListStateSnapshotsInput,
  type OperationalBacklogItem,
  type OperationalDecision,
  type OperationalImplementation,
  type OperationalProject,
  type OperationalStateSnapshot,
  type RecordedBlocker,
  type RecordBlockerInput,
  type UpsertDecisionInput,
  type WriteStateSnapshotInput
} from "./schemas.js";

export interface SqlStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

export interface SqlQueryResult<TRow extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly TRow[];
}

export interface SqlClient {
  query(statement: SqlStatement): Promise<SqlQueryResult>;
}

export interface TransactionalSqlClient extends SqlClient {
  transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T>;
}

export interface OperationalStore {
  getProjectBySlug(slug: string): Promise<OperationalProject | undefined>;
  writeStateSnapshot(input: WriteStateSnapshotInput): Promise<OperationalStateSnapshot>;
  listStateSnapshots(input: ListStateSnapshotsInput): Promise<readonly OperationalStateSnapshot[]>;
  upsertDecision(input: UpsertDecisionInput): Promise<OperationalDecision>;
  createBacklogItem(input: CreateBacklogItemInput): Promise<OperationalBacklogItem>;
  listBacklogItems(input: ListBacklogItemsInput): Promise<readonly OperationalBacklogItem[]>;
  createImplementation(input: CreateImplementationInput): Promise<OperationalImplementation>;
  recordBlocker(input: RecordBlockerInput): Promise<RecordedBlocker>;
}

export function createPostgresOperationalStore(sqlClient: SqlClient): OperationalStore {
  return new PostgresOperationalStore(sqlClient);
}

export function createInMemoryOperationalStore(projects: readonly OperationalProject[] = [createDefaultProject()]): OperationalStore {
  return new InMemoryOperationalStore(projects);
}

type ParsedRecordBlockerInput = z.infer<typeof RecordBlockerInputSchema>;

class PostgresOperationalStore implements OperationalStore {
  constructor(private readonly sqlClient: SqlClient) {}

  async getProjectBySlug(slug: string): Promise<OperationalProject | undefined> {
    const result = await this.sqlClient.query({
      text: `
        select id, slug, name, purpose, status, metadata
        from harness.projects
        where slug = $1
        limit 1
      `,
      values: [slug]
    });
    const row = result.rows[0];

    return row ? parseProjectRow(row) : undefined;
  }

  async writeStateSnapshot(input: WriteStateSnapshotInput): Promise<OperationalStateSnapshot> {
    const parsedInput = WriteStateSnapshotInputSchema.parse(input);
    const project = await this.requireProject(parsedInput.projectSlug);
    const result = await this.sqlClient.query({
      text: `
        insert into harness.state_snapshots (project_id, kind, title, body, source, confidence, metadata)
        values ($1, $2, $3, $4, $5, $6, $7::jsonb)
        returning id, project_id, kind, title, body, source, confidence, metadata
      `,
      values: [
        project.id,
        parsedInput.kind,
        parsedInput.title,
        parsedInput.body,
        parsedInput.source,
        parsedInput.confidence,
        JSON.stringify(parsedInput.metadata)
      ]
    });

    return parseRequiredRow(result, parseStateSnapshotRow, "state snapshot");
  }

  async listStateSnapshots(input: ListStateSnapshotsInput): Promise<readonly OperationalStateSnapshot[]> {
    const parsedInput = ListStateSnapshotsInputSchema.parse(input);
    const project = await this.requireProject(parsedInput.projectSlug);
    const result = await this.sqlClient.query({
      text: `
        select id, project_id, kind, title, body, source, confidence, metadata
        from harness.state_snapshots
        where project_id = $1
          and kind = any($2::text[])
          and ($3::text is null or source = $3)
          and metadata @> $4::jsonb
        order by created_at asc, id asc
      `,
      values: [project.id, parsedInput.kinds, parsedInput.source ?? null, JSON.stringify(parsedInput.metadata)]
    });

    return result.rows.map(parseStateSnapshotRow);
  }

  async upsertDecision(input: UpsertDecisionInput): Promise<OperationalDecision> {
    const parsedInput = UpsertDecisionInputSchema.parse(input);
    const project = await this.requireProject(parsedInput.projectSlug);
    const result = await this.sqlClient.query({
      text: `
        insert into harness.decisions (project_id, decision_key, title, status, owner, context, decision, consequences, metadata)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        on conflict (project_id, decision_key) do update
        set
          title = excluded.title,
          status = excluded.status,
          owner = excluded.owner,
          context = excluded.context,
          decision = excluded.decision,
          consequences = excluded.consequences,
          metadata = excluded.metadata
        returning id, project_id, decision_key, title, status, owner, context, decision, consequences, metadata
      `,
      values: [
        project.id,
        parsedInput.decisionKey,
        parsedInput.title,
        parsedInput.status,
        parsedInput.owner,
        parsedInput.context,
        parsedInput.decision,
        parsedInput.consequences,
        JSON.stringify(parsedInput.metadata)
      ]
    });

    return parseRequiredRow(result, parseDecisionRow, "decision");
  }

  async createBacklogItem(input: CreateBacklogItemInput): Promise<OperationalBacklogItem> {
    const parsedInput = CreateBacklogItemInputSchema.parse(input);
    const project = await this.requireProject(parsedInput.projectSlug);
    const result = await this.sqlClient.query({
      text: `
        insert into harness.backlog_items (project_id, title, description, priority, status, source, metadata)
        values ($1, $2, $3, $4, $5, $6, $7::jsonb)
        returning id, project_id, title, description, priority, status, source, metadata
      `,
      values: [
        project.id,
        parsedInput.title,
        parsedInput.description,
        parsedInput.priority,
        parsedInput.status,
        parsedInput.source,
        JSON.stringify(parsedInput.metadata)
      ]
    });

    return parseRequiredRow(result, parseBacklogItemRow, "backlog item");
  }

  async listBacklogItems(input: ListBacklogItemsInput): Promise<readonly OperationalBacklogItem[]> {
    const parsedInput = ListBacklogItemsInputSchema.parse(input);
    const project = await this.requireProject(parsedInput.projectSlug);
    const result = await this.sqlClient.query({
      text: `
        select id, project_id, title, description, priority, status, source, metadata
        from harness.backlog_items
        where project_id = $1 and status = any($2::text[])
        order by created_at desc
      `,
      values: [project.id, parsedInput.statuses]
    });

    return result.rows.map(parseBacklogItemRow);
  }

  async createImplementation(input: CreateImplementationInput): Promise<OperationalImplementation> {
    const parsedInput = CreateImplementationInputSchema.parse(input);
    const project = await this.requireProject(parsedInput.projectSlug);
    const result = await this.sqlClient.query({
      text: `
        insert into harness.implementations (
          project_id,
          backlog_item_id,
          title,
          status,
          branch_name,
          commit_sha,
          pr_url,
          summary,
          metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        returning id, project_id, backlog_item_id, title, status, branch_name, commit_sha, pr_url, summary, metadata
      `,
      values: [
        project.id,
        parsedInput.backlogItemId ?? null,
        parsedInput.title,
        parsedInput.status,
        parsedInput.branchName ?? null,
        parsedInput.commitSha ?? null,
        parsedInput.prUrl ?? null,
        parsedInput.summary,
        JSON.stringify(parsedInput.metadata)
      ]
    });

    return parseRequiredRow(result, parseImplementationRow, "implementation");
  }

  async recordBlocker(input: RecordBlockerInput): Promise<RecordedBlocker> {
    const parsedInput = RecordBlockerInputSchema.parse(input);

    if (isTransactionalSqlClient(this.sqlClient)) {
      return this.sqlClient.transaction(async (transactionClient) =>
        new PostgresOperationalStore(transactionClient).recordParsedBlocker(parsedInput)
      );
    }

    return this.recordParsedBlocker(parsedInput);
  }

  private async recordParsedBlocker(parsedInput: ParsedRecordBlockerInput): Promise<RecordedBlocker> {
    const stateSnapshot = await this.writeStateSnapshot({
      projectSlug: parsedInput.projectSlug,
      kind: "risk",
      title: parsedInput.title,
      body: parsedInput.body,
      source: parsedInput.source,
      metadata: parsedInput.metadata
    });
    const backlogItem = await this.createBacklogItem({
      projectSlug: parsedInput.projectSlug,
      title: parsedInput.title,
      description: parsedInput.body,
      priority: "next",
      status: "blocked",
      source: parsedInput.source,
      metadata: parsedInput.metadata
    });

    return { stateSnapshot, backlogItem };
  }

  private async requireProject(slug: string): Promise<OperationalProject> {
    const project = await this.getProjectBySlug(slug);

    if (!project) {
      throw new Error(`Operational project not found: ${slug}`);
    }

    return project;
  }
}

class InMemoryOperationalStore implements OperationalStore {
  private readonly projects = new Map<string, OperationalProject>();
  private readonly stateSnapshots: OperationalStateSnapshot[] = [];
  private readonly stateSnapshotSequences = new Map<string, number>();
  private nextStateSnapshotSequence = 0;
  private readonly decisions: OperationalDecision[] = [];
  private readonly backlogItems: OperationalBacklogItem[] = [];
  private readonly implementations: OperationalImplementation[] = [];

  constructor(projects: readonly OperationalProject[]) {
    for (const project of projects) {
      this.projects.set(project.slug, OperationalProjectSchema.parse(project));
    }
  }

  async getProjectBySlug(slug: string): Promise<OperationalProject | undefined> {
    const project = this.projects.get(slug);

    return project ? { ...project, metadata: structuredClone(project.metadata) } : undefined;
  }

  async writeStateSnapshot(input: WriteStateSnapshotInput): Promise<OperationalStateSnapshot> {
    const parsedInput = WriteStateSnapshotInputSchema.parse(input);
    const project = await this.requireProject(parsedInput.projectSlug);
    const snapshot = OperationalStateSnapshotSchema.parse({
      id: randomUUID(),
      projectId: project.id,
      kind: parsedInput.kind,
      title: parsedInput.title,
      body: parsedInput.body,
      source: parsedInput.source,
      confidence: parsedInput.confidence,
      metadata: parsedInput.metadata
    });

    this.stateSnapshots.push(snapshot);
    this.stateSnapshotSequences.set(snapshot.id, this.nextStateSnapshotSequence);
    this.nextStateSnapshotSequence += 1;

    return cloneStateSnapshot(snapshot);
  }

  async listStateSnapshots(input: ListStateSnapshotsInput): Promise<readonly OperationalStateSnapshot[]> {
    const parsedInput = ListStateSnapshotsInputSchema.parse(input);
    const project = await this.requireProject(parsedInput.projectSlug);
    const kinds = new Set(parsedInput.kinds);

    return this.stateSnapshots
      .filter((snapshot) => snapshot.projectId === project.id)
      .filter((snapshot) => kinds.has(snapshot.kind))
      .filter((snapshot) => !parsedInput.source || snapshot.source === parsedInput.source)
      .filter((snapshot) => metadataContains(snapshot.metadata, parsedInput.metadata))
      .sort((left, right) => getStateSnapshotSequence(this.stateSnapshotSequences, left) - getStateSnapshotSequence(this.stateSnapshotSequences, right))
      .map(cloneStateSnapshot);
  }

  async upsertDecision(input: UpsertDecisionInput): Promise<OperationalDecision> {
    const parsedInput = UpsertDecisionInputSchema.parse(input);
    const project = await this.requireProject(parsedInput.projectSlug);
    const existingIndex = this.decisions.findIndex(
      (decision) => decision.projectId === project.id && decision.decisionKey === parsedInput.decisionKey
    );
    const decision = OperationalDecisionSchema.parse({
      id: existingIndex >= 0 ? this.decisions[existingIndex]?.id : randomUUID(),
      projectId: project.id,
      decisionKey: parsedInput.decisionKey,
      title: parsedInput.title,
      status: parsedInput.status,
      owner: parsedInput.owner,
      context: parsedInput.context,
      decision: parsedInput.decision,
      consequences: parsedInput.consequences,
      metadata: parsedInput.metadata
    });

    if (existingIndex >= 0) {
      this.decisions[existingIndex] = decision;
    } else {
      this.decisions.push(decision);
    }

    return cloneDecision(decision);
  }

  async createBacklogItem(input: CreateBacklogItemInput): Promise<OperationalBacklogItem> {
    const parsedInput = CreateBacklogItemInputSchema.parse(input);
    const project = await this.requireProject(parsedInput.projectSlug);
    const backlogItem = OperationalBacklogItemSchema.parse({
      id: randomUUID(),
      projectId: project.id,
      title: parsedInput.title,
      description: parsedInput.description,
      priority: parsedInput.priority,
      status: parsedInput.status,
      source: parsedInput.source,
      metadata: parsedInput.metadata
    });

    this.backlogItems.push(backlogItem);

    return cloneBacklogItem(backlogItem);
  }

  async listBacklogItems(input: ListBacklogItemsInput): Promise<readonly OperationalBacklogItem[]> {
    const parsedInput = ListBacklogItemsInputSchema.parse(input);
    const project = await this.requireProject(parsedInput.projectSlug);
    const statuses = new Set(parsedInput.statuses);

    return this.backlogItems
      .filter((item) => item.projectId === project.id && statuses.has(item.status))
      .reverse()
      .map(cloneBacklogItem);
  }

  async createImplementation(input: CreateImplementationInput): Promise<OperationalImplementation> {
    const parsedInput = CreateImplementationInputSchema.parse(input);
    const project = await this.requireProject(parsedInput.projectSlug);
    const implementation = OperationalImplementationSchema.parse({
      id: randomUUID(),
      projectId: project.id,
      backlogItemId: parsedInput.backlogItemId ?? null,
      title: parsedInput.title,
      status: parsedInput.status,
      branchName: parsedInput.branchName ?? null,
      commitSha: parsedInput.commitSha ?? null,
      prUrl: parsedInput.prUrl ?? null,
      summary: parsedInput.summary,
      metadata: parsedInput.metadata
    });

    this.implementations.push(implementation);

    return cloneImplementation(implementation);
  }

  async recordBlocker(input: RecordBlockerInput): Promise<RecordedBlocker> {
    const parsedInput = RecordBlockerInputSchema.parse(input);
    const stateSnapshot = await this.writeStateSnapshot({
      projectSlug: parsedInput.projectSlug,
      kind: "risk",
      title: parsedInput.title,
      body: parsedInput.body,
      source: parsedInput.source,
      metadata: parsedInput.metadata
    });
    const backlogItem = await this.createBacklogItem({
      projectSlug: parsedInput.projectSlug,
      title: parsedInput.title,
      description: parsedInput.body,
      priority: "next",
      status: "blocked",
      source: parsedInput.source,
      metadata: parsedInput.metadata
    });

    return { stateSnapshot, backlogItem };
  }

  private async requireProject(slug: string): Promise<OperationalProject> {
    const project = await this.getProjectBySlug(slug);

    if (!project) {
      throw new Error(`Operational project not found: ${slug}`);
    }

    return project;
  }
}

function isTransactionalSqlClient(client: SqlClient): client is TransactionalSqlClient {
  return "transaction" in client && typeof client.transaction === "function";
}

function createDefaultProject(): OperationalProject {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    slug: "guruharness",
    name: "GuruHarness",
    purpose: "Independent agent harness operational runtime store.",
    status: "active",
    metadata: {}
  };
}

function parseRequiredRow<T>(
  result: SqlQueryResult,
  parser: (row: Record<string, unknown>) => T,
  label: string
): T {
  const row = result.rows[0];

  if (!row) {
    throw new Error(`No ${label} row returned from operational store.`);
  }

  return parser(row);
}

function parseProjectRow(row: Record<string, unknown>): OperationalProject {
  return OperationalProjectSchema.parse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    purpose: row.purpose,
    status: row.status,
    metadata: normalizeMetadata(row.metadata)
  });
}

function parseStateSnapshotRow(row: Record<string, unknown>): OperationalStateSnapshot {
  return OperationalStateSnapshotSchema.parse({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    source: row.source,
    confidence: normalizeNumber(row.confidence),
    metadata: normalizeMetadata(row.metadata)
  });
}

function parseDecisionRow(row: Record<string, unknown>): OperationalDecision {
  return OperationalDecisionSchema.parse({
    id: row.id,
    projectId: row.project_id,
    decisionKey: row.decision_key,
    title: row.title,
    status: row.status,
    owner: row.owner,
    context: row.context,
    decision: row.decision,
    consequences: row.consequences,
    metadata: normalizeMetadata(row.metadata)
  });
}

function parseBacklogItemRow(row: Record<string, unknown>): OperationalBacklogItem {
  return OperationalBacklogItemSchema.parse({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    source: row.source,
    metadata: normalizeMetadata(row.metadata)
  });
}

function parseImplementationRow(row: Record<string, unknown>): OperationalImplementation {
  return OperationalImplementationSchema.parse({
    id: row.id,
    projectId: row.project_id,
    backlogItemId: row.backlog_item_id,
    title: row.title,
    status: row.status,
    branchName: row.branch_name,
    commitSha: row.commit_sha,
    prUrl: row.pr_url,
    summary: row.summary,
    metadata: normalizeMetadata(row.metadata)
  });
}

function getStateSnapshotSequence(
  sequences: ReadonlyMap<string, number>,
  snapshot: OperationalStateSnapshot
): number {
  return sequences.get(snapshot.id) ?? Number.MAX_SAFE_INTEGER;
}

function metadataContains(metadata: JsonObject, filter: JsonObject): boolean {
  return containsJson(metadata, filter);
}

function containsJson(value: unknown, filter: unknown): boolean {
  if (Array.isArray(filter)) {
    return Array.isArray(value) && filter.every((filterItem) => value.some((item) => containsJson(item, filterItem)));
  }

  if (isPlainObject(filter)) {
    return isPlainObject(value) && Object.entries(filter).every(([key, childFilter]) => containsJson(value[key], childFilter));
  }

  return value === filter;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMetadata(value: unknown): JsonObject {
  if (typeof value === "string") {
    return parseMetadataString(value);
  }

  return isPlainObject(value) ? { ...value } : {};
}

function parseMetadataString(value: string): JsonObject {
  try {
    const parsed = JSON.parse(value) as unknown;

    return normalizeMetadata(parsed);
  } catch {
    return {};
  }
}

function normalizeNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function cloneStateSnapshot(snapshot: OperationalStateSnapshot): OperationalStateSnapshot {
  return { ...snapshot, metadata: structuredClone(snapshot.metadata) };
}

function cloneDecision(decision: OperationalDecision): OperationalDecision {
  return { ...decision, metadata: structuredClone(decision.metadata) };
}

function cloneBacklogItem(item: OperationalBacklogItem): OperationalBacklogItem {
  return { ...item, metadata: structuredClone(item.metadata) };
}

function cloneImplementation(implementation: OperationalImplementation): OperationalImplementation {
  return { ...implementation, metadata: structuredClone(implementation.metadata) };
}
