import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  PLAN_BRANCH_MAINLINE,
  PlanBranchRecordSchema,
  createPlanBranchRecord,
  isValidPlanBranchName,
  planBranchFileName,
  type PlanBranchCheckpoint,
  type PlanBranchRecord,
  type PlanBranchStateInput
} from "./planBranch.js";

/**
 * PlanBranchStore (IDEA-F11-PLAN-BRANCH) — file-backed named forks of session
 * plan state. One JSON record per branch under the store directory, written
 * atomically (tmp+rename); corrupt or foreign files are skipped on read so a
 * bad branch can never wedge the session. Exactly one branch is active at a
 * time; resume reads the active branch's checkpoint, and sibling branches stay
 * isolated — checkpointing one branch never touches another's file.
 *
 * The mainline (`main`) is seeded lazily from the plan state in flight at the
 * first fork/checkpoint, so switching back to `main` restores the pre-fork
 * snapshot. Branching is session-state only — no git branch is created.
 */

export interface PlanBranchStoreOptions {
  /** Directory holding one <name>.json per branch (tests / per-session scope). */
  readonly directory: string;
  readonly now?: () => Date;
}

export interface PlanBranchForkOptions {
  /** Provenance: branch the fork is taken from. Defaults to the active branch (or mainline). */
  readonly from?: string;
}

export interface PlanBranchStore {
  readonly directory: string;
  /** Checkpoint current plan state under a new named branch and make it active. */
  fork(name: string, input: PlanBranchStateInput, options?: PlanBranchForkOptions): PlanBranchRecord;
  /** Activate an existing branch; exactly one branch is active afterwards. */
  switch(name: string): PlanBranchRecord;
  /** Re-checkpoint the active branch in place. */
  checkpoint(input: PlanBranchStateInput): PlanBranchRecord;
  /** Delete a branch. Deleting the active branch falls back to the mainline. */
  delete(name: string): void;
  /** All readable branch records, oldest first. */
  list(): PlanBranchRecord[];
  /** Name of the active branch, or null when the store is empty. */
  current(): string | null;
  /** Checkpoint for a branch (default: active) for resume injection; null if missing/corrupt. */
  readCheckpoint(name?: string): PlanBranchCheckpoint | null;
  /** The mainline record, or null when the store is empty. */
  mainlineRecord(): PlanBranchRecord | null;
}

export function createPlanBranchStore(options: PlanBranchStoreOptions): PlanBranchStore {
  const directory = options.directory;
  const now = options.now ?? (() => new Date());

  const ensureDir = (): void => {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
  };

  const recordPath = (name: string): string => join(directory, planBranchFileName(name));

  const writeAtomic = (path: string, content: string): void => {
    ensureDir();
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  };

  const writeRecord = (record: PlanBranchRecord): void => {
    writeAtomic(recordPath(record.name), `${JSON.stringify(record, null, 2)}\n`);
  };

  const parseRecordFile = (file: string): PlanBranchRecord | null => {
    if (!file.endsWith(".json") || file.endsWith(".json.tmp")) {
      return null;
    }
    try {
      const parsed = PlanBranchRecordSchema.safeParse(JSON.parse(readFileSync(join(directory, file), "utf8")));
      // The file name must match the record it holds (same rule as the memory store).
      return parsed.success && planBranchFileName(parsed.data.name) === file ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const readRecord = (name: string): PlanBranchRecord | null => parseRecordFile(planBranchFileName(name));

  const readAll = (): PlanBranchRecord[] => {
    if (!existsSync(directory)) {
      return [];
    }
    const records: PlanBranchRecord[] = [];
    for (const file of readdirSync(directory)) {
      const record = parseRecordFile(file);
      if (record) {
        records.push(record);
      }
    }
    return records.sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.name.localeCompare(right.name)
    );
  };

  const requireName = (name: string): string => {
    if (!isValidPlanBranchName(name)) {
      throw new Error(`invalid plan branch name: ${name}`);
    }
    return name;
  };

  const seedMainline = (input: PlanBranchStateInput, active: boolean): PlanBranchRecord => {
    const mainline = createPlanBranchRecord(PLAN_BRANCH_MAINLINE, input, { active, now });
    writeRecord(mainline);
    return mainline;
  };

  const setActiveFlags = (records: readonly PlanBranchRecord[], activeName: string): PlanBranchRecord[] =>
    records.map((record) => {
      const active = record.name === activeName;
      if (record.active === active) {
        return record;
      }
      const updated: PlanBranchRecord = { ...record, active, updatedAt: now().toISOString() };
      writeRecord(updated);
      return updated;
    });

  return {
    directory,

    fork(name, input, forkOptions = {}) {
      requireName(name);
      let records = readAll();
      if (records.some((record) => record.name === name)) {
        throw new Error(`plan branch already exists: ${name}`);
      }
      if (records.length === 0) {
        // First fork: the in-flight plan state becomes the mainline snapshot.
        seedMainline(input, false);
        records = readAll();
      }
      const source = forkOptions.from ?? records.find((record) => record.active)?.name ?? PLAN_BRANCH_MAINLINE;
      if (!records.some((record) => record.name === source)) {
        throw new Error(`unknown plan branch: ${source}`);
      }
      setActiveFlags(records, name);
      const record = createPlanBranchRecord(name, input, { active: true, source, now });
      writeRecord(record);
      return record;
    },

    switch(name) {
      requireName(name);
      const records = readAll();
      if (!records.some((record) => record.name === name)) {
        throw new Error(`unknown plan branch: ${name}`);
      }
      const updated = setActiveFlags(records, name);
      return updated.find((record) => record.name === name)!;
    },

    checkpoint(input) {
      const records = readAll();
      if (records.length === 0) {
        // No branches yet: checkpointing lands on the mainline.
        return seedMainline(input, true);
      }
      const active = records.find((record) => record.active);
      if (!active) {
        throw new Error("no active plan branch to checkpoint");
      }
      const updated = createPlanBranchRecord(active.name, input, {
        active: true,
        source: active.source,
        now
      });
      // Preserve the branch's original fork timestamp; only updatedAt moves.
      writeRecord({ ...updated, createdAt: active.createdAt });
      return { ...updated, createdAt: active.createdAt };
    },

    delete(name) {
      requireName(name);
      if (name === PLAN_BRANCH_MAINLINE) {
        throw new Error("cannot delete the mainline plan branch");
      }
      const target = readRecord(name);
      if (!target) {
        throw new Error(`unknown plan branch: ${name}`);
      }
      rmSync(recordPath(name), { force: true });
      if (target.active) {
        const mainline = readRecord(PLAN_BRANCH_MAINLINE) ??
          seedMainline({ sessionId: target.checkpoint.sessionId, context: {}, pending: [], convo: [] }, false);
        writeRecord({ ...mainline, active: true, updatedAt: now().toISOString() });
      }
    },

    list() {
      return readAll();
    },

    current() {
      return readAll().find((record) => record.active)?.name ?? null;
    },

    readCheckpoint(name) {
      const branchName = name ?? readAll().find((record) => record.active)?.name;
      if (!branchName) {
        return null;
      }
      return readRecord(branchName)?.checkpoint ?? null;
    },

    mainlineRecord() {
      return readRecord(PLAN_BRANCH_MAINLINE);
    }
  };
}
