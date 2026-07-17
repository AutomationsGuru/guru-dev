import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import { detectPotentialSecrets } from "../safety/policyGuard.js";
import { isTerminal, nextStage, type DevStage, type StageVerdict } from "./devCycle.js";

export const DEV_CYCLE_CHECKPOINT_SCHEMA_VERSION = 1 as const;

const CycleIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "Invalid dev-cycle cycle id.");

const WorkingStageSchema = z.enum(["select", "build", "test", "smoke", "debug", "review", "ship", "learn"]);
const DevStageSchema = z.enum(["select", "build", "test", "smoke", "debug", "review", "ship", "learn", "done", "blocked"]);
const StageVerdictSchema = z.enum(["GREEN", "YELLOW", "RED"]);

const StageOutcomeSchema = z
  .object({
    stage: WorkingStageSchema,
    verdict: StageVerdictSchema,
    evidence: z.string().max(4_000)
  })
  .strict();

const GateFailureNoteSchema = z
  .object({
    gate: z.string().min(1).max(256),
    kind: z.enum(["vitest", "tsc", "generic"]),
    summary: z.string().max(2_000),
    failures: z.array(z.string().max(2_000)).max(10),
    raw: z.string().max(2_000)
  })
  .strict();

export const DevCycleBudgetSnapshotSchema = z
  .object({
    attempts: z.number().int().nonnegative(),
    maxIterations: z.number().int().positive().max(100),
    tokens: z.number().int().nonnegative(),
    tokenBudget: z.number().int().positive(),
    spentUsd: z.number().nonnegative(),
    ceilingUsd: z.number().nonnegative(),
    elapsedMs: z.number().nonnegative(),
    wallClockMs: z.number().int().positive()
  })
  .strict();

const LearnedFactSchema = z
  .object({
    taskId: z.string().min(1).max(256),
    outcome: z.enum(["shipped", "blocked"]),
    verdict: StageVerdictSchema,
    confidence: z.enum(["validated", "parked"]),
    fact: z.string().max(4_000),
    blockerNote: z.string().max(4_000).optional()
  })
  .strict();

const ResumeRerunSchema = z
  .object({
    stage: z.enum(["test", "smoke", "review"]),
    interruptedAt: z.string().datetime({ offset: true }),
    resumedAt: z.string().datetime({ offset: true })
  })
  .strict();

function expectedTerminalVerdict(stage: "done" | "blocked", completedStages: readonly z.infer<typeof StageOutcomeSchema>[]): StageVerdict {
  if (stage === "blocked") {
    return "RED";
  }
  if (!completedStages.some((outcome) => outcome.stage !== "select")) {
    return "YELLOW";
  }
  return completedStages.some((outcome) => outcome.verdict === "YELLOW") ? "YELLOW" : "GREEN";
}

export const DevCycleCheckpointSchema = z
  .object({
    schemaVersion: z.literal(DEV_CYCLE_CHECKPOINT_SCHEMA_VERSION),
    cycleId: CycleIdSchema,
    cwd: z.string().min(1),
    selectedTaskId: z.string().min(1).max(256),
    stage: DevStageSchema,
    stageState: z.enum(["pending", "running", "completed"]),
    completedStages: z.array(StageOutcomeSchema).max(100),
    lastFailure: GateFailureNoteSchema.nullable(),
    executorSessionId: z.string().min(1).max(256).nullable(),
    budget: DevCycleBudgetSnapshotSchema,
    status: z.enum(["running", "done", "blocked"]),
    verdict: StageVerdictSchema.nullable(),
    learned: LearnedFactSchema.nullable(),
    resumeReruns: z.array(ResumeRerunSchema).max(100),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict()
  .superRefine((checkpoint, context) => {
    let boundary: DevStage = "select";
    for (const [index, outcome] of checkpoint.completedStages.entries()) {
      if (isTerminal(boundary)) {
        context.addIssue({
          code: "custom",
          path: ["completedStages", index],
          message: `Checkpoint history continues after terminal boundary ${boundary}.`
        });
        break;
      }
      if (outcome.stage !== boundary) {
        context.addIssue({
          code: "custom",
          path: ["completedStages", index, "stage"],
          message: `Checkpoint history expected ${boundary} but recorded ${outcome.stage}.`
        });
      }
      boundary = nextStage(boundary, outcome.verdict);
    }

    if (checkpoint.stage !== boundary) {
      context.addIssue({
        code: "custom",
        path: ["stage"],
        message: `Checkpoint stage ${checkpoint.stage} does not match replayed history boundary ${boundary}.`
      });
    }

    if (boundary !== "done" && boundary !== "blocked") {
      if (checkpoint.status !== "running") {
        context.addIssue({ code: "custom", path: ["status"], message: "A non-terminal history must remain running." });
      }
      if (checkpoint.stageState === "completed") {
        context.addIssue({ code: "custom", path: ["stageState"], message: "A running checkpoint cannot have a completed stage state." });
      }
      if (checkpoint.verdict !== null) {
        context.addIssue({ code: "custom", path: ["verdict"], message: "A running checkpoint cannot have a terminal verdict." });
      }
      return;
    }

    if (checkpoint.status !== boundary) {
      context.addIssue({ code: "custom", path: ["status"], message: `Terminal status must match replayed ${boundary} boundary.` });
    }
    if (checkpoint.stageState !== "completed") {
      context.addIssue({ code: "custom", path: ["stageState"], message: "A terminal checkpoint must have completed stage state." });
    }
    const expectedVerdict = expectedTerminalVerdict(boundary, checkpoint.completedStages);
    if (checkpoint.verdict !== expectedVerdict) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message: `Terminal verdict must match replayed history (${expectedVerdict}).`
      });
    }
  });

