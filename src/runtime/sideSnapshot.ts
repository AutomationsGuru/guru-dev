import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { z } from "zod";

import { containsSecretValue } from "../safety/secretSafety.js";

/**
 * Side snapshots (IDEA-C1, R-OC-UNDO / R-CW-RESTORE): undo agent workspace
 * mutations by replaying byte copies kept in a snapshot store — never by
 * rewriting the operator's git history (`git reset --hard` is structurally
 * absent here; no git command is ever invoked).
 *
 * Flow: a write-tool batch (or turn boundary) calls `captureBatch(paths)`
 * BEFORE mutating. Each path's pre-mutation bytes (or its non-existence) is
 * recorded under `<snapshotRoot>/<snapshotId>/`. `restoreLast()` /
 * `restoreSideSnapshot(ref)` reverts exactly the recorded paths:
 *   - pre-existing files are rewritten with their snapshotted bytes + mode;
 *   - files the mutation created are removed again;
 *   - directories emptied by the revert are pruned.
 * Paths never captured are never touched.
 *
 * Hard limits enforced structurally, not by prompt:
 *   - §3.1 preservation: restoring over current bytes first preserves those
 *     bytes as `preservedFrom: "restore"` entries in the same snapshot
 *     record, so a destructive-feeling undo keeps a recovery path.
 *   - §3.3 secrets: secret-looking paths (by name) and file contents matching
 *     the shared secret-shape scan (`containsSecretValue`) are refused at
 *     capture and at restore; their bytes are never persisted.
 *   - Scope: paths must resolve inside the workspace root; escape attempts
 *     (including tampered manifest entries) are skipped, never followed.
 *   - Bounded: per-file and per-snapshot byte caps plus a retained-snapshot
 *     count cap (oldest dropped FIFO) keep the store from growing without
 *     limit.
 */

export const SideSnapshotEntryKindSchema = z.enum(["file"]);
export type SideSnapshotEntryKind = z.infer<typeof SideSnapshotEntryKindSchema>;

export const SideSnapshotEntrySchema = z
  .object({
    /** Workspace-root-relative POSIX-style path (never absolute, never escaping). */
    relativePath: z.string().trim().min(1),
    kind: SideSnapshotEntryKindSchema,
    /** Whether the path existed in the workspace when it was captured. */
    existed: z.boolean(),
    /** Store-relative payload path (entries|preserve/<encoded>), null when !existed. */
    snapshotPath: z.string().trim().min(1).nullable(),
    sizeBytes: z.number().int().nonnegative(),
    /** Permission bits captured with the file (restored verbatim), null when !existed. */
    mode: z.number().int().nonnegative().nullable(),
    /** sha256 of the captured bytes, null when !existed. */
    digest: z.string().trim().min(1).nullable(),
    /** "restore" marks bytes preserved from the live workspace during a restore. */
    preservedFrom: z.enum(["capture", "restore"]).nullable()
  })
  .strict();
export type SideSnapshotEntry = z.infer<typeof SideSnapshotEntrySchema>;

export const SideSnapshotManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotId: z.string().trim().min(1),
    label: z.string().trim().min(1),
    createdAt: z.string().datetime(),
    entries: z.array(SideSnapshotEntrySchema),
    /** Workspace-relative paths refused at capture (secret shape / escape / oversize). */
    skipped: z.array(z.string()),
    /**
     * Set when this snapshot has been reverted. restoreLast walks past restored
     * snapshots (undo-stack semantics) but the record stays on disk — its
     * preserve entries are the recovery path and are never auto-deleted.
     */
    restoredAt: z.string().datetime().nullable().default(null)
  })
  .strict();
export type SideSnapshotManifest = z.infer<typeof SideSnapshotManifestSchema>;

