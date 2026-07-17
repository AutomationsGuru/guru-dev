import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GarageManifestSchema } from "../../src/garage/manifest.js";
import { parkManifest } from "../../src/garage/store.js";
import { createInMemoryHonchoClient, type HonchoClient } from "../../src/honcho/client.js";
import { HonchoConfigSchema } from "../../src/honcho/schemas.js";
import { MemorySyncReportSchema, MemorySyncStateSchema } from "../../src/memory/schemas.js";
import { createFileMemoryStore, type FileMemoryStore } from "../../src/memory/store.js";
import { MEMORY_SYNC_STATE_FILE, syncUp } from "../../src/memory/sync.js";
import { createInMemoryOperationalStore } from "../../src/operational/store.js";

const cleanups: string[] = [];
const FIXED_TIME = "2026-07-15T21:36:00.000Z";

function makeMemory(): { readonly memory: FileMemoryStore; readonly directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "guru-memory-sync-"));
  cleanups.push(directory);
  return { memory: createFileMemoryStore({ directory, sessionId: "sync-test-session" }), directory };
}

function rememberProject(memory: FileMemoryStore, body: string): void {
  const result = memory.remember({
    name: "sync-project-fact",
    title: "Sync project fact",
    description: "A project fact used to exercise upward memory replay",
    body,
    type: "project",
    edit: "replace",
    confidence: 0.9
  });
  expect(["created", "updated"]).toContain(result.status);
}

function makeHoncho(writeEnabled: boolean): HonchoClient {
  return createInMemoryHonchoClient({
    config: HonchoConfigSchema.parse({
      enabled: true,
      workspaceId: "guruharness",
      requiredEnvNames: ["HONCHO_API_KEY"],
      writeEnabled
    }),
    env: { HONCHO_API_KEY: "present" }
  });
}

