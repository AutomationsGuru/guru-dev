import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FLEET_LEDGER_SCHEMA_VERSION,
  FleetEventSchema,
  createFleetLedger,
  resolveFleetLedgerDirectory,
  type FleetLedger
} from '../../src/swarm/fleetLedger.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fleet-ledger-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ledgerIn = (dir: string): FleetLedger => createFleetLedger({ directory: dir });

describe("resolveFleetLedgerDirectory", () => {
  it("roots the ledger under the project's .guru/fleet dir", () => {
    expect(resolveFleetLedgerDirectory({ repoRoot: "/repo" })).toBe(join("/repo", ".guru", "fleet"));
  });

  it("honors an explicit directory override (tests)", () => {
    expect(resolveFleetLedgerDirectory({ directory: "/x" })).toBe("/x");
  });
});

describe("fleet ledger — append-only JSONL", () => {
  it("creates the directory lazily and appends one JSON object per line", () => {
    const dir = join(root, ".guru", "fleet");
    const ledger = ledgerIn(dir);
    ledger.append({ kind: "run_started", runId: "r1", detail: "boot" });
    ledger.append({ kind: "worker_spawned", runId: "r1", workerId: "w1", role: "scout" });
    const file = join(dir, "fleet.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = FleetEventSchema.safeParse(JSON.parse(line));
      expect(parsed.success).toBe(true);
    }
  });

  it("stamps schemaVersion, a monotonically increasing seq, and a timestamp", () => {
    const ledger = ledgerIn(root);
    const a = ledger.append({ kind: "run_started", runId: "r1" });
    const b = ledger.append({ kind: "run_started", runId: "r1" });
    expect(a.schemaVersion).toBe(FLEET_LEDGER_SCHEMA_VERSION);
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(typeof a.ts).toBe("string");
    expect(a.ts.length).toBeGreaterThan(0);
  });

  it("continues seq across ledger instances (restart durability)", () => {
    const first = ledgerIn(root);
    const a = first.append({ kind: "run_started", runId: "r1" });
    const second = ledgerIn(root); // a "new process" over the same dir
    const b = second.append({ kind: "run_started", runId: "r1" });
    expect(b.seq).toBeGreaterThan(a.seq);
  });

  it("survives many sequential appends without losing events (durability)", () => {
    const ledger = ledgerIn(root);
    const N = 200;
    for (let index = 0; index < N; index += 1) {
      ledger.append({ kind: "heartbeat", runId: "r1", workerId: "w1", tick: index });
    }
    const events = ledger.readAll();
    expect(events).toHaveLength(N);
    // seq is strictly increasing — nothing was dropped or reordered.
    for (let index = 1; index < N; index += 1) {
      expect(events[index]!.seq).toBeGreaterThan(events[index - 1]!.seq);
    }
  });

  it("never rewrites prior lines when appending (append-only)", () => {
    const ledger = ledgerIn(root);
    ledger.append({ kind: "run_started", runId: "r1", detail: "first" });
    const file = join(root, "fleet.jsonl");
    const before = readFileSync(file, "utf8");
    ledger.append({ kind: "run_started", runId: "r1", detail: "second" });
    const after = readFileSync(file, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });
});

describe("fleet ledger — secret redaction at the disk boundary", () => {
  it("scrubs a token-shaped string out of any detail field before it lands on disk", () => {
    const ledger = ledgerIn(root);
    ledger.append({ kind: "run_started", runId: "r1", detail: "key is sk-ABCDEFGHIJKLMNOPQRSTUVWX" });
    const raw = readFileSync(join(root, "fleet.jsonl"), "utf8");
    expect(raw).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(raw).toContain("[redacted");
  });

  it("scrubs secret-word assignments (password=...) before persisting", () => {
    const ledger = ledgerIn(root);
    ledger.append({ kind: "note", runId: "r1", detail: "connect with password=hunter2please" });
    const raw = readFileSync(join(root, "fleet.jsonl"), "utf8");
    expect(raw).not.toContain("hunter2please");
  });
});

describe("fleet ledger — replay robustness", () => {
  it("skips a torn trailing line from a crash mid-append and replays the valid prefix", () => {
    const ledger = ledgerIn(root);
    ledger.append({ kind: "run_started", runId: "r1", detail: "good1" });
    ledger.append({ kind: "run_started", runId: "r1", detail: "good2" });
    // Simulate a crash mid-write: a partial JSON line with no newline.
    writeFileSync(join(root, "fleet.jsonl"), readFileSync(join(root, "fleet.jsonl"), "utf8") + '{"kind":"run_started","runId":"r1","detai');
    const events = ledger.readAll();
    expect(events).toHaveLength(2);
    expect(events.map((event) => (event as { detail?: string }).detail)).toEqual(["good1", "good2"]);
  });

  it("returns an empty list when the ledger does not exist yet", () => {
    expect(ledgerIn(join(root, "nope")).readAll()).toEqual([]);
  });
});

describe("fleet ledger — worker records", () => {
  it("records worker lifecycle with role, status, heartbeat, artifact refs, failure_class", () => {
    const ledger = ledgerIn(root);
    ledger.append({ kind: "worker_spawned", runId: "r1", workerId: "w1", role: "builder" });
    ledger.append({ kind: "heartbeat", runId: "r1", workerId: "w1" });
    ledger.append({ kind: "artifact", runId: "r1", workerId: "w1", artifactRef: "diff://w1/1" });
    ledger.append({ kind: "worker_finished", runId: "r1", workerId: "w1", status: "done" });
    const workers = ledger.workers("r1");
    expect(workers).toHaveLength(1);
    const w = workers[0]!;
    expect(w.workerId).toBe("w1");
    expect(w.role).toBe("builder");
    expect(w.status).toBe("done");
    expect(w.heartbeats).toBe(1);
    expect(w.artifactRefs).toContain("diff://w1/1");
    expect(w.failureClass).toBeUndefined();
  });

  it("captures failure_class on a failed worker", () => {
    const ledger = ledgerIn(root);
    ledger.append({ kind: "worker_spawned", runId: "r1", workerId: "w2", role: "scout" });
    ledger.append({ kind: "worker_finished", runId: "r1", workerId: "w2", status: "failed", failureClass: "transient" });
    const w = ledger.workers("r1")[0]!;
    expect(w.status).toBe("failed");
    expect(w.failureClass).toBe("transient");
  });

  it("isolates worker records per run", () => {
    const ledger = ledgerIn(root);
    ledger.append({ kind: "worker_spawned", runId: "r1", workerId: "w1", role: "a" });
    ledger.append({ kind: "worker_spawned", runId: "r2", workerId: "w2", role: "b" });
    expect(ledger.workers("r1").map((worker) => worker.workerId)).toEqual(["w1"]);
    expect(ledger.workers("r2").map((worker) => worker.workerId)).toEqual(["w2"]);
  });
});

describe("fleet ledger — one file per directory", () => {
  it("writes exactly one jsonl file in the ledger dir", () => {
    const ledger = ledgerIn(root);
    ledger.append({ kind: "run_started", runId: "r1" });
    ledger.append({ kind: "run_started", runId: "r2" });
    expect(readdirSync(root)).toEqual(["fleet.jsonl"]);
  });
});
