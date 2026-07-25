import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { containsSecretValue } from "../safety/secretSafety.js";
import {
  DEFAULT_SHADOW_CHECKPOINT_LIMITS,
  PendingToolCallSchema,
  ShadowCheckpointSchema,
  type PendingToolCall,
  type ShadowCheckpoint,
  type ShadowCheckpointCreateInput,
  type ShadowCheckpointCreateResult,
  type ShadowCheckpointLimits,
  type ShadowCheckpointRestoreResult,
  type ShadowCheckpointStore,
  type ShadowCheckpointStoreOptions,
  type ShadowCheckpointSummary,
  type ShadowFileEntry
} from "./shadowCheckpoint.js";

/**
 * Profile-scoped shadow checkpoint store (IDEA-F96-SHADOW-CKPT-01, R-GC-SHADOW).
 *
 * Captures pre-mutation file bytes + transcript pointer + pending tool call into
 * a side store under the home profile (or a test-supplied storeRoot). Restore
 * rewrites only snapshotted workspace paths, returns the pending tool payload
 * for re-propose, and never touches project `.git/`.
 *
 * Hard limits (structural):
 * - Secrets: name-shaped paths and content matching `containsSecretValue` are
 *   refused at capture; bytes are never persisted.
 * - Scope: paths must resolve inside workspaceRoot; escapes are skipped.
 * - Bounds: per-file / per-checkpoint byte caps and retained-count FIFO.
 * - Disabled default: when `enabled` is false, create/list/get/restore no-op.
 */

const CHECKPOINT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_PATH_NAME = /(?:^|[.])(?:pem|key|p12|pfx|keystore|kdbx)$/i;
const SECRET_PATH_WORD =
  /(?:^|[._-])(?:secret|secrets|credential|credentials|token|tokens|passwd|password|private[._-]?key|id[._-]?rsa|id[._-]?dsa|id[._-]?ecdsa|id[._-]?ed25519)(?:[._-]|$)/i;
const DOTENV_BASENAME = /^\.env(?:\..+)?$/i;
const MODE_MASK = 0o7777;
const TEMP_SUFFIX = ".guru-shadow-ckpt.tmp";
const MANIFEST_NAME = "manifest.json";

interface StoreContext {
  readonly workspaceRoot: string;
  readonly storeRoot: string;
  readonly enabled: boolean;
  readonly limits: ShadowCheckpointLimits;
}

/**
 * True when a workspace-relative path looks like credential material by name.
 * Content-shape refusal still runs via `containsSecretValue` on capture.
 */
export function looksSecretPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);

  return segments.some((segment) => {
    if (DOTENV_BASENAME.test(segment)) {
      return true;
    }
    return SECRET_PATH_NAME.test(segment) || SECRET_PATH_WORD.test(segment);
  });
}

export function createShadowCheckpointStore(options: ShadowCheckpointStoreOptions): ShadowCheckpointStore {
  const context = createContext(options);

  return {
    get enabled() {
      return context.enabled;
    },
    create: (input) => createCheckpoint(context, input),
    list: () => listCheckpoints(context),
    get: (id) => readCheckpoint(context, id),
    restore: (id) => restoreCheckpoint(context, id)
  };
}

function createContext(options: ShadowCheckpointStoreOptions): StoreContext {
  const workspaceRoot = resolve(options.workspaceRoot);
  const storeRoot = resolve(options.storeRoot);

  // Fail closed if a caller points the side store at project .git.
  if (isInsideRoot(workspaceRoot, storeRoot) && storeRoot.replace(/\\/g, "/").includes("/.git")) {
    throw new Error("Shadow checkpoint storeRoot must not be inside the project's .git directory.");
  }
  if (storeRoot === join(workspaceRoot, ".git") || storeRoot.endsWith(`${sep}.git`)) {
    throw new Error("Shadow checkpoint storeRoot must not be the project's .git directory.");
  }

  return {
    workspaceRoot,
    storeRoot,
    enabled: options.enabled === true,
    limits: options.limits ?? DEFAULT_SHADOW_CHECKPOINT_LIMITS
  };
}

