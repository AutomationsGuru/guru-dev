import { randomUUID } from "node:crypto";

export type BackgroundRunStatus = "running" | "done" | "failed";

export interface BackgroundRunRecord {
  readonly runId: string;
  readonly sessionId: string;
  readonly status: BackgroundRunStatus;
}

export interface BackgroundRunRegistry {
  register(runId: string, sessionId: string): BackgroundRunRecord;
  start(sessionId: string): BackgroundRunRecord;
  complete(runId: string): BackgroundRunRecord;
  fail(runId: string): BackgroundRunRecord;
  get(runId: string): BackgroundRunRecord | undefined;
  list(): readonly BackgroundRunRecord[];
}

interface MutableBackgroundRunRecord {
  readonly runId: string;
  readonly sessionId: string;
  status: BackgroundRunStatus;
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Background run ${label} is required.`);
  }
  return normalized;
}

function snapshot(record: MutableBackgroundRunRecord): BackgroundRunRecord {
  return { ...record };
}

export function createBackgroundRunRegistry(): BackgroundRunRegistry {
  const records = new Map<string, MutableBackgroundRunRecord>();

  const getRequired = (runId: string): MutableBackgroundRunRecord => {
    const normalizedRunId = requireIdentifier(runId, "id");
    const record = records.get(normalizedRunId);
    if (!record) {
      throw new Error(`Unknown background run id: ${normalizedRunId}`);
    }
    return record;
  };

  const transition = (runId: string, status: Exclude<BackgroundRunStatus, "running">): BackgroundRunRecord => {
    const record = getRequired(runId);
    if (record.status !== "running") {
      throw new Error(`Background run ${record.runId} is already ${record.status}.`);
    }
    record.status = status;
    return snapshot(record);
  };

  const register = (runId: string, sessionId: string): BackgroundRunRecord => {
    const normalizedRunId = requireIdentifier(runId, "id");
    if (records.has(normalizedRunId)) {
      throw new Error(`Background run id already exists: ${normalizedRunId}`);
    }
    const record: MutableBackgroundRunRecord = {
      runId: normalizedRunId,
      sessionId: requireIdentifier(sessionId, "session id"),
      status: "running"
    };
    records.set(record.runId, record);
    return snapshot(record);
  };

  return {
    register,
    start(sessionId) {
      return register(randomUUID(), sessionId);
    },
    complete(runId) {
      return transition(runId, "done");
    },
    fail(runId) {
      return transition(runId, "failed");
    },
    get(runId) {
      const normalizedRunId = requireIdentifier(runId, "id");
      const record = records.get(normalizedRunId);
      return record ? snapshot(record) : undefined;
    },
    list() {
      return [...records.values()].map(snapshot);
    }
  };
}
