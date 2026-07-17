import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";

import {
  GarageManifestSchema,
  roleProfileToManifest,
  type GarageLayer,
  type GarageManifest
} from "../garage/manifest.js";
import type { HonchoClient } from "../honcho/client.js";
import type { JsonObject, OperationalStateSnapshot } from "../operational/schemas.js";
import type { OperationalStore } from "../operational/store.js";
import { RoleProfileSchema } from "../roles/schema.js";
import { detectPotentialSecrets } from "../safety/policyGuard.js";
import { containsSecretValue } from "../safety/secretSafety.js";
import { serializeFactFile } from "./frontmatter.js";
import {
  MemoryFactNameSchema,
  MemorySyncReportSchema,
  MemorySyncSinkStateSchema,
  MemorySyncStateSchema,
  type MemorySyncFactResult,
  type MemorySyncReport,
  type MemorySyncSinkState,
  type MemorySyncSinkResult,
  type MemorySyncState
} from "./schemas.js";
import type { FileMemoryStore, MemoryFactEntry } from "./store.js";

export const MEMORY_SYNC_STATE_FILE = ".sync-state.json";

const ALL_SNAPSHOT_KINDS = ["current", "future", "path", "risk", "note"] as const;
const POSITIVE_SINK_STATUSES = new Set(["unchanged", "deduplicated", "synced"]);
const ISSUE_SINK_STATUSES = new Set(["blocked", "failed"]);

export interface SyncUpOptions {
  readonly operationalStore?: OperationalStore;
  readonly honchoClient?: HonchoClient;
  readonly projectSlug?: string;
  readonly scope?: string;
  readonly userApproved?: boolean;
  readonly now?: () => Date;
}

interface LoadedState {
  readonly state: MemorySyncState;
  readonly warnings: string[];
  readonly needsRewrite: boolean;
  readonly hasPendingCheckpoint: boolean;
}

interface LedgerCandidate {
  readonly bytes: Buffer;
  readonly malformed: boolean;
  readonly state?: MemorySyncState;
}

interface HonchoGate {
  readonly status: "ready" | "blocked" | "failed";
}

interface L3Intent {
  readonly path: string;
  readonly bytes: Buffer;
  readonly marker: string;
  readonly context: string;
  readonly expectedRaw: string;
}

interface ReplayL3Outcome {
  readonly result: MemorySyncSinkResult;
  readonly completedIntent?: L3Intent;
}

interface PublicationLockOwner {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
  readonly processStartIdentity?: string;
}

interface PublicationLock {
  readonly path: string;
  readonly ownerPath: string;
  readonly ownerBytes: Buffer;
}

class UnstableRegularFileError extends Error {}

/**
 * Replay dirty L1 facts upward. L1 remains authoritative: this function neither
 * pulls nor edits facts, and its L2/L3 checkpoints advance independently.
 */
export async function syncUp(memory: FileMemoryStore, options: SyncUpOptions = {}): Promise<MemorySyncReport> {
  const lockPath = join(memory.directory, `${MEMORY_SYNC_STATE_FILE}.lock`);
  const publicationLock = await acquirePublicationLock(lockPath);
  try {
    return await syncUpWhileLocked(memory, options);
  } finally {
    releasePublicationLock(publicationLock);
  }
}