async function createCheckpoint(
  context: StoreContext,
  input: ShadowCheckpointCreateInput
): Promise<ShadowCheckpointCreateResult | null> {
  if (!context.enabled) {
    return null;
  }

  const id = randomUUID();
  if (!CHECKPOINT_ID_PATTERN.test(id)) {
    return null;
  }

  const checkpointDir = join(context.storeRoot, id);
  const entriesDir = join(checkpointDir, "entries");
  await mkdir(entriesDir, { recursive: true });

  const entries: ShadowFileEntry[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const candidate of input.paths) {
    const relativePath = toWorkspaceRelative(context, candidate);
    if (relativePath === null) {
      skipped.push(displayPath(candidate));
      continue;
    }
    if (seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);

    // Never snapshot anything under .git - project git history is off-limits.
    if (relativePath === ".git" || relativePath.startsWith(".git/")) {
      skipped.push(relativePath);
      continue;
    }

    if (looksSecretPath(relativePath)) {
      skipped.push(relativePath);
      continue;
    }

    const absolutePath = join(context.workspaceRoot, relativePath);
    const info = await stat(absolutePath).catch(() => null);

    if (info === null || !info.isFile()) {
      entries.push(absentEntry(relativePath));
      continue;
    }

    if (info.size > context.limits.maxFileBytes) {
      skipped.push(relativePath);
      continue;
    }

    const content = await readFile(absolutePath).catch(() => null);
    if (content === null) {
      skipped.push(relativePath);
      continue;
    }

    if (containsSecretValue(content.toString("utf8"))) {
      skipped.push(relativePath);
      continue;
    }

    if (totalBytes + content.length > context.limits.maxCheckpointBytes) {
      skipped.push(relativePath);
      continue;
    }

    const payloadPath = `entries/${encodeEntryPath(relativePath)}`;
    await writeFile(join(checkpointDir, payloadPath), content);
    totalBytes += content.length;

    entries.push({
      relativePath,
      existed: true,
      payloadPath,
      sizeBytes: content.length,
      mode: info.mode & MODE_MASK,
      digest: sha256(content)
    });
  }

  let pendingToolCall: PendingToolCall | null = null;
  if (input.pendingToolCall != null) {
    const parsed = PendingToolCallSchema.safeParse(input.pendingToolCall);
    pendingToolCall = parsed.success ? parsed.data : null;
  }

  const checkpoint = ShadowCheckpointSchema.parse({
    schemaVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    label: (input.label?.trim() || "pre-mutation").slice(0, 256),
    sessionId: input.sessionId?.trim() ? input.sessionId.trim().slice(0, 256) : null,
    transcriptMessageCount: Math.max(0, Math.floor(input.transcriptMessageCount)),
    pendingToolCall,
    entries,
    skipped,
    restoredAt: null
  });

  await writeFile(join(checkpointDir, MANIFEST_NAME), `${JSON.stringify(checkpoint, null, 2)}\n`);
  await enforceRetainedLimit(context);

  return {
    checkpoint,
    summary: toSummary(checkpoint, totalBytes)
  };
}

async function restoreCheckpoint(
  context: StoreContext,
  id: string
): Promise<ShadowCheckpointRestoreResult | null> {
  if (!context.enabled) {
    return null;
  }

  const checkpoint = await readCheckpoint(context, id);
  if (checkpoint === null) {
    return null;
  }

  const restored: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];

  for (const entry of checkpoint.entries) {
    if (!isSafeRelativePath(entry.relativePath) || looksSecretPath(entry.relativePath)) {
      skipped.push(entry.relativePath);
      continue;
    }
    if (entry.relativePath === ".git" || entry.relativePath.startsWith(".git/")) {
      skipped.push(entry.relativePath);
      continue;
    }

    const absolutePath = join(context.workspaceRoot, entry.relativePath);

    if (entry.existed && entry.payloadPath !== null) {
      const payload = await readEntryPayload(context, checkpoint.id, entry);
      if (payload === null) {
        skipped.push(entry.relativePath);
        continue;
      }

      await mkdir(dirname(absolutePath), { recursive: true });
      const tempPath = `${absolutePath}${TEMP_SUFFIX}`;
      await writeFile(tempPath, payload, { mode: entry.mode ?? 0o666 });
      await rename(tempPath, absolutePath);
      restored.push(entry.relativePath);
      continue;
    }

    // Absent at capture: mutation created it - remove it again.
    const current = await stat(absolutePath).catch(() => null);
    if (current === null || !current.isFile()) {
      continue;
    }
    await rm(absolutePath, { force: true });
    await pruneEmptyDirs(context, dirname(absolutePath));
    removed.push(entry.relativePath);
  }

  const updated = ShadowCheckpointSchema.parse({
    ...checkpoint,
    restoredAt: new Date().toISOString()
  });
  await writeFile(join(context.storeRoot, checkpoint.id, MANIFEST_NAME), `${JSON.stringify(updated, null, 2)}\n`).catch(
    () => undefined
  );

  return {
    checkpointId: checkpoint.id,
    restored,
    removed,
    skipped,
    pendingToolCall: checkpoint.pendingToolCall,
    transcriptMessageCount: checkpoint.transcriptMessageCount,
    label: checkpoint.label
  };
}