export interface SideSnapshotLimits {
  /** Files larger than this are refused at capture (unbounded copies are not allowed). */
  readonly maxFileBytes: number;
  /** Captured payload budget per batch; overflow entries are refused. */
  readonly maxSnapshotBytes: number;
  /** Retained snapshot count; oldest are dropped FIFO after each capture. */
  readonly maxSnapshots: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: SideSnapshotLimits = {
  maxFileBytes: 1024 * 1024,
  maxSnapshotBytes: 16 * 1024 * 1024,
  maxSnapshots: 32
};

export interface SideSnapshotSummary {
  readonly snapshotId: string;
  readonly label: string;
  readonly createdAt: string;
  readonly entryCount: number;
  readonly skippedCount: number;
  readonly totalBytes: number;
  readonly skipped: readonly string[];
}

export interface SideSnapshotCaptureResult extends SideSnapshotSummary {}

export interface SideSnapshotRestoreResult {
  readonly snapshotId: string;
  readonly restored: readonly string[];
  readonly removed: readonly string[];
  readonly skipped: readonly string[];
  /** Current-state entries preserved before overwrite (recovery path). */
  readonly preserve: readonly SideSnapshotEntry[];
  readonly preserveCount: number;
}

export interface SideSnapshotStoreOptions {
  readonly workspaceRoot: string;
  readonly snapshotRoot: string;
  readonly limits?: SideSnapshotLimits;
}

export interface SideSnapshotRestoreOptions extends SideSnapshotStoreOptions {
  /** Exact snapshot id, or "last" / "latest" / undefined for the newest. */
  readonly snapshotRef?: string;
}

export interface SideSnapshotStore {
  captureBatch(paths: readonly string[], label?: string): Promise<SideSnapshotCaptureResult>;
  restoreLast(): Promise<SideSnapshotRestoreResult>;
  restore(snapshotRef?: string): Promise<SideSnapshotRestoreResult>;
  list(): Promise<readonly SideSnapshotSummary[]>;
  readEntries(snapshotId: string): Promise<readonly SideSnapshotEntry[]>;
}

const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_PATH_NAME = /(?:^|[.])(?:pem|key|p12|pfx|keystore|kdbx)$/i;
const SECRET_PATH_WORD = /(?:^|[._-])(?:secret|secrets|credential|credentials|token|tokens|passwd|password|private[._-]?key|id[._-]?rsa|id[._-]?dsa|id[._-]?ecdsa|id[._-]?ed25519)(?:[._-]|$)/i;
const DOTENV_BASENAME = /^\.env(?:\..+)?$/i;
const MODE_MASK = 0o7777;
const TEMP_SUFFIX = ".guru-side-snapshot.tmp";

/**
 * True when a workspace-relative path looks like it holds credential material.
 * Name-based preflight only — content-shape refusal happens via
 * `containsSecretValue` on capture. Exported so write-tool call sites can
 * preflight before attempting a capture.
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

export function createSideSnapshotStore(options: SideSnapshotStoreOptions): SideSnapshotStore {
  const context = createContext(options);

  return {
    captureBatch: (paths, label) => captureBatch(context, paths, label),
    restoreLast: () => restore(context, undefined),
    restore: (snapshotRef) => restore(context, snapshotRef),
    list: () => listSnapshots(context),
    readEntries: async (snapshotId) => {
      const manifest = await readManifest(context, snapshotId);
      return manifest?.entries ?? [];
    }
  };
}

export async function restoreSideSnapshot(options: SideSnapshotRestoreOptions): Promise<SideSnapshotRestoreResult> {
  return restore(createContext(options), options.snapshotRef);
}

interface SnapshotContext {
  readonly workspaceRoot: string;
  readonly snapshotRoot: string;
  readonly limits: SideSnapshotLimits;
}

function createContext(options: SideSnapshotStoreOptions): SnapshotContext {
  return {
    workspaceRoot: resolve(options.workspaceRoot),
    snapshotRoot: resolve(options.snapshotRoot),
    limits: options.limits ?? DEFAULT_SNAPSHOT_LIMITS
  };
}

async function captureBatch(
  context: SnapshotContext,
  paths: readonly string[],
  label = "manual"
): Promise<SideSnapshotCaptureResult> {
  const snapshotId = randomUUID();
  const snapshotDir = join(context.snapshotRoot, snapshotId);
  const entriesDir = join(snapshotDir, "entries");
  await mkdir(entriesDir, { recursive: true });

  const entries: SideSnapshotEntry[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const candidate of paths) {
    const relativePath = toWorkspaceRelative(context, candidate);
    if (relativePath === null || seen.has(relativePath)) {
      if (relativePath !== null) {
        continue; // duplicate in the same batch — first capture wins
      }
      skipped.push(displayPath(candidate));
      continue;
    }
    seen.add(relativePath);

    if (looksSecretPath(relativePath)) {
      skipped.push(relativePath);
      continue;
    }

    const absolutePath = join(context.workspaceRoot, relativePath);
    const info = await stat(absolutePath).catch(() => null);

    if (info === null || !info.isFile()) {
      // Non-existent (or non-regular) path: record absence so restore removes it.
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

    // Content-shape secret refusal: a credential-shaped payload must never be persisted.
    if (containsSecretValue(content.toString("utf8"))) {
      skipped.push(relativePath);
      continue;
    }

    if (totalBytes + content.length > context.limits.maxSnapshotBytes) {
      skipped.push(relativePath);
      continue;
    }

    const snapshotPath = `entries/${encodeEntryPath(relativePath)}`;
    await writeFile(join(snapshotDir, snapshotPath), content);
    totalBytes += content.length;

    entries.push(
      SideSnapshotEntrySchema.parse({
        relativePath,
        kind: "file",
        existed: true,
        snapshotPath,
        sizeBytes: content.length,
        mode: info.mode & MODE_MASK,
        digest: sha256(content),
        preservedFrom: null
      })
    );
  }

  const manifest: SideSnapshotManifest = SideSnapshotManifestSchema.parse({
    schemaVersion: 1,
    snapshotId,
    label: label.trim().length > 0 ? label.trim() : "manual",
    createdAt: new Date().toISOString(),
    entries,
    skipped,
    restoredAt: null
  });
  await writeFile(join(snapshotDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  await enforceRetainedLimit(context);

  return toSummary(manifest, totalBytes);
}

async function restore(context: SnapshotContext, snapshotRef: string | undefined): Promise<SideSnapshotRestoreResult> {
  const manifest = await resolveManifest(context, snapshotRef);
  if (manifest === null || manifest.entries.length === 0) {
    return emptyRestoreResult(manifest?.snapshotId ?? "");
  }

  const restored: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  const preserve: SideSnapshotEntry[] = [];

  for (const entry of manifest.entries) {
    // Tamper guard: entries must stay inside the workspace and off secret paths.
    if (entry.preservedFrom === "restore" || !isSafeRelativePath(entry.relativePath) || looksSecretPath(entry.relativePath)) {
      skipped.push(entry.relativePath);
      continue;
    }

    const absolutePath = join(context.workspaceRoot, entry.relativePath);

    if (entry.existed && entry.snapshotPath !== null) {
      const payload = await readEntryPayload(context, manifest.snapshotId, entry);
      if (payload === null) {
        skipped.push(entry.relativePath);
        continue;
      }

      // Preservation before destructive overwrite (§3.1): current bytes move
      // into the snapshot record before the revert touches them.
      const preserved = await preserveCurrentState(context, manifest.snapshotId, entry, absolutePath);
      if (preserved !== null) {
        preserve.push(preserved);
      }

      await mkdir(dirname(absolutePath), { recursive: true });
      const tempPath = `${absolutePath}${TEMP_SUFFIX}`;
      await writeFile(tempPath, payload, { mode: entry.mode ?? 0o666 });
      await rename(tempPath, absolutePath);
      restored.push(entry.relativePath);
      continue;
    }

    // Entry was absent at capture: the mutation created it — remove it again.
    const current = await stat(absolutePath).catch(() => null);
    if (current === null || !current.isFile()) {
      continue;
    }
    const preserved = await preserveCurrentState(context, manifest.snapshotId, entry, absolutePath);
    if (preserved !== null) {
      preserve.push(preserved);
    }
    await rm(absolutePath, { force: true });
    await pruneEmptyDirs(context, dirname(absolutePath));
    removed.push(entry.relativePath);
  }

  // Stamp the undo (best-effort): the record stays on disk, restoreLast walks past it.
  const updated: SideSnapshotManifest = SideSnapshotManifestSchema.parse({
    ...manifest,
    entries: [...manifest.entries, ...preserve],
    restoredAt: new Date().toISOString()
  });
  await writeFile(join(context.snapshotRoot, manifest.snapshotId, "manifest.json"), JSON.stringify(updated, null, 2)).catch(
    () => undefined
  );

  return {
    snapshotId: manifest.snapshotId,
    restored,
    removed,
    skipped,
    preserve,
    preserveCount: preserve.length
  };
}

/**
 * Copies the live workspace bytes for `relativePath` into the snapshot's
 * preserve area and returns the typed entry. Secret-shaped current content is
 * never persisted — the overwrite still proceeds (restore is reverting to
 * known-clean captured bytes) but no recovery copy is kept for it.
 */
async function preserveCurrentState(
  context: SnapshotContext,
  snapshotId: string,
  entry: SideSnapshotEntry,
  absolutePath: string
): Promise<SideSnapshotEntry | null> {
  const current = await stat(absolutePath).catch(() => null);
  if (current === null || !current.isFile()) {
    return null;
  }
  if (current.size > context.limits.maxFileBytes) {
    return null;
  }

  const content = await readFile(absolutePath).catch(() => null);
  if (content === null || containsSecretValue(content.toString("utf8"))) {
    return null;
  }

  const snapshotPath = `preserve/${encodeEntryPath(entry.relativePath)}`;
  const destination = join(context.snapshotRoot, snapshotId, snapshotPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);

  return SideSnapshotEntrySchema.parse({
    relativePath: entry.relativePath,
    kind: "file",
    existed: true,
    snapshotPath,
    sizeBytes: content.length,
    mode: current.mode & MODE_MASK,
    digest: sha256(content),
    preservedFrom: "restore"
  });
}

async function readEntryPayload(context: SnapshotContext, snapshotId: string, entry: SideSnapshotEntry): Promise<Buffer | null> {
  if (entry.snapshotPath === null || entry.snapshotPath.includes("..")) {
    return null;
  }

  const payloadPath = join(context.snapshotRoot, snapshotId, entry.snapshotPath);
  const payload = await readFile(payloadPath).catch(() => null);
  if (payload === null) {
    return null;
  }

  // Integrity check: a payload that no longer matches its recorded digest is
  // treated as tampered and never written into the workspace.
  return entry.digest !== null && sha256(payload) === entry.digest ? payload : null;
}

/** Removes directories emptied by a revert, stopping at (never removing) the root. */
async function pruneEmptyDirs(context: SnapshotContext, startDir: string): Promise<void> {
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

async function resolveManifest(context: SnapshotContext, snapshotRef: string | undefined): Promise<SideSnapshotManifest | null> {
  const trimmed = snapshotRef?.trim();
  if (trimmed === undefined || trimmed.length === 0 || trimmed === "last" || trimmed === "latest") {
    // Undo-stack: newest snapshot that has not been reverted yet.
    const snapshots = await listManifests(context);
    return snapshots.find((manifest) => manifest.restoredAt === null) ?? null;
  }

  return readManifest(context, trimmed);
}

async function readManifest(context: SnapshotContext, snapshotId: string): Promise<SideSnapshotManifest | null> {
  // Snapshot ids come from the store (or the operator); anything else is not a store entry.
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    return null;
  }

  const raw = await readFile(join(context.snapshotRoot, snapshotId, "manifest.json"), "utf8").catch(() => null);
  if (raw === null) {
    return null;
  }

  try {
    const parsed = SideSnapshotManifestSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.snapshotId === snapshotId ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Newest-first manifests; snapshotId desc breaks same-millisecond ties deterministically. */
async function listManifests(context: SnapshotContext): Promise<readonly SideSnapshotManifest[]> {
  const dirents = await readdir(context.snapshotRoot, { withFileTypes: true }).catch(() => []);
  const manifests: SideSnapshotManifest[] = [];

  for (const dirent of dirents) {
    if (!dirent.isDirectory() || !SNAPSHOT_ID_PATTERN.test(dirent.name)) {
      continue;
    }
    const manifest = await readManifest(context, dirent.name);
    if (manifest !== null) {
      manifests.push(manifest);
    }
  }

  return manifests.sort((left, right) => {
    const byCreated = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return byCreated !== 0 ? byCreated : right.snapshotId.localeCompare(left.snapshotId);
  });
}

async function listSnapshots(context: SnapshotContext): Promise<readonly SideSnapshotSummary[]> {
  const manifests = await listManifests(context);

  return manifests.map((manifest) =>
    toSummary(manifest, manifest.entries.reduce((total, entry) => total + entry.sizeBytes, 0))
  );
}

async function enforceRetainedLimit(context: SnapshotContext): Promise<void> {
  const snapshots = await listSnapshots(context);
  const overflow = snapshots.length - context.limits.maxSnapshots;
  if (overflow <= 0) {
    return;
  }

  // Newest-first list: drop from the tail (oldest) — FIFO bound on store growth.
  for (const summary of snapshots.slice(-overflow)) {
    await rm(join(context.snapshotRoot, summary.snapshotId), { recursive: true, force: true }).catch(() => undefined);
  }
}

function toSummary(manifest: SideSnapshotManifest, totalBytes: number): SideSnapshotSummary {
  const captured = manifest.entries.filter((entry) => entry.preservedFrom !== "restore");

  return {
    snapshotId: manifest.snapshotId,
    label: manifest.label,
    createdAt: manifest.createdAt,
    entryCount: captured.length,
    skippedCount: manifest.skipped.length,
    totalBytes,
    skipped: manifest.skipped
  };
}

function emptyRestoreResult(snapshotId: string): SideSnapshotRestoreResult {
  return { snapshotId, restored: [], removed: [], skipped: [], preserve: [], preserveCount: 0 };
}

function absentEntry(relativePath: string): SideSnapshotEntry {
  return SideSnapshotEntrySchema.parse({
    relativePath,
    kind: "file",
    existed: false,
    snapshotPath: null,
    sizeBytes: 0,
    mode: null,
    digest: null,
    preservedFrom: null
  });
}

/** Maps an operator-supplied path onto a normalized workspace-relative path, or null when it escapes the root. */
function toWorkspaceRelative(context: SnapshotContext, candidate: string): string | null {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const absolute = resolve(context.workspaceRoot, trimmed);
  if (!isInsideRoot(context.workspaceRoot, absolute)) {
    return null;
  }

  const relative = absolute.slice(context.workspaceRoot.length).replace(/^[/\\]+/, "").replace(/\\/g, "/");
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