async function syncUpWhileLocked(
  memory: FileMemoryStore,
  options: SyncUpOptions
): Promise<MemorySyncReport> {
  const now = options.now ?? (() => new Date());
  const syncedAt = now().toISOString();
  const projectSlug = options.projectSlug ?? "guruharness";
  const scope = options.scope ?? "global";
  const loaded = loadState(memory.directory);
  const state = loaded.state;
  let stateDirty = loaded.needsRewrite;
  let hasPendingCheckpoint = loaded.hasPendingCheckpoint;
  const completedL3Intents: L3Intent[] = [];
  let honchoGatePromise: Promise<HonchoGate> | undefined;

  const persistAcceptedProgress = (): void => {
    writePendingStateWhileLocked(memory.directory, state);
    hasPendingCheckpoint = true;
  };

  const honchoGate = (): Promise<HonchoGate> => {
    if (!honchoGatePromise) {
      honchoGatePromise = checkHonchoGate(options.honchoClient, options.userApproved === true);
    }
    return honchoGatePromise;
  };

  const entries = memory.list();
  const liveNames = new Set(entries.map((entry) => entry.fact.name));
  const results: MemorySyncFactResult[] = [];

  for (const entry of entries) {
    const canonical = serializeFactFile(entry.fact, entry.body);
    const contentHash = hashContent(canonical);
    const blockers = secretBlockers(entry, canonical);
    const previous = state.facts[entry.fact.name];

    const l2 = await replayL2({
      entry,
      contentHash,
      previousHash: previous?.l2?.contentHash,
      blockers,
      operationalStore: options.operationalStore,
      projectSlug,
      scope,
      now
    });
    if (advancesCheckpoint(l2)) {
      state.facts[entry.fact.name] = {
        ...state.facts[entry.fact.name],
        l2: { contentHash, syncedAt }
      };
      stateDirty = true;
      persistAcceptedProgress();
    }

    const l3Outcome = await replayL3({
      entry,
      canonical,
      contentHash,
      previousHash: previous?.l3?.contentHash,
      blockers,
      honchoClient: options.honchoClient,
      honchoGate,
      directory: memory.directory
    });
    const l3 = l3Outcome.result;
    if (advancesCheckpoint(l3)) {
      state.facts[entry.fact.name] = {
        ...state.facts[entry.fact.name],
        l3: { contentHash, syncedAt }
      };
      stateDirty = true;
      persistAcceptedProgress();
    }
    if (l3Outcome.completedIntent) {
      completedL3Intents.push(l3Outcome.completedIntent);
    }

    const resultBlockers = [...blockers];
    if (blockers.length === 0) {
      if (l2.status === "blocked") {
        resultBlockers.push(l2.summary);
      }
      if (l3.status === "blocked") {
        resultBlockers.push(l3.summary);
      }
    }
    results.push({
      name: entry.fact.name,
      contentHash,
      l2,
      l3,
      blockers: resultBlockers
    });
  }

  for (const name of Object.keys(state.facts)) {
    if (!liveNames.has(name)) {
      delete state.facts[name];
      stateDirty = true;
    }
  }

  if (stateDirty) {
    if (hasPendingCheckpoint) {
      writePendingStateWhileLocked(memory.directory, state);
    }
    writeStateWhileLocked(memory.directory, state);
    if (hasPendingCheckpoint) {
      removePendingCheckpoint(memory.directory);
    }
  }

  for (const intent of new Map(completedL3Intents.map((candidate) => [candidate.path, candidate])).values()) {
    removeL3Intent(intent);
  }

  const reportStatus = overallStatus(results);
  return MemorySyncReportSchema.parse({
    status: reportStatus,
    facts: results,
    warnings: loaded.warnings,
    summary: reportSummary(reportStatus, results)
  });
}

interface ReplayL2Input {
  readonly entry: MemoryFactEntry;
  readonly contentHash: string;
  readonly previousHash: string | undefined;
  readonly blockers: readonly string[];
  readonly operationalStore: OperationalStore | undefined;
  readonly projectSlug: string;
  readonly scope: string;
  readonly now: () => Date;
}

async function replayL2(input: ReplayL2Input): Promise<MemorySyncSinkResult> {
  if (!input.operationalStore) {
    return sinkResult("not-configured", "Operational memory replay is not configured.");
  }
  if (input.blockers.length > 0) {
    return sinkResult("blocked", "Operational memory replay was blocked by the secret-safety gate.");
  }
  if (input.previousHash === input.contentHash) {
    return sinkResult("unchanged", "Operational memory already has the current L1 content hash.");
  }

  try {
    if (input.entry.fact.type === "loadout") {
      const manifest = parseLoadout(input.entry.body, input.now);
      if (!manifest) {
        return sinkResult("blocked", "Operational replay requires a valid typed loadout manifest.");
      }
      await replayLoadout(input.operationalStore, input.entry, manifest, input.contentHash, input.projectSlug, input.scope);
      return sinkResult("synced", "Typed loadout layers were replayed to operational decisions.");
    }

    const existing = await input.operationalStore.listStateSnapshots({
      projectSlug: input.projectSlug,
      kinds: [...ALL_SNAPSHOT_KINDS],
      source: "file-memory",
      metadata: {
        memoryName: input.entry.fact.name,
        memoryType: input.entry.fact.type
      }
    });
    if (hasMatchingSnapshot(existing, input.entry, input.contentHash)) {
      return sinkResult("deduplicated", "A matching operational snapshot already exists; its checkpoint was rebuilt.");
    }

    await input.operationalStore.writeStateSnapshot({
      projectSlug: input.projectSlug,
      kind: input.entry.fact.type === "path-outcome" ? "path" : "note",
      title: input.entry.fact.title,
      body: input.entry.body,
      source: "file-memory",
      confidence: input.entry.fact.confidence,
      metadata: baseMetadata(input.entry, input.contentHash, input.scope)
    });
    return sinkResult("synced", "The L1 fact was replayed to an operational snapshot.");
  } catch {
    return sinkResult("failed", "Operational memory replay failed; its checkpoint was not advanced.");
  }
}