export type DevCycleCheckpoint = z.infer<typeof DevCycleCheckpointSchema>;

export interface DevCycleCheckpointStoreOptions {
  readonly cwd: string;
  readonly randomId?: () => string;
}

export interface DevCycleCheckpointStore {
  readonly cwd: string;
  readonly directory: string;
  path(cycleId: string): string;
  load(cycleId: string): DevCycleCheckpoint;
  save(checkpoint: DevCycleCheckpoint): void;
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalize = (value: string): string => (process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value));
  return normalize(left) === normalize(right);
}

function isWithin(boundary: string, candidate: string): boolean {
  const fromBoundary = relative(boundary, candidate);
  return fromBoundary === "" || (!fromBoundary.startsWith("..") && !isAbsolute(fromBoundary));
}

function rejectLinkOrWrongKind(path: string, kind: "directory" | "file", label: string): Stats | null {
  const stats = lstatIfPresent(path);
  if (!stats) {
    return null;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Dev-cycle checkpoint ${label} cannot be a symlink, junction, or reparse point.`);
  }
  if (kind === "directory" ? !stats.isDirectory() : !stats.isFile()) {
    throw new Error(`Dev-cycle checkpoint ${label} must be a ${kind}.`);
  }
  return stats;
}

export function createDevCycleCheckpointStore(options: DevCycleCheckpointStoreOptions): DevCycleCheckpointStore {
  const cwd = realpathSync(resolve(options.cwd));
  const guruDirectory = join(cwd, ".guru");
  const directory = join(cwd, ".guru", "dev-cycles");
  const randomId = options.randomId ?? randomUUID;

  const path = (cycleId: string): string => {
    const id = CycleIdSchema.parse(cycleId);
    return join(directory, `${id}.json`);
  };

  const ensureDirectory = (create: boolean): string | null => {
    if (!rejectLinkOrWrongKind(guruDirectory, "directory", "project .guru directory")) {
      if (!create) {
        return null;
      }
      mkdirSync(guruDirectory, { mode: 0o700 });
      rejectLinkOrWrongKind(guruDirectory, "directory", "project .guru directory");
    }
    if (!rejectLinkOrWrongKind(directory, "directory", "directory")) {
      if (!create) {
        return null;
      }
      mkdirSync(directory, { mode: 0o700 });
      rejectLinkOrWrongKind(directory, "directory", "directory");
    }

    const canonicalGuruDirectory = realpathSync(guruDirectory);
    const canonicalDirectory = realpathSync(directory);
    if (!sameCanonicalPath(canonicalGuruDirectory, guruDirectory) || !isWithin(cwd, canonicalGuruDirectory)) {
      throw new Error("Dev-cycle checkpoint .guru directory escapes the canonical project boundary.");
    }
    if (!sameCanonicalPath(canonicalDirectory, directory) || !isWithin(canonicalGuruDirectory, canonicalDirectory)) {
      throw new Error("Dev-cycle checkpoint directory escapes the canonical project .guru boundary.");
    }
    return canonicalDirectory;
  };

  const assertSafeFile = (filePath: string, canonicalDirectory: string, label: string): boolean => {
    const stats = rejectLinkOrWrongKind(filePath, "file", label);
    if (!stats) {
      return false;
    }
    const canonicalFile = realpathSync(filePath);
    if (!isWithin(canonicalDirectory, canonicalFile)) {
      throw new Error(`Dev-cycle checkpoint ${label} escapes the canonical project .guru boundary.`);
    }
    return true;
  };

  return {
    cwd,
    directory,
    path(cycleId) {
      ensureDirectory(true);
      return path(cycleId);
    },
    load(cycleId) {
      const filePath = path(cycleId);
      const canonicalDirectory = ensureDirectory(false);
      if (!canonicalDirectory || !lstatIfPresent(filePath)) {
        throw new Error(`Dev-cycle checkpoint not found: ${cycleId}`);
      }
      assertSafeFile(filePath, canonicalDirectory, "file");

      let raw: unknown;
      let descriptor: number | null = null;
      try {
        descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        raw = JSON.parse(readFileSync(descriptor, "utf8")) as unknown;
      } catch {
        throw new Error(`Dev-cycle checkpoint is corrupt or invalid: ${cycleId}`);
      } finally {
        if (descriptor !== null) {
          closeSync(descriptor);
        }
      }

      if (
        typeof raw === "object" &&
        raw !== null &&
        "schemaVersion" in raw &&
        (raw as { readonly schemaVersion?: unknown }).schemaVersion !== DEV_CYCLE_CHECKPOINT_SCHEMA_VERSION
      ) {
        throw new Error(`Unsupported dev-cycle checkpoint version: ${cycleId}`);
      }

      const parsed = DevCycleCheckpointSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`Dev-cycle checkpoint is invalid: ${cycleId}`);
      }
      if (parsed.data.cycleId !== cycleId) {
        throw new Error(`Dev-cycle checkpoint cycle id mismatch: ${cycleId}`);
      }

      let checkpointCwd: string;
      try {
        checkpointCwd = realpathSync(resolve(parsed.data.cwd));
      } catch {
        throw new Error(`Dev-cycle checkpoint cwd is unavailable: ${cycleId}`);
      }
      if (checkpointCwd !== cwd) {
        throw new Error(`Dev-cycle checkpoint cwd mismatch: ${cycleId}`);
      }

      return parsed.data;
    },
    save(checkpoint) {
      const parsed = DevCycleCheckpointSchema.safeParse(checkpoint);
      if (!parsed.success) {
        throw new Error("Invalid dev-cycle checkpoint.");
      }
      if (realpathSync(resolve(parsed.data.cwd)) !== cwd) {
        throw new Error("Dev-cycle checkpoint cwd mismatch.");
      }

      const serialized = `${JSON.stringify(parsed.data, null, 2)}\n`;
      const sensitive = detectPotentialSecrets([{ name: "dev-cycle checkpoint", value: serialized }]);
      if (sensitive.length > 0) {
        throw new Error("Dev-cycle checkpoint contains a potential secret or sensitive value.");
      }

      const canonicalDirectory = ensureDirectory(true);
      if (!canonicalDirectory) {
        throw new Error("Dev-cycle checkpoint directory is unavailable.");
      }
      const filePath = path(parsed.data.cycleId);
      if (lstatIfPresent(filePath)) {
        assertSafeFile(filePath, canonicalDirectory, "file");
      }
      const temporaryId = CycleIdSchema.parse(randomId());
      const temporaryPath = join(directory, `.${parsed.data.cycleId}.${temporaryId}.tmp`);
      let descriptor: number | null = null;
      try {
        descriptor = openSync(
          temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600
        );
        writeFileSync(descriptor, serialized, "utf8");
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = null;
        assertSafeFile(temporaryPath, canonicalDirectory, "temporary file");
        ensureDirectory(false);
        if (lstatIfPresent(filePath)) {
          assertSafeFile(filePath, canonicalDirectory, "file");
        }
        renameSync(temporaryPath, filePath);
        assertSafeFile(filePath, canonicalDirectory, "file");
      } catch (error) {
        if (descriptor !== null) {
          closeSync(descriptor);
        }
        rmSync(temporaryPath, { force: true });
        throw error;
      }
    }
  };
}
