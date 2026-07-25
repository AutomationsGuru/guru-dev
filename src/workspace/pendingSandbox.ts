import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  PendingOpSchema,
  PendingSandboxStoreSchema,
  type PendingOp,
  type PendingOpKind,
  type PendingSandboxApplyResult,
  type PendingSandboxStore
} from "./pendingSandboxSchema.js";

/**
 * Pending change sandbox — IDEA-F4 (`R-PD-PEND`, `R-PD-PEND-REV`).
 *
 * Pure, injectable stage → list/reject → apply primitive. When disabled it is
 * a write-through passthrough (YOLO daily-driver behavior unchanged). When
 * enabled, mutations are staged under `<repoRoot>/.guru/pending/` and only
 * touch the working tree on explicit `apply`, which always preserves prior
 * state via backup-before-write (hard limit §3.1).
 *
 * Live tool wiring is intentionally NOT here — integration owns threading
 * `enabled` from config and routing file-mutating tools through
 * `stageOrWrite`.
 */

export interface PendingSandboxOptions {
  readonly repoRoot: string;
  /** Opt-in gate. Default false — passthrough. */
  readonly enabled?: boolean;
  /** Project harness dir name; default ".guru". Injectable for tests. */
  readonly guruDirName?: string;
  /** Injectable clock (ISO-8601). */
  readonly now?: () => string;
}

export interface PendingSandbox {
  readonly enabled: boolean;
  stage(input: StageInput): Promise<PendingOp>;
  list(): Promise<readonly PendingOp[]>;
  reject(paths: readonly string[]): Promise<readonly PendingOp[]>;
  apply(paths?: readonly string[]): Promise<readonly PendingSandboxApplyResult[]>;
  /**
   * Integration seam for file-mutating tools: disabled → write through with
   * current semantics; enabled → stage only, zero working-tree mutation.
   */
  stageOrWrite(input: StageInput): Promise<StageOrWriteResult>;
}

export interface StageInput {
  readonly path: string;
  readonly kind: PendingOpKind;
  /** Required for create/update; must be absent for delete. */
  readonly content?: string;
  readonly unifiedDiff?: string;
  readonly sourceTurnId: string;
}

export interface StageOrWriteResult {
  readonly staged: boolean;
  readonly applied: boolean;
  readonly path: string;
  readonly blockers: readonly string[];
}

const STORE_FILE = "pending.json";
const BACKUP_DIR = "backups";