interface ReplayL3Input {
  readonly entry: MemoryFactEntry;
  readonly canonical: string;
  readonly contentHash: string;
  readonly previousHash: string | undefined;
  readonly blockers: readonly string[];
  readonly honchoClient: HonchoClient | undefined;
  readonly honchoGate: () => Promise<HonchoGate>;
  readonly directory: string;
}

async function replayL3(input: ReplayL3Input): Promise<ReplayL3Outcome> {
  if (!input.honchoClient) {
    return l3Outcome("not-configured", "Honcho memory replay is not configured.");
  }
  if (input.blockers.length > 0) {
    return l3Outcome("blocked", "Honcho memory replay was blocked by the secret-safety gate.");
  }
  const intent = createL3Intent(input.directory, input.entry, input.canonical, input.contentHash);
  const hasIntent = hasL3Intent(intent);
  if (input.previousHash === input.contentHash) {
    return l3Outcome(
      "unchanged",
      "Honcho memory already has the current L1 content hash.",
      hasIntent ? intent : undefined
    );
  }

  const gate = await input.honchoGate();
  if (gate.status === "blocked") {
    return l3Outcome("blocked", "Honcho replay requires explicit approval and a write-enabled status.");
  }
  if (gate.status === "failed") {
    return l3Outcome("failed", "Honcho readiness could not be verified; its checkpoint was not advanced.");
  }

  if (hasIntent) {
    const reconciliation = await reconcileL3Intent(input.honchoClient, intent);
    return reconciliation === "matched"
      ? l3Outcome(
          "deduplicated",
          "Honcho already contains the write identified by the durable sync intent; its checkpoint was rebuilt.",
          intent
        )
      : l3Outcome(
          "failed",
          "Honcho acknowledgement remains ambiguous; the durable sync intent was retained and no write was replayed."
        );
  }

  ensureL3Intent(intent);
  try {
    const result = await input.honchoClient.remember({
      peer: "user",
      fact: input.canonical,
      context: intent.context,
      writeEnabled: true,
      userApproved: true
    });
    if (result.status === "succeeded") {
      return l3Outcome("synced", "The canonical L1 fact was replayed to Honcho.", intent);
    }
    if (result.status === "blocked") {
      removeL3Intent(intent);
      return l3Outcome("blocked", "Honcho rejected the memory replay; its checkpoint was not advanced.");
    }
  } catch {
    // A thrown acknowledgement is ambiguous in the same way as an explicit
    // failed result: reconcile the stable marker before permitting any retry.
  }

  const reconciliation = await reconcileL3Intent(input.honchoClient, intent);
  return reconciliation === "matched"
    ? l3Outcome(
        "deduplicated",
        "Honcho accepted the write despite an ambiguous acknowledgement; its durable intent was reconciled.",
        intent
      )
    : l3Outcome(
        "failed",
        "Honcho acknowledgement remains ambiguous; the durable sync intent was retained and no write was replayed."
      );
}

function l3Outcome(
  status: MemorySyncSinkResult["status"],
  summary: string,
  completedIntent?: L3Intent
): ReplayL3Outcome {
  return { result: sinkResult(status, summary), ...(completedIntent ? { completedIntent } : {}) };
}

function createL3Intent(
  directory: string,
  entry: MemoryFactEntry,
  canonical: string,
  contentHash: string
): L3Intent {
  const memoryName = entry.fact.name;
  const marker = `guru-memory-sync-id=${contentHash}`;
  const context = `L1 memory fact ${memoryName} (${entry.fact.type}); ${marker}`;
  const expectedRaw = `${canonical}\n\nContext: ${context}`;
  const path = join(directory, `${MEMORY_SYNC_STATE_FILE}.l3-intent.${memoryName}.${contentHash}.json`);
  const bytes = Buffer.from(`${JSON.stringify({ version: 1, sink: "l3", memoryName, contentHash, marker })}\n`, "utf8");
  return { path, bytes, marker, context, expectedRaw };
}