function readSyncState(directory: string) {
  return MemorySyncStateSchema.parse(JSON.parse(readFileSync(join(directory, MEMORY_SYNC_STATE_FILE), "utf8")));
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of cleanups.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("memory sync — dirty replay and independent state", () => {
  it("pushes a dirty fact to L2 and records its canonical hash atomically", async () => {
    const { memory, directory } = makeMemory();
    const operationalStore = createInMemoryOperationalStore();
    rememberProject(memory, "The canonical L1 body.");

    const report = await syncUp(memory, {
      operationalStore,
      now: () => new Date(FIXED_TIME)
    });

    expect(report).toMatchObject({
      status: "succeeded",
      facts: [
        {
          name: "sync-project-fact",
          l2: { status: "synced" },
          l3: { status: "not-configured" }
        }
      ]
    });
    const snapshots = await operationalStore.listStateSnapshots({
      projectSlug: "guruharness",
      kinds: ["note"],
      source: "file-memory",
      metadata: { memoryName: "sync-project-fact" }
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      title: "Sync project fact",
      body: "The canonical L1 body.",
      confidence: 0.9,
      metadata: {
        memoryName: "sync-project-fact",
        memoryType: "project",
        scope: "global",
        originSessionId: "sync-test-session"
      }
    });
    const state = readSyncState(directory);
    expect(state.facts["sync-project-fact"]?.l2).toEqual({
      contentHash: report.facts[0]?.contentHash,
      syncedAt: FIXED_TIME
    });
    expect(state.facts["sync-project-fact"]?.l3).toBeUndefined();
    expect(existsSync(join(directory, `${MEMORY_SYNC_STATE_FILE}.tmp`))).toBe(false);
  });

  it("skips an unchanged second run and replays changed canonical content", async () => {
    const { memory } = makeMemory();
    const operationalStore = createInMemoryOperationalStore();
    rememberProject(memory, "First body.");

    const first = await syncUp(memory, { operationalStore });
    const second = await syncUp(memory, { operationalStore });
    rememberProject(memory, "Second body.");
    const third = await syncUp(memory, { operationalStore });

    expect(first.facts[0]?.l2.status).toBe("synced");
    expect(second.facts[0]?.l2.status).toBe("unchanged");
    expect(third.facts[0]?.l2.status).toBe("synced");
    expect(third.facts[0]?.contentHash).not.toBe(first.facts[0]?.contentHash);
    const snapshots = await operationalStore.listStateSnapshots({
      projectSlug: "guruharness",
      kinds: ["note"],
      source: "file-memory",
      metadata: { memoryName: "sync-project-fact" }
    });
    expect(snapshots.map((snapshot) => snapshot.body)).toEqual(["First body.", "Second body."]);
  });

  it("rebuilds a lost ledger from matching operational metadata without duplicating a snapshot", async () => {
    const { memory, directory } = makeMemory();
    const operationalStore = createInMemoryOperationalStore();
    rememberProject(memory, "Ledger-loss deduplication body.");
    const first = await syncUp(memory, { operationalStore });
    rmSync(join(directory, MEMORY_SYNC_STATE_FILE));

    const replay = await syncUp(memory, { operationalStore });

    expect(replay.facts[0]?.contentHash).toBe(first.facts[0]?.contentHash);
    expect(replay.facts[0]?.l2.status).toBe("deduplicated");
    const snapshots = await operationalStore.listStateSnapshots({
      projectSlug: "guruharness",
      kinds: ["note"],
      source: "file-memory",
      metadata: { memoryName: "sync-project-fact" }
    });
    expect(snapshots).toHaveLength(1);
    expect(readSyncState(directory).facts["sync-project-fact"]?.l2?.contentHash).toBe(first.facts[0]?.contentHash);
  });

  it("maps typed loadout layers to stable operational decision keys", async () => {
    const { memory, directory } = makeMemory();
    parkManifest(
      memory,
      GarageManifestSchema.parse({
        manifestVersion: 1,
        slug: "finance",
        label: "Finance",
        layers: [
          {
            kind: "tool",
            id: "memory_search",
            verificationHash: "verified-memory-search",
            coveringTestsRef: "tests/memory/store.test.ts",
            status: "verified",
            provenance: "observed",
            staleFlag: false,
            lastVerifiedAt: FIXED_TIME,
            donePacketRef: ""
          }
        ]
      })
    );
    const operationalStore = createInMemoryOperationalStore();
    const upsert = vi.spyOn(operationalStore, "upsertDecision");

    const first = await syncUp(memory, { operationalStore });
    rmSync(join(directory, MEMORY_SYNC_STATE_FILE));
    const replay = await syncUp(memory, { operationalStore });

    expect(first.facts[0]?.l2.status).toBe("synced");
    expect(replay.facts[0]?.l2.status).toBe("synced");
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls.map(([input]) => input.decisionKey)).toEqual([
      "loadout:finance:tool:memory_search",
      "loadout:finance:tool:memory_search"
    ]);
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          memoryName: "role-finance",
          memoryType: "loadout",
          layerKind: "tool",
          layerId: "memory_search"
        })
      })
    );
  });

  it("records partial progress and retries only the sink that did not finish", async () => {
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Partial replay body.");
    const operationalStore = createInMemoryOperationalStore();
    vi.spyOn(operationalStore, "writeStateSnapshot").mockRejectedValueOnce(new Error("L2 unavailable"));
    const honchoClient = makeHoncho(true);
    const remember = vi.spyOn(honchoClient, "remember");

    const first = await syncUp(memory, {
      operationalStore,
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });
    const stateAfterFirst = readSyncState(directory);
    const second = await syncUp(memory, {
      operationalStore,
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });

    expect(first).toMatchObject({ status: "partial", facts: [{ l2: { status: "failed" }, l3: { status: "synced" } }] });
    expect(stateAfterFirst.facts["sync-project-fact"]?.l2).toBeUndefined();
    expect(stateAfterFirst.facts["sync-project-fact"]?.l3?.syncedAt).toBe(FIXED_TIME);
    expect(second).toMatchObject({ status: "succeeded", facts: [{ l2: { status: "synced" }, l3: { status: "unchanged" } }] });
    expect(remember).toHaveBeenCalledTimes(1);
  });
});