async function readCheckpoint(context: StoreContext, id: string): Promise<ShadowCheckpoint | null> {
  if (!context.enabled) {
    return null;
  }
  if (!CHECKPOINT_ID_PATTERN.test(id)) {
    return null;
  }

  const raw = await readFile(join(context.storeRoot, id, MANIFEST_NAME), "utf8").catch(() => null);
  if (raw === null) {
    return null;
  }

  try {
    const parsed = ShadowCheckpointSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  } catch {
    return null;
  }
}

async function listCheckpoints(context: StoreContext): Promise<readonly ShadowCheckpointSummary[]> {
  if (!context.enabled) {
    return [];
  }

  const dirents = await readdir(context.storeRoot, { withFileTypes: true }).catch(() => []);
  const summaries: ShadowCheckpointSummary[] = [];

  for (const dirent of dirents) {
    if (!dirent.isDirectory() || !CHECKPOINT_ID_PATTERN.test(dirent.name)) {
      continue;
    }
    const checkpoint = await readCheckpoint(context, dirent.name);
    if (checkpoint === null) {
      continue;
    }
    const totalBytes = checkpoint.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    summaries.push(toSummary(checkpoint, totalBytes));
  }

  return summaries.sort((left, right) => {
    const byCreated = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return byCreated !== 0 ? byCreated : right.id.localeCompare(left.id);
  });
}

async function enforceRetainedLimit(context: StoreContext): Promise<void> {
  const summaries = await listCheckpoints(context);
  const overflow = summaries.length - context.limits.maxCheckpoints;
  if (overflow <= 0) {
    return;
  }

  for (const summary of summaries.slice(-overflow)) {
    await rm(join(context.storeRoot, summary.id), { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readEntryPayload(
  context: StoreContext,
  checkpointId: string,
  entry: ShadowFileEntry
): Promise<Buffer | null> {
  if (entry.payloadPath === null || entry.payloadPath.includes("..")) {
    return null;
  }

  const payloadPath = join(context.storeRoot, checkpointId, entry.payloadPath);
  const payload = await readFile(payloadPath).catch(() => null);
  if (payload === null) {
    return null;
  }

  return entry.digest !== null && sha256(payload) === entry.digest ? payload : null;
}

async function pruneEmptyDirs(context: StoreContext, startDir: string): Promise<void> {
  let current = resolve(startDir);

  while (current !== context.workspaceRoot && isInsideRoot(context.workspaceRoot, current)) {
    const remaining = await readdir(current).catch(() => null);
    if (remaining === null || remaining.length > 0) {
      return;
    }
    await rm(current, { recursive: false }).catch(() => undefined);
    current = dirname(current);
  }
}

function toSummary(checkpoint: ShadowCheckpoint, totalBytes: number): ShadowCheckpointSummary {
  return {
    id: checkpoint.id,
    label: checkpoint.label,
    createdAt: checkpoint.createdAt,
    entryCount: checkpoint.entries.length,
    skippedCount: checkpoint.skipped.length,
    totalBytes,
    transcriptMessageCount: checkpoint.transcriptMessageCount,
    hasPendingToolCall: checkpoint.pendingToolCall !== null,
    restoredAt: checkpoint.restoredAt
  };
}

function absentEntry(relativePath: string): ShadowFileEntry {
  return {
    relativePath,
    existed: false,
    payloadPath: null,
    sizeBytes: 0,
    mode: null,
    digest: null
  };
}

function toWorkspaceRelative(context: StoreContext, candidate: string): string | null {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const absolute = resolve(context.workspaceRoot, trimmed);
  if (!isInsideRoot(context.workspaceRoot, absolute)) {
    return null;
  }

  const relative = absolute
    .slice(context.workspaceRoot.length)
    .replace(/^[/\\]+/, "")
    .replace(/\\/g, "/");
  return relative.length > 0 && isSafeRelativePath(relative) ? relative : null;
}

function isSafeRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return false;
  }
  return !normalized.split("/").some((segment) => segment === ".." || segment.length === 0);
}

function isInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function displayPath(candidate: string): string {
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed.replace(/\\/g, "/") : "(empty)";
}

function encodeEntryPath(relativePath: string): string {
  return Buffer.from(relativePath, "utf8").toString("base64url");
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