function hasL3Intent(intent: L3Intent): boolean {
  try {
    const observed = lstatSync(intent.path);
    if (observed.isSymbolicLink() || !observed.isFile()) {
      throw new Error(`Memory sync intent ${intent.path} is not a regular file.`);
    }
  } catch (error) {
    if (fsErrorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (!matchesStableRegularFileNoFollow(intent.path, intent.bytes)) {
    throw new Error(`Memory sync intent ${intent.path} did not match the expected operation.`);
  }
  return true;
}

function ensureL3Intent(intent: L3Intent): void {
  if (hasL3Intent(intent)) {
    return;
  }
  if (!writeRecoveryFileExclusive(intent.path, intent.bytes) && !hasL3Intent(intent)) {
    throw new Error(`Unable to establish durable memory sync intent ${intent.path}.`);
  }
}

function removeL3Intent(intent: L3Intent): void {
  if (!hasL3Intent(intent)) {
    return;
  }
  rmSync(intent.path);
  fsyncContainingDirectory(intent.path);
}

async function reconcileL3Intent(
  client: HonchoClient,
  intent: L3Intent
): Promise<"matched" | "absent" | "failed"> {
  try {
    const recalled = await client.recall({
      query: intent.marker,
      peer: "user",
      reasoningLevel: "off",
      limit: 50,
      includeRaw: true
    });
    if (recalled.status !== "succeeded") {
      return "failed";
    }
    return recalled.items.some((item) => item.raw === intent.expectedRaw) ? "matched" : "absent";
  } catch {
    return "failed";
  }
}

async function checkHonchoGate(client: HonchoClient | undefined, userApproved: boolean): Promise<HonchoGate> {
  if (!client || !userApproved) {
    return { status: "blocked" };
  }
  try {
    const status = await client.status();
    return { status: status.writeEnabled ? "ready" : "blocked" };
  } catch {
    return { status: "failed" };
  }
}

function parseLoadout(body: string, now: () => Date): GarageManifest | undefined {
  const raw = /```json\n([\s\S]*?)\n```/u.exec(body)?.[1];
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const manifest = GarageManifestSchema.safeParse(parsed);
  if (manifest.success) {
    return manifest.data;
  }
  const legacy = RoleProfileSchema.safeParse(parsed);
  return legacy.success ? roleProfileToManifest(legacy.data, now) : undefined;
}

async function replayLoadout(
  operationalStore: OperationalStore,
  entry: MemoryFactEntry,
  manifest: GarageManifest,
  contentHash: string,
  projectSlug: string,
  scope: string
): Promise<void> {
  for (const layer of manifest.layers) {
    await operationalStore.upsertDecision({
      projectSlug,
      decisionKey: `loadout:${manifest.slug}:${layer.kind}:${layer.id}`,
      title: `${manifest.label}: ${layer.kind} ${layer.id}`,
      status: layer.status === "red" ? "rejected" : "accepted",
      owner: "Matthew",
      context: `L1 loadout ${entry.fact.name} records this ${layer.kind} layer.`,
      decision: `Use ${layer.kind} layer '${layer.id}' while the ${manifest.slug} loadout is active.`,
      consequences: layerConsequences(layer),
      metadata: {
        ...baseMetadata(entry, contentHash, scope),
        layerKind: layer.kind,
        layerId: layer.id,
        verificationHash: layer.verificationHash,
        coveringTestsRef: layer.coveringTestsRef,
        layerStatus: layer.status,
        staleFlag: layer.staleFlag
      }
    });
  }
}

function layerConsequences(layer: GarageLayer): string {
  if (layer.status === "red") {
    return "The layer remains recorded but rejected until its verification is repaired.";
  }
  if (layer.staleFlag) {
    return "The layer remains recorded and must be re-verified before use.";
  }
  return "The layer remains available subject to its recorded verification state.";
}

function baseMetadata(entry: MemoryFactEntry, contentHash: string, scope: string): JsonObject {
  return {
    memoryName: entry.fact.name,
    memoryType: entry.fact.type,
    scope,
    updatedAt: entry.fact.updatedAt,
    contentHash,
    ...(entry.fact.originSessionId ? { originSessionId: entry.fact.originSessionId } : {})
  };
}

function hasMatchingSnapshot(
  snapshots: readonly OperationalStateSnapshot[],
  entry: MemoryFactEntry,
  contentHash: string
): boolean {
  return snapshots.some(
    (snapshot) =>
      snapshot.metadata["contentHash"] === contentHash ||
      (snapshot.title === entry.fact.title && snapshot.body === entry.body && snapshot.confidence === entry.fact.confidence)
  );
}

function secretBlockers(entry: MemoryFactEntry, canonical: string): string[] {
  const uploadSurface = [{ name: `${entry.fact.name} canonical content`, value: canonical }];
  const blockers = detectPotentialSecrets(uploadSurface).map(
    (match) => `Potential secret detected in ${match.name} (${match.kind}; value redacted).`
  );
  if (containsSecretValue(canonical)) {
    blockers.push(`Potential secret shape detected in ${entry.fact.name} (value redacted).`);
  }
  return [...new Set(blockers)];
}

function loadState(directory: string): LoadedState {
  const path = join(directory, MEMORY_SYNC_STATE_FILE);
  const legacyTmpPath = `${path}.tmp`;
  const pendingPath = `${path}.pending`;
  const primary = readLedgerCandidate(path);
  const orphan = readLedgerCandidate(legacyTmpPath);
  const pending = readLedgerCandidate(pendingPath);
  const warnings: string[] = [];
  let state = primary?.state ?? emptyState();
  let needsRewrite = false;

  if (primary?.malformed) {
    const recoveryPath = preserveRecoveryCopy(path, primary.bytes, "malformed-primary");
    warnings.push(
      `The memory sync ledger was malformed; exact prior bytes were preserved at ${recoveryPath} before recovery.`
    );
    needsRewrite = true;
  }

  if (orphan) {
    const recoveryPath = preserveRecoveryCopy(legacyTmpPath, orphan.bytes, "orphan-temp");
    if (orphan.state) {
      state = mergeRecoveredState(state, orphan.state);
      warnings.push(
        `${orphan.malformed ? "Salvaged" : "Recovered"} an orphan memory sync checkpoint; exact prior bytes were preserved at ${recoveryPath}.`
      );
    } else {
      warnings.push(
        `The orphan memory sync checkpoint was malformed; exact prior bytes were preserved at ${recoveryPath}.`
      );
    }
    warnings.push(
      `The legacy orphan source ${legacyTmpPath} was left in place so a concurrent replacement can never be deleted by cleanup.`
    );
    needsRewrite = true;
  }

  if (pending) {
    const recoveryPath = pending.malformed
      ? preserveRecoveryCopy(pendingPath, pending.bytes, "malformed-pending")
      : undefined;
    if (pending.state) {
      state = mergeAcceptedState(state, pending.state);
      warnings.push(
        pending.malformed
          ? `Salvaged a pending accepted memory sync checkpoint; exact prior bytes were preserved at ${recoveryPath}.`
          : `Recovered a pending accepted memory sync checkpoint from ${pendingPath}.`
      );
    } else {
      warnings.push(
        `The pending memory sync checkpoint was malformed; exact prior bytes were preserved at ${recoveryPath}.`
      );
    }
    needsRewrite = true;
  }

  return { state, warnings, needsRewrite, hasPendingCheckpoint: pending?.state !== undefined };
}

function readLedgerCandidate(path: string): LedgerCandidate | undefined {
  const bytes = readStableRegularFileNoFollow(path);
  if (!bytes) {
    return undefined;
  }
  try {
    const raw: unknown = JSON.parse(bytes.toString("utf8"));
    const parsed = MemorySyncStateSchema.safeParse(raw);
    if (parsed.success) {
      return { bytes, malformed: false, state: parsed.data };
    }
    const salvaged = salvageCheckpoints(raw);
    return salvaged ? { bytes, malformed: true, state: salvaged } : { bytes, malformed: true };
  } catch {
    return { bytes, malformed: true };
  }
}

function salvageCheckpoints(raw: unknown): MemorySyncState | undefined {
  if (!isRecord(raw) || raw["version"] !== 1 || !isRecord(raw["facts"])) {
    return undefined;
  }
  const facts: MemorySyncState["facts"] = {};
  for (const [name, value] of Object.entries(raw["facts"])) {
    if (!MemoryFactNameSchema.safeParse(name).success || !isRecord(value)) {
      continue;
    }
    const l2 = MemorySyncSinkStateSchema.safeParse(value["l2"]);
    const l3 = MemorySyncSinkStateSchema.safeParse(value["l3"]);
    if (!l2.success && !l3.success) {
      continue;
    }
    facts[name] = {
      ...(l2.success ? { l2: l2.data } : {}),
      ...(l3.success ? { l3: l3.data } : {})
    };
  }
  if (Object.keys(facts).length === 0) {
    return undefined;
  }
  return MemorySyncStateSchema.parse({ version: 1, facts });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preserveRecoveryCopy(sourcePath: string, bytes: Buffer, kind: string): string {
  const ledgerPath = kind === "orphan-temp" ? sourcePath.slice(0, -".tmp".length) : sourcePath;
  const basePath = `${ledgerPath}.recovery.${kind}.${hashBytes(bytes)}`;
  let recoveryPath = basePath;
  let collision = 0;
  while (collision < 1_024) {
    assertRecoveryContainment(ledgerPath, recoveryPath);
    if (matchesStableRegularFileNoFollow(recoveryPath, bytes)) {
      return recoveryPath;
    }
    if (writeRecoveryFileExclusive(recoveryPath, bytes)) {
      if (!matchesStableRegularFileNoFollow(recoveryPath, bytes)) {
        throw new Error(`Recovery artifact ${recoveryPath} could not be verified after its exclusive write.`);
      }
      return recoveryPath;
    }
    collision += 1;
    recoveryPath = `${basePath}.${collision}`;
  }
  throw new Error(`Unable to establish a contained recovery artifact for ${sourcePath}.`);
}

function assertRecoveryContainment(ledgerPath: string, recoveryPath: string): void {
  const ledgerDirectory = realpathSync(dirname(ledgerPath));
  const recoveryDirectory = realpathSync(dirname(recoveryPath));
  if (ledgerDirectory !== recoveryDirectory) {
    throw new Error(`Recovery artifact ${recoveryPath} escaped the memory ledger directory.`);
  }
}

function readStableRegularFileNoFollow(path: string): Buffer | undefined {
  let fd: number | undefined;
  try {
    let pathBefore;
    try {
      pathBefore = lstatSync(path, { bigint: true });
    } catch (error) {
      if (fsErrorCode(error) === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
      throw new UnstableRegularFileError(`Memory sync file ${path} is not a stable regular file.`);
    }
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (["ENOENT", "ELOOP", "ENOTDIR"].includes(fsErrorCode(error) ?? "")) {
        throw new UnstableRegularFileError(`Memory sync file ${path} is not a stable regular file.`);
      }
      throw error;
    }
    const descriptorBefore = fstatSync(fd, { bigint: true });
    if (!descriptorBefore.isFile() || !sameFileIdentity(pathBefore, descriptorBefore)) {
      throw new UnstableRegularFileError(`Memory sync file ${path} is not a stable regular file.`);
    }
    const observed = readFileSync(fd);
    const descriptorAfter = fstatSync(fd, { bigint: true });
    let pathAfter;
    try {
      pathAfter = lstatSync(path, { bigint: true });
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(fsErrorCode(error) ?? "")) {
        throw new UnstableRegularFileError(`Memory sync file ${path} is not a stable regular file.`);
      }
      throw error;
    }
    if (
      sameFileIdentity(descriptorBefore, descriptorAfter) &&
      sameFileIdentity(descriptorAfter, pathAfter) &&
      !pathAfter.isSymbolicLink() &&
      pathAfter.isFile() &&
      descriptorBefore.size === descriptorAfter.size &&
      descriptorAfter.size === pathAfter.size &&
      descriptorAfter.size === BigInt(observed.byteLength) &&
      descriptorBefore.mtimeNs === descriptorAfter.mtimeNs &&
      descriptorAfter.mtimeNs === pathAfter.mtimeNs &&
      descriptorBefore.ctimeNs === descriptorAfter.ctimeNs &&
      descriptorAfter.ctimeNs === pathAfter.ctimeNs
    ) {
      return observed;
    }
    throw new UnstableRegularFileError(`Memory sync file ${path} is not a stable regular file.`);
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function matchesStableRegularFileNoFollow(path: string, expectedBytes: Buffer): boolean {
  try {
    return readStableRegularFileNoFollow(path)?.equals(expectedBytes) === true;
  } catch (error) {
    if (error instanceof UnstableRegularFileError) {
      return false;
    }
    throw error;
  }
}

function writeRecoveryFileExclusive(path: string, bytes: Buffer): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
  } catch (error) {
    if (["EEXIST", "ELOOP"].includes(fsErrorCode(error) ?? "")) {
      return false;
    }
    throw error;
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new Error(`Recovery artifact ${path} was not opened as a regular file.`);
    }
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    const written = fstatSync(fd);
    if (!written.isFile() || written.size !== bytes.byteLength) {
      throw new Error(`Recovery artifact ${path} did not retain every prior byte.`);
    }
    fsyncContainingDirectory(path);
    return true;
  } finally {
    closeSync(fd);
  }
}

function sameFileIdentity(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fsErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error["code"] === "string" ? error["code"] : undefined;
}

function mergeRecoveredState(primary: MemorySyncState, recovered: MemorySyncState): MemorySyncState {
  const names = new Set([...Object.keys(primary.facts), ...Object.keys(recovered.facts)]);
  const facts: MemorySyncState["facts"] = {};
  for (const name of names) {
    const primaryFact = primary.facts[name];
    const recoveredFact = recovered.facts[name];
    const l2 = laterCheckpoint(primaryFact?.l2, recoveredFact?.l2);
    const l3 = laterCheckpoint(primaryFact?.l3, recoveredFact?.l3);
    facts[name] = {
      ...(l2 ? { l2 } : {}),
      ...(l3 ? { l3 } : {})
    };
  }
  return MemorySyncStateSchema.parse({ version: 1, facts });
}

function mergeAcceptedState(primary: MemorySyncState, accepted: MemorySyncState): MemorySyncState {
  const names = new Set([...Object.keys(primary.facts), ...Object.keys(accepted.facts)]);
  const facts: MemorySyncState["facts"] = {};
  for (const name of names) {
    const primaryFact = primary.facts[name];
    const acceptedFact = accepted.facts[name];
    const l2 = acceptedCheckpoint(primaryFact?.l2, acceptedFact?.l2);
    const l3 = acceptedCheckpoint(primaryFact?.l3, acceptedFact?.l3);
    facts[name] = {
      ...(l2 ? { l2 } : {}),
      ...(l3 ? { l3 } : {})
    };
  }
  return MemorySyncStateSchema.parse({ version: 1, facts });
}

function laterCheckpoint(
  primary: MemorySyncSinkState | undefined,
  recovered: MemorySyncSinkState | undefined
): MemorySyncSinkState | undefined {
  if (!primary) {
    return recovered;
  }
  if (!recovered) {
    return primary;
  }
  const primaryTime = Date.parse(primary.syncedAt);
  const recoveredTime = Date.parse(recovered.syncedAt);
  if (primaryTime === recoveredTime && primary.contentHash !== recovered.contentHash) {
    throw new Error(
      "Memory sync primary and recovered checkpoints have equal syncedAt values but different content hashes."
    );
  }
  return recoveredTime > primaryTime ? recovered : primary;
}

function acceptedCheckpoint(
  primary: MemorySyncSinkState | undefined,
  accepted: MemorySyncSinkState | undefined
): MemorySyncSinkState | undefined {
  if (!primary) {
    return accepted;
  }
  if (!accepted) {
    return primary;
  }
  const primaryTime = Date.parse(primary.syncedAt);
  const acceptedTime = Date.parse(accepted.syncedAt);
  if (primaryTime === acceptedTime && primary.contentHash !== accepted.contentHash) {
    throw new Error(
      "Memory sync primary and pending checkpoints have equal syncedAt values but different content hashes."
    );
  }
  return acceptedTime >= primaryTime ? accepted : primary;
}

function emptyState(): MemorySyncState {
  return { version: 1, facts: {} };
}

function writeStateWhileLocked(directory: string, state: MemorySyncState): void {
  const path = join(directory, MEMORY_SYNC_STATE_FILE);
  writeStateReplacement(path, state);
}

function writePendingStateWhileLocked(directory: string, state: MemorySyncState): void {
  const path = join(directory, `${MEMORY_SYNC_STATE_FILE}.pending`);
  writeStateReplacement(path, state);
}

function removePendingCheckpoint(directory: string): void {
  const path = join(directory, `${MEMORY_SYNC_STATE_FILE}.pending`);
  let observed: ReturnType<typeof lstatSync>;
  try {
    observed = lstatSync(path);
  } catch (error) {
    if (fsErrorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  if (observed.isSymbolicLink() || !observed.isFile()) {
    throw new Error(`Pending memory sync checkpoint ${path} is not a regular file.`);
  }
  rmSync(path);
  fsyncContainingDirectory(path);
}

async function acquirePublicationLock(lockPath: string): Promise<PublicationLock> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const availablePath = availablePublicationLockPath(lockPath);
    if (!availablePath) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      continue;
    }
    const candidate = createPublicationLock(availablePath);
    if (!writeRecoveryFileExclusive(candidate.ownerPath, candidate.ownerBytes)) {
      continue;
    }
    try {
      linkSync(candidate.ownerPath, candidate.path);
    } catch (error) {
      removeOwnedRegularFile(candidate.ownerPath, candidate.ownerBytes);
      if (fsErrorCode(error) === "EEXIST") {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        continue;
      }
      throw error;
    }
    try {
      fsyncContainingDirectory(candidate.path);
      if (
        !matchesStableRegularFileNoFollow(candidate.path, candidate.ownerBytes) ||
        !matchesStableRegularFileNoFollow(candidate.ownerPath, candidate.ownerBytes)
      ) {
        throw new Error(`Memory sync publication lock ${candidate.path} could not be verified after acquisition.`);
      }
      return candidate;
    } catch (error) {
      discardPublicationLock(candidate);
      throw error;
    }
  }
  throw new Error(`Timed out waiting for the memory sync publication lock at ${lockPath}; no ledger was replaced.`);
}