export function createPendingSandbox(options: PendingSandboxOptions): PendingSandbox {
  const repoRoot = resolve(options.repoRoot);
  const enabled = options.enabled ?? false;
  const guruDirName = options.guruDirName ?? ".guru";
  const now = options.now ?? (() => new Date().toISOString());
  const pendingDir = resolve(repoRoot, guruDirName, "pending");
  const storePath = resolve(pendingDir, STORE_FILE);
  let sequence = 0;

  function resolveTarget(relPath: string): string {
    const target = resolve(repoRoot, relPath);
    const rel = relative(repoRoot, target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Pending sandbox path escapes repoRoot: ${relPath}`);
    }
    return target;
  }

  function normalizeRelPath(relPath: string): string {
    return resolveTarget(relPath)
      .slice(repoRoot.length + 1)
      .split(sep)
      .join("/");
  }

  async function readStore(): Promise<PendingSandboxStore> {
    if (!existsSync(storePath)) {
      return { version: 1, ops: [] };
    }
    const raw = await readFile(storePath, "utf8");
    return PendingSandboxStoreSchema.parse(JSON.parse(raw));
  }

  async function writeStore(store: PendingSandboxStore): Promise<void> {
    await mkdir(pendingDir, { recursive: true });
    const tmpPath = `${storePath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(tmpPath, storePath);
  }

  async function backupBeforeWrite(target: string, relPath: string): Promise<string | undefined> {
    if (!existsSync(target)) {
      return undefined;
    }
    const stamp = now().replace(/[:.]/g, "-");
    const sanitized = relPath.replace(/[^A-Za-z0-9._-]/g, "_");
    const backupRel = [guruDirName, "pending", BACKUP_DIR, `${stamp}-${sanitized}`].join("/");
    const backupTarget = resolve(repoRoot, backupRel);
    await mkdir(dirname(backupTarget), { recursive: true });
    await copyFile(target, backupTarget);
    return backupRel;
  }

  async function writeThrough(input: StageInput): Promise<void> {
    const target = resolveTarget(input.path);
    if (input.kind === "delete") {
      await unlink(target);
      return;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.content ?? "", "utf8");
  }

  async function stage(input: StageInput): Promise<PendingOp> {
    const relPath = normalizeRelPath(input.path);
    const op = PendingOpSchema.parse({
      id: `pend-${++sequence}-${createHash("sha256").update(`${relPath}${input.sourceTurnId}`).digest("hex").slice(0, 12)}`,
      path: relPath,
      kind: input.kind,
      contentHash: input.kind === "delete" ? undefined : createHash("sha256").update(input.content ?? "", "utf8").digest("hex"),
      fullContent: input.kind === "delete" ? undefined : (input.content ?? ""),
      unifiedDiff: input.unifiedDiff,
      sourceTurnId: input.sourceTurnId,
      createdAt: now()
    });
    const store = await readStore();
    await writeStore({ version: 1, ops: [...store.ops, op] });
    return op;
  }

  async function list(): Promise<readonly PendingOp[]> {
    return (await readStore()).ops;
  }

  async function reject(paths: readonly string[]): Promise<readonly PendingOp[]> {
    const rejected = new Set(paths.map((p) => normalizeRelPath(p)));
    const store = await readStore();
    const removed = store.ops.filter((op) => rejected.has(op.path));
    await writeStore({ version: 1, ops: store.ops.filter((op) => !rejected.has(op.path)) });
    return removed;
  }

  async function apply(paths?: readonly string[]): Promise<readonly PendingSandboxApplyResult[]> {
    const store = await readStore();
    const selected = paths === undefined ? store.ops : store.ops.filter((op) => new Set(paths.map((p) => normalizeRelPath(p))).has(op.path));
    const results: PendingSandboxApplyResult[] = [];
    const appliedIds = new Set<string>();

    for (const op of selected) {
      const target = resolveTarget(op.path);
      const blockers: string[] = [];
      const exists = existsSync(target);
      if (op.kind === "create" && exists) {
        blockers.push("Target already exists; reject this op or restage as an update.");
      } else if (op.kind === "update" && !exists) {
        blockers.push("Target is missing; reject this op or restage as a create.");
      } else if (op.kind === "delete" && !exists) {
        blockers.push("Target is already absent; nothing to delete.");
      }

      if (blockers.length > 0) {
        results.push({ path: op.path, applied: false, blockers });
        continue;
      }

      // Hard limit §3.1: prior state is preserved before any mutation.
      const backupPath = await backupBeforeWrite(target, op.path);
      if (op.kind === "delete") {
        await unlink(target);
      } else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, op.fullContent ?? "", "utf8");
      }
      appliedIds.add(op.id);
      results.push(backupPath === undefined ? { path: op.path, applied: true, blockers: [] } : { path: op.path, applied: true, backupPath, blockers: [] });
    }

    if (appliedIds.size > 0) {
      const current = await readStore();
      await writeStore({ version: 1, ops: current.ops.filter((op) => !appliedIds.has(op.id)) });
    }
    return results;
  }

  async function stageOrWrite(input: StageInput): Promise<StageOrWriteResult> {
    const relPath = normalizeRelPath(input.path);
    if (!enabled) {
      await writeThrough({ ...input, path: relPath });
      return { staged: false, applied: true, path: relPath, blockers: [] };
    }
    await stage({ ...input, path: relPath });
    return { staged: true, applied: false, path: relPath, blockers: [] };
  }

  return { enabled, stage, list, reject, apply, stageOrWrite };
}