describe("memory sync — gates and recovery", () => {
  it("requires both user approval and a write-enabled Honcho status before calling remember", async () => {
    const { memory } = makeMemory();
    rememberProject(memory, "Honcho gate body.");
    const writeEnabled = makeHoncho(true);
    const enabledStatus = vi.spyOn(writeEnabled, "status");
    const enabledRemember = vi.spyOn(writeEnabled, "remember");

    const noApproval = await syncUp(memory, { honchoClient: writeEnabled, userApproved: false });

    expect(noApproval).toMatchObject({ status: "blocked", facts: [{ l3: { status: "blocked" } }] });
    expect(enabledStatus).not.toHaveBeenCalled();
    expect(enabledRemember).not.toHaveBeenCalled();

    const readOnly = makeHoncho(false);
    const readOnlyStatus = vi.spyOn(readOnly, "status");
    const readOnlyRemember = vi.spyOn(readOnly, "remember");
    const disabled = await syncUp(memory, { honchoClient: readOnly, userApproved: true });

    expect(disabled).toMatchObject({ status: "blocked", facts: [{ l3: { status: "blocked" } }] });
    expect(readOnlyStatus).toHaveBeenCalledTimes(1);
    expect(readOnlyRemember).not.toHaveBeenCalled();
  });

  it("re-checks hand-edited facts for secrets before touching either sink", async () => {
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Safe body before a hand edit.");
    const leaked = "api_key=abcdef0123456789";
    const factPath = join(directory, "sync-project-fact.md");
    writeFileSync(factPath, readFileSync(factPath, "utf8").replace("Safe body before a hand edit.", leaked), "utf8");
    const operationalStore = createInMemoryOperationalStore();
    const writeSnapshot = vi.spyOn(operationalStore, "writeStateSnapshot");
    const honchoClient = makeHoncho(true);
    const honchoStatus = vi.spyOn(honchoClient, "status");
    const honchoRemember = vi.spyOn(honchoClient, "remember");

    const report = await syncUp(memory, { operationalStore, honchoClient, userApproved: true });

    expect(report).toMatchObject({
      status: "blocked",
      facts: [{ l2: { status: "blocked" }, l3: { status: "blocked" } }]
    });
    expect(JSON.stringify(report)).not.toContain(leaked);
    expect(writeSnapshot).not.toHaveBeenCalled();
    expect(honchoStatus).not.toHaveBeenCalled();
    expect(honchoRemember).not.toHaveBeenCalled();
    expect(existsSync(join(directory, MEMORY_SYNC_STATE_FILE))).toBe(false);
  });

  it("also blocks secret-shaped hand edits in frontmatter metadata", async () => {
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Safe body with frontmatter that will be hand edited.");
    const leaked = "api_key=abcdef0123456789";
    const factPath = join(directory, "sync-project-fact.md");
    writeFileSync(factPath, readFileSync(factPath, "utf8").replace(/^updatedAt: .*$/mu, `updatedAt: ${leaked}`), "utf8");
    const operationalStore = createInMemoryOperationalStore();
    const writeSnapshot = vi.spyOn(operationalStore, "writeStateSnapshot");
    const honchoClient = makeHoncho(true);
    const honchoStatus = vi.spyOn(honchoClient, "status");

    const report = await syncUp(memory, { operationalStore, honchoClient, userApproved: true });

    expect(report).toMatchObject({
      status: "blocked",
      facts: [{ l2: { status: "blocked" }, l3: { status: "blocked" } }]
    });
    expect(JSON.stringify(report)).not.toContain(leaked);
    expect(writeSnapshot).not.toHaveBeenCalled();
    expect(honchoStatus).not.toHaveBeenCalled();
    expect(existsSync(join(directory, MEMORY_SYNC_STATE_FILE))).toBe(false);
  });

  it("rejects a recovery-path symlink and preserves malformed primary bytes in a contained regular file", async () => {
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Recovery symlink adversarial body.");
    const statePath = join(directory, MEMORY_SYNC_STATE_FILE);
    const malformedPrimary = Buffer.from("{malformed-ledger", "utf8");
    writeFileSync(statePath, malformedPrimary);
    const maliciousRecoveryPath = `${statePath}.recovery.malformed-primary.${createHash("sha256")
      .update(malformedPrimary)
      .digest("hex")}`;
    symlinkSync(statePath, maliciousRecoveryPath, "file");

    const report = await syncUp(memory);

    expect(lstatSync(maliciousRecoveryPath).isSymbolicLink()).toBe(true);
    const regularRecoveryPaths = readdirSync(directory)
      .filter((name) => name.startsWith(`${MEMORY_SYNC_STATE_FILE}.recovery.malformed-primary.`))
      .map((name) => join(directory, name))
      .filter((path) => !lstatSync(path).isSymbolicLink());
    expect(regularRecoveryPaths).toHaveLength(1);
    expect(lstatSync(regularRecoveryPaths[0]!).isFile()).toBe(true);
    expect(realpathSync(dirname(regularRecoveryPaths[0]!))).toBe(realpathSync(directory));
    expect(readFileSync(regularRecoveryPaths[0]!)).toEqual(malformedPrimary);
    expect(report.warnings.some((warning) => warning.includes(regularRecoveryPaths[0]!))).toBe(true);
    expect(MemorySyncStateSchema.safeParse(JSON.parse(readFileSync(statePath, "utf8"))).success).toBe(true);
  });

  it.each([
    MEMORY_SYNC_STATE_FILE,
    `${MEMORY_SYNC_STATE_FILE}.tmp`,
    `${MEMORY_SYNC_STATE_FILE}.pending`
  ])("fails closed without reading a %s symlink as trusted checkpoint state", async (ledgerName) => {
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Symlinked ledger input body.");
    const discovery = await syncUp(memory, { now: () => new Date(FIXED_TIME) });
    const contentHash = discovery.facts[0]?.contentHash;
    expect(contentHash).toBeDefined();
    const externalDirectory = mkdtempSync(join(tmpdir(), "guru-memory-sync-external-"));
    cleanups.push(externalDirectory);
    const externalPath = join(externalDirectory, "untrusted-ledger.json");
    const externalBytes = Buffer.from(
      `${JSON.stringify({
        version: 1,
        facts: {
          "sync-project-fact": {
            l3: { contentHash, syncedAt: FIXED_TIME }
          }
        }
      })}\n`,
      "utf8"
    );
    writeFileSync(externalPath, externalBytes);
    const ledgerPath = join(directory, ledgerName);
    symlinkSync(externalPath, ledgerPath, "file");
    const honchoClient = makeHoncho(true);
    const remember = vi.spyOn(honchoClient, "remember");

    const error = await syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    }).then(
      () => undefined,
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("not a stable regular file");
    expect(lstatSync(ledgerPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(externalPath)).toEqual(externalBytes);
    expect(readdirSync(directory).filter((name) => name.includes(".recovery."))).toEqual([]);
    expect(remember).not.toHaveBeenCalled();
  });

  it("retains a concurrently replaced legacy orphan while preserving the bytes originally observed", async () => {
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Concurrent orphan replacement body.");
    const statePath = join(directory, MEMORY_SYNC_STATE_FILE);
    const orphanPath = `${statePath}.tmp`;
    const observedOrphan = Buffer.from("observed legacy orphan bytes", "utf8");
    const concurrentReplacement = Buffer.from("concurrent writer replacement bytes", "utf8");
    writeFileSync(orphanPath, observedOrphan);
    const operationalStore = createInMemoryOperationalStore();
    const reachedReplay = deferred();
    const releaseReplay = deferred();
    const originalList = operationalStore.listStateSnapshots.bind(operationalStore);
    vi.spyOn(operationalStore, "listStateSnapshots").mockImplementation(async (query) => {
      reachedReplay.resolve();
      await releaseReplay.promise;
      return originalList(query);
    });

    const syncing = syncUp(memory, { operationalStore });
    await reachedReplay.promise;
    writeFileSync(orphanPath, concurrentReplacement);
    releaseReplay.resolve();
    const report = await syncing;

    expect(readFileSync(orphanPath)).toEqual(concurrentReplacement);
    const recoveryPaths = readdirSync(directory)
      .filter((name) => name.startsWith(`${MEMORY_SYNC_STATE_FILE}.recovery.orphan-temp.`))
      .map((name) => join(directory, name));
    expect(recoveryPaths.some((path) => readFileSync(path).equals(observedOrphan))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes(orphanPath) && warning.includes("left in place"))).toBe(true);
  });

  it("merges concurrent L2 and L3 checkpoint publication without replaying either completed sink", async () => {
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Concurrent checkpoint merge body.");
    const operationalStore = createInMemoryOperationalStore();
    const honchoClient = makeHoncho(true);
    const l2Started = deferred();
    const releaseL2 = deferred();
    const l3Started = deferred();
    const releaseL3 = deferred();
    const originalWrite = operationalStore.writeStateSnapshot.bind(operationalStore);
    const writeSnapshot = vi.spyOn(operationalStore, "writeStateSnapshot").mockImplementation(async (input) => {
      l2Started.resolve();
      await releaseL2.promise;
      return originalWrite(input);
    });
    const originalRemember = honchoClient.remember.bind(honchoClient);
    const remember = vi.spyOn(honchoClient, "remember").mockImplementation(async (input) => {
      l3Started.resolve();
      await releaseL3.promise;
      return originalRemember(input);
    });

    const l2Sync = syncUp(memory, {
      operationalStore,
      now: () => new Date(FIXED_TIME)
    });
    const l3Sync = syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });
    await l2Started.promise;
    const l3ReachedSinkBeforeL2Release = await Promise.race([
      l3Started.promise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))
    ]);
    if (l3ReachedSinkBeforeL2Release) {
      releaseL3.resolve();
      await l3Sync;
    }
    releaseL2.resolve();
    await l2Sync;
    if (!l3ReachedSinkBeforeL2Release) {
      await l3Started.promise;
      releaseL3.resolve();
      await l3Sync;
    }

    const mergedState = readSyncState(directory);
    expect(mergedState.facts["sync-project-fact"]?.l2?.contentHash).toBeDefined();
    expect(mergedState.facts["sync-project-fact"]?.l3?.contentHash).toBeDefined();
    const replay = await syncUp(memory, {
      operationalStore,
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });
    expect(replay.facts[0]?.l2.status).toBe("unchanged");
    expect(replay.facts[0]?.l3.status).toBe("unchanged");
    expect(writeSnapshot).toHaveBeenCalledTimes(1);
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it("preserves the current same-sink checkpoint when equal-time syncs finish out of order", async () => {
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Older same-sink body.");
    const honchoClient = makeHoncho(true);
    const olderStarted = deferred();
    const releaseOlder = deferred();
    const newerStarted = deferred();
    const originalRemember = honchoClient.remember.bind(honchoClient);
    const remember = vi.spyOn(honchoClient, "remember").mockImplementation(async (input) => {
      if (input.fact.includes("Older same-sink body.")) {
        olderStarted.resolve();
        await releaseOlder.promise;
      } else {
        newerStarted.resolve();
      }
      return originalRemember(input);
    });

    const olderSync = syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });
    await olderStarted.promise;
    rememberProject(memory, "Newer same-sink body.");
    const newerSync = syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });
    const newerReachedSinkBeforeRelease = await Promise.race([
      newerStarted.promise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))
    ]);
    if (newerReachedSinkBeforeRelease) {
      await newerSync;
    }
    releaseOlder.resolve();
    await Promise.all([olderSync, newerSync]);

    const checkpointAfterRace = readSyncState(directory).facts["sync-project-fact"]?.l3?.contentHash;
    const replay = await syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });

    expect(checkpointAfterRace).toBe(replay.facts[0]?.contentHash);
    expect(replay.facts[0]?.l3.status).toBe("unchanged");
    expect(remember).toHaveBeenCalledTimes(2);
  });

  it("fails closed before an external sink call when the publication lock is unavailable", async () => {
    vi.useFakeTimers();
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Locked publication body.");
    mkdirSync(join(directory, `${MEMORY_SYNC_STATE_FILE}.lock`), { mode: 0o700 });
    const honchoClient = makeHoncho(true);
    const remember = vi.spyOn(honchoClient, "remember");

    const outcome = syncUp(memory, { honchoClient, userApproved: true }).then(
      () => undefined,
      (error: unknown) => error
    );
    await vi.runAllTimersAsync();
    const error = await outcome;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Timed out waiting for the memory sync publication lock");
    expect(remember).not.toHaveBeenCalled();
    expect(existsSync(join(directory, `${MEMORY_SYNC_STATE_FILE}.lock`))).toBe(true);
    expect(existsSync(join(directory, MEMORY_SYNC_STATE_FILE))).toBe(false);
  });

  it("advances past a preserved dead-owner lock before reconciling a durable Honcho intent", async () => {
    vi.useFakeTimers();
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Crashed owner reconciliation body.");
    const statePath = join(directory, MEMORY_SYNC_STATE_FILE);
    const lockPath = `${statePath}.lock`;
    const honchoClient = makeHoncho(true);
    const originalRemember = honchoClient.remember.bind(honchoClient);
    let acceptedRaw = "";
    const remember = vi.spyOn(honchoClient, "remember").mockImplementationOnce(async (input) => {
      acceptedRaw = input.context ? `${input.fact}\n\nContext: ${input.context}` : input.fact;
      await originalRemember(input);
      return { status: "failed", summary: "The process lost the acknowledgement after acceptance." };
    });
    const recall = vi.spyOn(honchoClient, "recall").mockResolvedValueOnce({
      status: "failed",
      items: [],
      summary: "The first reconciliation read was unavailable."
    });
    const first = await syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });
    expect(first.facts[0]?.l3.status).toBe("failed");
    expect(readdirSync(directory).filter((name) => name.includes(".l3-intent."))).toHaveLength(1);

    const staleToken = "00000000-0000-4000-8000-000000000001";
    const staleBytes = Buffer.from(
      `${JSON.stringify({ version: 1, pid: 2_147_483_647, token: staleToken })}\n`,
      "utf8"
    );
    writeFileSync(lockPath, staleBytes, { mode: 0o600 });
    recall.mockResolvedValueOnce({
      status: "succeeded",
      items: [{ id: "accepted-target-record", peer: "user", summary: "Accepted target record.", raw: acceptedRaw }],
      summary: "Recall returned the exact accepted target record."
    });

    const recovery = syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });
    await vi.runAllTimersAsync();
    const recovered = await recovery;

    expect(recovered.facts[0]?.l3.status).toBe("deduplicated");
    expect(remember).toHaveBeenCalledTimes(1);
    expect(readFileSync(lockPath)).toEqual(staleBytes);
    expect(readdirSync(directory).filter((name) => name.includes(".lock.recovered."))).toEqual([]);
    expect(readdirSync(directory).filter((name) => name.includes(".l3-intent."))).toEqual([]);
  });

  it("serializes concurrent callers through one successor of a preserved dead-owner lock", async () => {
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Dead-owner successor serialization body.");
    const lockPath = join(directory, `${MEMORY_SYNC_STATE_FILE}.lock`);
    const staleBytes = Buffer.from(
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        token: "00000000-0000-4000-8000-000000000002"
      })}\n`,
      "utf8"
    );
    writeFileSync(lockPath, staleBytes, { mode: 0o600 });
    const honchoClient = makeHoncho(true);
    const firstReachedSink = deferred();
    const releaseFirst = deferred();
    const originalRemember = honchoClient.remember.bind(honchoClient);
    const remember = vi.spyOn(honchoClient, "remember").mockImplementation(async (input) => {
      firstReachedSink.resolve();
      await releaseFirst.promise;
      return originalRemember(input);
    });

    const first = syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });
    await firstReachedSink.promise;
    const second = syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(remember).toHaveBeenCalledTimes(1);
    releaseFirst.resolve();
    const [firstReport, secondReport] = await Promise.all([first, second]);

    expect(firstReport.facts[0]?.l3.status).toBe("synced");
    expect(secondReport.facts[0]?.l3.status).toBe("unchanged");
    expect(remember).toHaveBeenCalledTimes(1);
    expect(readFileSync(lockPath)).toEqual(staleBytes);
    expect(
      readdirSync(directory).filter((name) => name.includes(".lock.successor.") && !name.includes(".owner."))
    ).toEqual([]);
  });

  it("recovers a successful Honcho write after primary-ledger publication fails without replaying it", async () => {
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Post-sink publication failure body.");
    const statePath = join(directory, MEMORY_SYNC_STATE_FILE);
    const lockPath = `${statePath}.lock`;
    const pendingPath = `${statePath}.pending`;
    const honchoClient = makeHoncho(true);
    const originalRemember = honchoClient.remember.bind(honchoClient);
    const remember = vi.spyOn(honchoClient, "remember").mockImplementationOnce(async (input) => {
      const result = await originalRemember(input);
      mkdirSync(statePath, { mode: 0o700 });
      return result;
    });

    const firstError = await syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(firstError).toBeInstanceOf(Error);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(pendingPath)).toBe(true);
    rmSync(statePath, { recursive: true });

    const recovered = await syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });

    expect(recovered.facts[0]?.l3.status).toBe("unchanged");
    expect(remember).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(pendingPath)).toBe(false);
    expect(readSyncState(directory).facts["sync-project-fact"]?.l3?.contentHash).toBe(
      recovered.facts[0]?.contentHash
    );
  });

  it("reconciles an accepted Honcho write after an ambiguous acknowledgement without another effect", async () => {
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Ambiguous Honcho acknowledgement body.");
    const statePath = join(directory, MEMORY_SYNC_STATE_FILE);
    const lockPath = `${statePath}.lock`;
    const honchoClient = makeHoncho(true);
    const originalRemember = honchoClient.remember.bind(honchoClient);
    let acceptedRaw = "";
    const remember = vi.spyOn(honchoClient, "remember").mockImplementationOnce(async (input) => {
      expect(readdirSync(directory).some((name) => name.includes(".l3-intent."))).toBe(true);
      acceptedRaw = input.context ? `${input.fact}\n\nContext: ${input.context}` : input.fact;
      await originalRemember(input);
      return { status: "failed", summary: "The acknowledgement was lost after acceptance." };
    });
    const recall = vi.spyOn(honchoClient, "recall").mockResolvedValueOnce({
      status: "failed",
      items: [],
      summary: "The acknowledgement reconciliation read was temporarily unavailable."
    });

    const ambiguous = await syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });
    const intentNames = readdirSync(directory).filter((name) => name.includes(".l3-intent."));
    expect(ambiguous.facts[0]?.l3.status).toBe("failed");
    expect(intentNames).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(false);
    expect(remember).toHaveBeenCalledTimes(1);

    const intentPath = join(directory, intentNames[0]!);
    const intentMarker = (JSON.parse(readFileSync(intentPath, "utf8")) as { marker: string }).marker;
    recall.mockResolvedValueOnce({
      status: "succeeded",
      items: [
        {
          id: "summary-only-query-echo",
          peer: "user",
          summary: `Lossy summary echoed ${intentMarker} without raw source content.`
        }
      ],
      summary: "Recall returned a summary-only match."
    });
    const summaryOnly = await syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });
    expect(summaryOnly.facts[0]?.l3.status).toBe("failed");
    expect(existsSync(intentPath)).toBe(true);
    expect(remember).toHaveBeenCalledTimes(1);

    recall.mockResolvedValueOnce({
      status: "succeeded",
      items: [{ id: "accepted-target-record", peer: "user", summary: "Accepted target record.", raw: acceptedRaw }],
      summary: "Recall returned the exact accepted target record."
    });
    const reconciled = await syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });
    const replay = await syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });

    expect(reconciled.facts[0]?.l3.status).toBe("deduplicated");
    expect(replay.facts[0]?.l3.status).toBe("unchanged");
    expect(remember).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(directory).filter((name) => name.includes(".l3-intent."))).toEqual([]);
  });

  it("does not reconcile an unrelated raw Honcho record that quotes the target marker", async () => {
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Quoted marker must not acknowledge this body.");
    const statePath = join(directory, MEMORY_SYNC_STATE_FILE);
    const honchoClient = makeHoncho(true);
    const remember = vi.spyOn(honchoClient, "remember").mockResolvedValueOnce({
      status: "failed",
      summary: "The target write failed without taking effect."
    });
    const recall = vi.spyOn(honchoClient, "recall").mockResolvedValueOnce({
      status: "failed",
      items: [],
      summary: "The first reconciliation read was unavailable."
    });

    const ambiguous = await syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });
    const intentNames = readdirSync(directory).filter((name) => name.includes(".l3-intent."));
    expect(ambiguous.facts[0]?.l3.status).toBe("failed");
    expect(intentNames).toHaveLength(1);

    const intentPath = join(directory, intentNames[0]!);
    const intentMarker = (JSON.parse(readFileSync(intentPath, "utf8")) as { marker: string }).marker;
    recall.mockResolvedValueOnce({
      status: "succeeded",
      items: [
        {
          id: "unrelated-marker-quote",
          peer: "user",
          summary: "An unrelated message quoted the target marker.",
          raw: `An unrelated message quoted ${intentMarker}; it is not the target memory fact.`
        }
      ],
      summary: "Recall returned only an unrelated marker quotation."
    });

    const unrelated = await syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });

    expect(unrelated.facts[0]?.l3.status).toBe("failed");
    expect(existsSync(intentPath)).toBe(true);
    expect(existsSync(statePath)).toBe(false);
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it("prunes a forgotten live name from the durable sync ledger", async () => {
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Fact that will be forgotten.");
    const honchoClient = makeHoncho(true);
    const remember = vi.spyOn(honchoClient, "remember");
    await syncUp(memory, { honchoClient, userApproved: true });

    const forgotten = memory.forget({ name: "sync-project-fact", reason: "test pruning" });
    expect(forgotten.status).toBe("forgotten");
    const report = await syncUp(memory, { honchoClient, userApproved: true });

    expect(report.facts).toEqual([]);
    expect(readSyncState(directory).facts["sync-project-fact"]).toBeUndefined();
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it("preserves malformed primary and orphan bytes while recovering completed Honcho progress", async () => {
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Malformed-ledger recovery body.");
    const statePath = join(directory, MEMORY_SYNC_STATE_FILE);
    const honchoClient = makeHoncho(true);
    const remember = vi.spyOn(honchoClient, "remember");
    const first = await syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });
    const completedCheckpoint = readFileSync(statePath);
    const completedState = MemorySyncStateSchema.parse(JSON.parse(completedCheckpoint.toString("utf8")));
    const malformedPrimary = Buffer.from(
      JSON.stringify({
        version: 1,
        facts: {
          "sync-project-fact": {
            l2: { contentHash: "bad" },
            l3: completedState.facts["sync-project-fact"]?.l3
          }
        }
      }),
      "utf8"
    );
    const malformedOrphan = Buffer.from("partial previous replacement", "utf8");
    writeFileSync(statePath, malformedPrimary);
    writeFileSync(`${statePath}.tmp`, malformedOrphan);

    const report = await syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    });

    expect(report.warnings.some((warning) => warning.toLowerCase().includes("malformed"))).toBe(true);
    expect(report.facts[0]?.contentHash).toBe(first.facts[0]?.contentHash);
    expect(report.facts[0]?.l3.status).toBe("unchanged");
    expect(remember).toHaveBeenCalledTimes(1);
    expect(MemorySyncReportSchema.safeParse(report).success).toBe(true);
    expect(MemorySyncStateSchema.safeParse(JSON.parse(readFileSync(statePath, "utf8"))).success).toBe(true);
    expect(readFileSync(`${statePath}.tmp`)).toEqual(malformedOrphan);
    const recoveryPaths = readdirSync(directory)
      .filter((name) => name.startsWith(`${MEMORY_SYNC_STATE_FILE}.recovery.`))
      .map((name) => join(directory, name));
    expect(recoveryPaths).toHaveLength(2);
    expect(recoveryPaths.map((path) => readFileSync(path))).toEqual(
      expect.arrayContaining([malformedPrimary, malformedOrphan])
    );
    expect(recoveryPaths.every((path) => report.warnings.some((warning) => warning.includes(path)))).toBe(true);
    expect(MemorySyncStateSchema.safeParse({ ...readSyncState(directory), unexpected: true }).success).toBe(false);
    expect(MemorySyncReportSchema.safeParse({ ...report, unexpected: true }).success).toBe(false);
  });

  it("recovers a valid orphan when it is the only completed sink checkpoint", async () => {
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Orphan-only recovery body.");
    const statePath = join(directory, MEMORY_SYNC_STATE_FILE);
    const honchoClient = makeHoncho(true);
    const remember = vi.spyOn(honchoClient, "remember");
    const first = await syncUp(memory, { honchoClient, userApproved: true });
    const completedCheckpoint = readFileSync(statePath);
    rmSync(statePath);
    writeFileSync(`${statePath}.tmp`, completedCheckpoint);

    const report = await syncUp(memory, { honchoClient, userApproved: true });

    expect(report.facts[0]?.contentHash).toBe(first.facts[0]?.contentHash);
    expect(report.facts[0]?.l3.status).toBe("unchanged");
    expect(remember).toHaveBeenCalledTimes(1);
    const recoveryPath = readdirSync(directory)
      .filter((name) => name.startsWith(`${MEMORY_SYNC_STATE_FILE}.recovery.orphan-temp.`))
      .map((name) => join(directory, name));
    expect(recoveryPath).toHaveLength(1);
    expect(readFileSync(recoveryPath[0]!)).toEqual(completedCheckpoint);
    expect(report.warnings.some((warning) => warning.includes(recoveryPath[0]!))).toBe(true);
    expect(readSyncState(directory).facts["sync-project-fact"]?.l3?.contentHash).toBe(first.facts[0]?.contentHash);
  });

  it("fails closed when equal-time primary and orphan checkpoints disagree", async () => {
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Primary checkpoint body.");
    const primaryHash = (await syncUp(memory, { now: () => new Date(FIXED_TIME) })).facts[0]?.contentHash;
    rememberProject(memory, "Orphan checkpoint body.");
    const orphanHash = (await syncUp(memory, { now: () => new Date(FIXED_TIME) })).facts[0]?.contentHash;
    expect(primaryHash).toBeDefined();
    expect(orphanHash).toBeDefined();
    expect(orphanHash).not.toBe(primaryHash);
    const statePath = join(directory, MEMORY_SYNC_STATE_FILE);
    const primaryBytes = Buffer.from(
      `${JSON.stringify({
        version: 1,
        facts: { "sync-project-fact": { l3: { contentHash: primaryHash, syncedAt: FIXED_TIME } } }
      })}\n`,
      "utf8"
    );
    const orphanBytes = Buffer.from(
      `${JSON.stringify({
        version: 1,
        facts: { "sync-project-fact": { l3: { contentHash: orphanHash, syncedAt: FIXED_TIME } } }
      })}\n`,
      "utf8"
    );
    writeFileSync(statePath, primaryBytes);
    writeFileSync(`${statePath}.tmp`, orphanBytes);
    const honchoClient = makeHoncho(true);
    const remember = vi.spyOn(honchoClient, "remember");

    const error = await syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    }).then(
      () => undefined,
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("equal syncedAt values but different content hashes");
    expect(readFileSync(statePath)).toEqual(primaryBytes);
    expect(readFileSync(`${statePath}.tmp`)).toEqual(orphanBytes);
    expect(remember).not.toHaveBeenCalled();
  });

  it("fails closed when equal-time primary and pending checkpoints disagree", async () => {
    const { memory, directory } = makeMemory();
    rememberProject(memory, "Primary accepted checkpoint body.");
    const primaryHash = (await syncUp(memory, { now: () => new Date(FIXED_TIME) })).facts[0]?.contentHash;
    rememberProject(memory, "Pending accepted checkpoint body.");
    const pendingHash = (await syncUp(memory, { now: () => new Date(FIXED_TIME) })).facts[0]?.contentHash;
    expect(primaryHash).toBeDefined();
    expect(pendingHash).toBeDefined();
    expect(pendingHash).not.toBe(primaryHash);
    const statePath = join(directory, MEMORY_SYNC_STATE_FILE);
    const primaryBytes = Buffer.from(
      `${JSON.stringify({
        version: 1,
        facts: { "sync-project-fact": { l3: { contentHash: primaryHash, syncedAt: FIXED_TIME } } }
      })}\n`,
      "utf8"
    );
    const pendingBytes = Buffer.from(
      `${JSON.stringify({
        version: 1,
        facts: { "sync-project-fact": { l3: { contentHash: pendingHash, syncedAt: FIXED_TIME } } }
      })}\n`,
      "utf8"
    );
    writeFileSync(statePath, primaryBytes);
    writeFileSync(`${statePath}.pending`, pendingBytes);
    const honchoClient = makeHoncho(true);
    const remember = vi.spyOn(honchoClient, "remember");

    const error = await syncUp(memory, {
      honchoClient,
      userApproved: true,
      now: () => new Date(FIXED_TIME)
    }).then(
      () => undefined,
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("equal syncedAt values but different content hashes");
    expect(readFileSync(statePath)).toEqual(primaryBytes);
    expect(readFileSync(`${statePath}.pending`)).toEqual(pendingBytes);
    expect(remember).not.toHaveBeenCalled();
  });
});