function createPublicationLock(path: string): PublicationLock {
  const token = randomUUID();
  const processStartIdentity = readProcessStartIdentity(process.pid);
  const owner: PublicationLockOwner = {
    version: 1,
    pid: process.pid,
    token,
    ...(processStartIdentity ? { processStartIdentity } : {})
  };
  return {
    path,
    ownerPath: `${path}.owner.${process.pid}.${token}`,
    ownerBytes: Buffer.from(`${JSON.stringify(owner)}\n`, "utf8")
  };
}

function releasePublicationLock(lock: PublicationLock): void {
  if (
    !matchesStableRegularFileNoFollow(lock.path, lock.ownerBytes) ||
    !matchesStableRegularFileNoFollow(lock.ownerPath, lock.ownerBytes)
  ) {
    throw new Error(`Memory sync publication lock ${lock.path} is no longer owned by this process.`);
  }
  rmSync(lock.path);
  fsyncContainingDirectory(lock.path);
  removeOwnedRegularFile(lock.ownerPath, lock.ownerBytes);
}

function discardPublicationLock(lock: PublicationLock): void {
  if (matchesStableRegularFileNoFollow(lock.path, lock.ownerBytes)) {
    rmSync(lock.path);
    fsyncContainingDirectory(lock.path);
  }
  if (matchesStableRegularFileNoFollow(lock.ownerPath, lock.ownerBytes)) {
    removeOwnedRegularFile(lock.ownerPath, lock.ownerBytes);
  }
}

