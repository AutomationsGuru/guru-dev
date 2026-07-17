import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DevCycleCheckpointSchema,
  createDevCycleCheckpointStore,
  type DevCycleCheckpoint
} from "../../src/selfbuild/devCycleCheckpoint.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "guruharness-dev-cycle-checkpoint-"));
  roots.push(root);
  return root;
}

function validCheckpoint(cwd: string, over: Partial<DevCycleCheckpoint> = {}): DevCycleCheckpoint {
  return {
    schemaVersion: 1,
    cycleId: "cycle-1",
    cwd: resolve(cwd),
    selectedTaskId: "task-1",
    stage: "select",
    stageState: "pending",
    completedStages: [],
    lastFailure: null,
    executorSessionId: null,
    budget: {
      attempts: 0,
      maxIterations: 6,
      tokens: 0,
      tokenBudget: 500_000,
      spentUsd: 0,
      ceilingUsd: 0,
      elapsedMs: 0,
      wallClockMs: 1_800_000
    },
    status: "running",
    verdict: null,
    learned: null,
    resumeReruns: [],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...over
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("dev-cycle checkpoint store (G102)", () => {
  it("rejects an unsafe ID and reports a missing checkpoint file", () => {
    const cwd = tempRoot();
    const store = createDevCycleCheckpointStore({ cwd });

    expect(() => store.load("../escape")).toThrow(/cycle id/i);
    expect(() => store.load("missing-cycle")).toThrow(/not found/i);
  });

  it("round-trips one strict valid checkpoint", () => {
    const cwd = tempRoot();
    const store = createDevCycleCheckpointStore({ cwd });
    const checkpoint = validCheckpoint(cwd);

    store.save(checkpoint);

    expect(store.load(checkpoint.cycleId)).toEqual(checkpoint);
    expect(() => DevCycleCheckpointSchema.parse({ ...checkpoint, unknown: true })).toThrow();
  });

  it("atomically replaces a checkpoint without leaving a temporary file", () => {
    const cwd = tempRoot();
    const store = createDevCycleCheckpointStore({ cwd });
    const first = validCheckpoint(cwd);
    const second = validCheckpoint(cwd, {
      stage: "build",
      completedStages: [{ stage: "select", verdict: "GREEN", evidence: "selected" }],
      updatedAt: "2026-07-15T00:01:00.000Z"
    });

    store.save(first);
    store.save(second);

    expect(store.load(first.cycleId)).toEqual(second);
    expect(readdirSync(store.directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("preserves corrupt and unknown-version files byte-for-byte", () => {
    const cwd = tempRoot();
    const store = createDevCycleCheckpointStore({ cwd });
    const corruptPath = store.path("corrupt-cycle");
    const unknownPath = store.path("future-cycle");
    const corrupt = "{ definitely-not-json\n";
    const future = JSON.stringify({ ...validCheckpoint(cwd, { cycleId: "future-cycle" }), schemaVersion: 99 });
    writeFileSync(corruptPath, corrupt, "utf8");
    writeFileSync(unknownPath, future, "utf8");

    expect(() => store.load("corrupt-cycle")).toThrow(/corrupt|invalid/i);
    expect(() => store.load("future-cycle")).toThrow(/version|invalid/i);
    expect(readFileSync(corruptPath, "utf8")).toBe(corrupt);
    expect(readFileSync(unknownPath, "utf8")).toBe(future);
  });

  it("rejects a canonical cwd mismatch without rewriting the checkpoint", () => {
    const cwd = tempRoot();
    const other = tempRoot();
    const store = createDevCycleCheckpointStore({ cwd });
    const path = store.path("wrong-cwd");
    const raw = `${JSON.stringify(validCheckpoint(other, { cycleId: "wrong-cwd" }), null, 2)}\n`;
    writeFileSync(path, raw, "utf8");

    expect(() => store.load("wrong-cwd")).toThrow(/cwd/i);
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("rejects impossible terminal and stage-state combinations", () => {
    const cwd = tempRoot();
    expect(() =>
      DevCycleCheckpointSchema.parse(
        validCheckpoint(cwd, { status: "done", stage: "ship", stageState: "running", verdict: "GREEN" })
      )
    ).toThrow(/terminal|stage/i);
    expect(() =>
      DevCycleCheckpointSchema.parse(validCheckpoint(cwd, { status: "running", stage: "done", stageState: "pending" }))
    ).toThrow(/terminal|stage/i);
  });

  it.each([
    {
      name: "skipped stage",
      checkpoint: (cwd: string) =>
        validCheckpoint(cwd, {
          stage: "smoke",
          completedStages: [
            { stage: "select", verdict: "GREEN", evidence: "selected" },
            { stage: "build", verdict: "GREEN", evidence: "built" }
          ]
        })
    },
    {
      name: "duplicated stage",
      checkpoint: (cwd: string) =>
        validCheckpoint(cwd, {
          stage: "build",
          completedStages: [
            { stage: "select", verdict: "GREEN", evidence: "selected" },
            { stage: "select", verdict: "GREEN", evidence: "selected twice" }
          ]
        })
    },
    {
      name: "reordered stage",
      checkpoint: (cwd: string) =>
        validCheckpoint(cwd, {
          stage: "test",
          completedStages: [
            { stage: "build", verdict: "GREEN", evidence: "built first" },
            { stage: "select", verdict: "GREEN", evidence: "selected later" }
          ]
        })
    },
    {
      name: "forged terminal history",
      checkpoint: (cwd: string) =>
        validCheckpoint(cwd, {
          stage: "done",
          stageState: "completed",
          status: "done",
          verdict: "GREEN",
          completedStages: [{ stage: "learn", verdict: "GREEN", evidence: "forged terminal" }]
        })
    },
    {
      name: "forged terminal verdict",
      checkpoint: (cwd: string) =>
        validCheckpoint(cwd, {
          stage: "done",
          stageState: "completed",
          status: "done",
          verdict: "GREEN",
          completedStages: [{ stage: "select", verdict: "RED", evidence: "no ready task" }]
        })
    }
  ])("rejects a $name checkpoint history", ({ checkpoint }) => {
    expect(() => DevCycleCheckpointSchema.parse(checkpoint(tempRoot()))).toThrow(/history|stage|boundary|terminal/i);
  });

  it("rejects a checkpoint directory symlink or junction that escapes the project", () => {
    const cwd = tempRoot();
    const outside = tempRoot();
    mkdirSync(join(cwd, ".guru"));
    symlinkSync(outside, join(cwd, ".guru", "dev-cycles"), process.platform === "win32" ? "junction" : "dir");
    const store = createDevCycleCheckpointStore({ cwd });

    expect(() => store.save(validCheckpoint(cwd))).toThrow(/symlink|junction|reparse|boundary/i);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("rejects symlinked checkpoint files before load and atomic replacement", () => {
    const cwd = tempRoot();
    const outside = tempRoot();
    const store = createDevCycleCheckpointStore({ cwd, randomId: () => "fixed-temp" });
    const checkpoint = validCheckpoint(cwd);
    const filePath = store.path(checkpoint.cycleId);
    const outsidePath = join(outside, "outside.json");
    const outsideBytes = `${JSON.stringify(checkpoint)}\n`;
    writeFileSync(outsidePath, outsideBytes, "utf8");
    symlinkSync(outsidePath, filePath, "file");

    expect(() => store.load(checkpoint.cycleId)).toThrow(/symlink|reparse|boundary/i);
    expect(() => store.save(checkpoint)).toThrow(/symlink|reparse|boundary/i);
    expect(readFileSync(outsidePath, "utf8")).toBe(outsideBytes);
  });

  it("never serializes injected functions, environment objects, or secret-looking sentinels", () => {
    const cwd = tempRoot();
    const store = createDevCycleCheckpointStore({ cwd });
    const withRuntimeObjects = {
      ...validCheckpoint(cwd),
      injectedDependency: () => undefined,
      env: { G102_SECRET: "do-not-persist" }
    } as unknown as DevCycleCheckpoint;
    const withSecretEvidence = validCheckpoint(cwd, {
      stage: "build",
      completedStages: [{ stage: "select", verdict: "GREEN", evidence: "api_key=G102_SECRET_SENTINEL_123456789" }]
    });

    expect(() => store.save(withRuntimeObjects)).toThrow(/invalid|checkpoint/i);
    expect(() => store.save(withSecretEvidence)).toThrow(/secret|sensitive/i);
    expect(existsSync(store.directory) ? readdirSync(store.directory) : []).toEqual([]);
  });
});
