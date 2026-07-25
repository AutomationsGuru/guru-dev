import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createScoutReportStore, ScoutReportSchema, type ScoutReport } from '../../src/swarm/scoutReport.js';

function validReport(overrides: Partial<ScoutReport> = {}): ScoutReport {
  return {
    taskId: "abc12345",
    objective: "Map the auth module's public surface",
    evidenceRefs: ["src/auth/index.ts", "src/auth/session.ts"],
    risks: ["token refresh path is untested"],
    recommendedNext: "Ship a focused test over the refresh seam",
    ...overrides
  };
}

describe("ScoutReportSchema — required durable sections", () => {
  it("requires objective, evidence refs, risks, and a recommended next move", () => {
    expect(ScoutReportSchema.parse(validReport()).objective).toBeTruthy();
    expect(() => ScoutReportSchema.parse(validReport({ objective: "" }))).toThrow();
    expect(() => ScoutReportSchema.parse(validReport({ recommendedNext: "" }))).toThrow();
    expect(() => ScoutReportSchema.parse(validReport({ evidenceRefs: "not-an-array" as never }))).toThrow();
  });
});

describe("scoutReport store — durable artifact, fail-closed validation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scout-report-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("save persists a report and returns a durable path; read round-trips it", () => {
    const store = createScoutReportStore({ directory: dir });
    const path = store.save(validReport());
    expect(path).toBe(join(dir, "abc12345.json"));
    const back = store.read("abc12345");
    expect(back?.objective).toContain("auth module");
    expect(back?.risks).toHaveLength(1);
    expect(store.hasValidReport("abc12345")).toBe(true);
  });

  it("a missing report fails closed (hasValidReport false, read undefined)", () => {
    const store = createScoutReportStore({ directory: dir });
    expect(store.hasValidReport("nope0000")).toBe(false);
    expect(store.read("nope0000")).toBeUndefined();
  });

  it("a malformed/truncated artifact never satisfies completion (fail closed)", () => {
    const store = createScoutReportStore({ directory: dir });
    const path = store.reportPath("bad00000");
    writeFileSync(path, "{ not json", "utf8");
    expect(store.hasValidReport("bad00000")).toBe(false);
    // Schema-invalid but parseable JSON also fails closed.
    writeFileSync(path, JSON.stringify({ taskId: "bad00000", objective: "x" }), "utf8");
    expect(store.hasValidReport("bad00000")).toBe(false);
  });

  it("save rejects a schema-invalid report instead of writing a partial artifact", () => {
    const store = createScoutReportStore({ directory: dir });
    expect(() => store.save(validReport({ recommendedNext: "" }))).toThrow();
    expect(store.hasValidReport("abc12345")).toBe(false);
  });

  it("sessionId scopes reports under a per-session subdirectory", () => {
    const store = createScoutReportStore({ directory: dir, sessionId: "sess-1" });
    expect(store.directory).toBe(join(dir, "sess-1"));
    const path = store.save(validReport({ taskId: "t1" }));
    expect(path).toBe(join(dir, "sess-1", "t1.json"));
    // A different session does not see it.
    const other = createScoutReportStore({ directory: dir, sessionId: "sess-2" });
    expect(other.hasValidReport("t1")).toBe(false);
  });

  it("unsafe task ids are sanitized into a safe on-disk name", () => {
    const store = createScoutReportStore({ directory: dir });
    const path = store.save(validReport({ taskId: "../evil/../../etc" }));
    expect(path.startsWith(dir)).toBe(true);
    expect(path).not.toContain("..");
  });
});