function removeOwnedRegularFile(path: string, expectedBytes: Buffer): void {
  if (!matchesStableRegularFileNoFollow(path, expectedBytes)) {
    throw new Error(`Owned memory sync artifact ${path} changed before cleanup.`);
  }
  rmSync(path);
  fsyncContainingDirectory(path);
}

function availablePublicationLockPath(basePath: string): string | undefined {
  const visited = new Set<string>();
  let candidatePath = basePath;
  for (let depth = 0; depth < 1_024; depth += 1) {
    if (visited.has(candidatePath)) {
      return undefined;
    }
    visited.add(candidatePath);
    let bytes: Buffer | undefined;
    try {
      bytes = readStableRegularFileNoFollow(candidatePath);
    } catch (error) {
      if (error instanceof UnstableRegularFileError) {
        return undefined;
      }
      throw error;
    }
    if (!bytes) {
      return candidatePath;
    }
    const owner = parsePublicationLockOwner(bytes);
    if (!owner || publicationLockOwnerIsAlive(owner)) {
      return undefined;
    }
    candidatePath = `${basePath}.successor.${owner.token}`;
  }
  return undefined;
}

function parsePublicationLockOwner(bytes: Buffer): PublicationLockOwner | undefined {
  try {
    const raw: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !isRecord(raw) ||
      raw["version"] !== 1 ||
      !Number.isInteger(raw["pid"]) ||
      typeof raw["pid"] !== "number" ||
      raw["pid"] <= 0 ||
      raw["pid"] > 2_147_483_647 ||
      typeof raw["token"] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(raw["token"]) ||
      (raw["processStartIdentity"] !== undefined && typeof raw["processStartIdentity"] !== "string")
    ) {
      return undefined;
    }
    return {
      version: 1,
      pid: raw["pid"],
      token: raw["token"],
      ...(raw["processStartIdentity"] ? { processStartIdentity: raw["processStartIdentity"] } : {})
    };
  } catch {
    return undefined;
  }
}

function publicationLockOwnerIsAlive(owner: PublicationLockOwner): boolean {
  if (owner.processStartIdentity) {
    const observedIdentity = readProcessStartIdentity(owner.pid);
    if (observedIdentity && observedIdentity !== owner.processStartIdentity) {
      return false;
    }
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return fsErrorCode(error) !== "ESRCH";
  }
}

function readProcessStartIdentity(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) {
      return undefined;
    }
    const fieldsFromState = stat.slice(commandEnd + 1).trim().split(/\s+/u);
    const startTime = fieldsFromState[19];
    return startTime && /^\d+$/u.test(startTime) ? startTime : undefined;
  } catch {
    return undefined;
  }
}

function writeStateReplacement(path: string, state: MemorySyncState): void {
  const tmpPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  let fd: number | undefined;
  try {
    const validated = MemorySyncStateSchema.parse(state);
    fd = openSync(
      tmpPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    writeFileSync(fd, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, path);
    fsyncContainingDirectory(path);
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
    if (existsSync(tmpPath)) {
      rmSync(tmpPath, { force: true });
    }
  }
}

function fsyncContainingDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirname(path), constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(fsErrorCode(error) ?? "")
    ) {
      return;
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function advancesCheckpoint(result: MemorySyncSinkResult): boolean {
  return result.status === "synced" || result.status === "deduplicated";
}

function sinkResult(status: MemorySyncSinkResult["status"], summary: string): MemorySyncSinkResult {
  return { status, summary };
}

function overallStatus(results: readonly MemorySyncFactResult[]): MemorySyncReport["status"] {
  const statuses = results.flatMap((result) => [result.l2.status, result.l3.status]);
  const hasIssue = statuses.some((status) => ISSUE_SINK_STATUSES.has(status));
  const hasPositive = statuses.some((status) => POSITIVE_SINK_STATUSES.has(status));
  if (hasIssue) {
    return hasPositive ? "partial" : "blocked";
  }
  return "succeeded";
}

function reportSummary(status: MemorySyncReport["status"], results: readonly MemorySyncFactResult[]): string {
  if (status === "blocked") {
    return `Memory sync was blocked for ${results.length} L1 fact(s); no blocked checkpoint advanced.`;
  }
  if (status === "partial") {
    return `Memory sync made partial progress across ${results.length} L1 fact(s); unfinished sinks remain retryable.`;
  }
  return `Memory sync checked ${results.length} L1 fact(s) and completed every configured replay.`;
}
