/**
 * IDEA-F350-TOP-01 · R-AB-TOP — focused tests for box resource metrics snapshot.
 *
 * RED→GREEN contract: out-of-range readings are clamped to [0, 100]; non-finite
 * values collapse to 0 (never unbounded); max rollup takes the peak per axis.
 */

import { describe, expect, it } from "vitest";

import {
  BoxResourceMetricsSnapshotSchema,
  MAX_PERCENT,
  MIN_PERCENT,
  clampPercent,
  makeMetric,
  makeSnapshot,
  maxSnapshot
} from '../../src/sandbox/boxResourceMetrics.js';

describe("clampPercent", () => {
  it("passes through in-range values", () => {
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(42)).toBe(42);
    expect(clampPercent(100)).toBe(100);
  });

  it("clamps out-of-range values to the [0, 100] edge", () => {
    expect(clampPercent(-1)).toBe(MIN_PERCENT);
    expect(clampPercent(-9999)).toBe(MIN_PERCENT);
    expect(clampPercent(101)).toBe(MAX_PERCENT);
    expect(clampPercent(99999)).toBe(MAX_PERCENT);
  });

  it("collapses non-finite values to 0 so budget math can never go unbounded", () => {
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampPercent(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe("makeMetric / makeSnapshot clamp untrusted input", () => {
  it("clamps each axis of a snapshot", () => {
    const snap = makeSnapshot({
      boxId: "box-1",
      takenMs: 1_000,
      cpuPercent: 150,
      memPercent: -5,
      diskPercent: 73
    });
    expect(snap.cpuPercent).toBe(100);
    expect(snap.memPercent).toBe(0);
    expect(snap.diskPercent).toBe(73);
  });

  it("clamps a raw metric value", () => {
    expect(makeMetric("cpu", 250)).toEqual({ kind: "cpu", percent: 100 });
    expect(makeMetric("mem", Number.NaN)).toEqual({ kind: "mem", percent: 0 });
  });
});

describe("BoxResourceMetricsSnapshotSchema", () => {
  it("rejects an out-of-range percent at the schema boundary", () => {
    const bad = () =>
      BoxResourceMetricsSnapshotSchema.parse({
        boxId: "box-1",
        takenMs: 1_000,
        cpuPercent: 150,
        memPercent: 50,
        diskPercent: 50
      });
    expect(bad).toThrow();
  });

  it("parses a valid snapshot with optional limits", () => {
    const parsed = BoxResourceMetricsSnapshotSchema.parse({
      boxId: "box-1",
      takenMs: 1_000,
      cpuPercent: 10,
      memPercent: 20,
      diskPercent: 30,
      limitMb: 2048,
      limitDiskMb: 10240
    });
    expect(parsed.limitMb).toBe(2048);
    expect(parsed.limitDiskMb).toBe(10240);
  });
});

describe("maxSnapshot", () => {
  const a = makeSnapshot({
    boxId: "box-1",
    takenMs: 1_000,
    cpuPercent: 10,
    memPercent: 90,
    diskPercent: 5,
    limitMb: 2048,
    limitDiskMb: 10240
  });
  const b = makeSnapshot({
    boxId: "box-1",
    takenMs: 2_000,
    cpuPercent: 80,
    memPercent: 20,
    diskPercent: 60,
    limitMb: 4096,
    limitDiskMb: 5120
  });

  it("takes the per-axis peak and the later timestamp", () => {
    const peak = maxSnapshot(a, b);
    expect(peak.cpuPercent).toBe(80);
    expect(peak.memPercent).toBe(90);
    expect(peak.diskPercent).toBe(60);
    expect(peak.takenMs).toBe(2_000);
  });

  it("preserves the tighter (minimum) configured limit across rollups", () => {
    const peak = maxSnapshot(a, b);
    expect(peak.limitMb).toBe(2048);
    expect(peak.limitDiskMb).toBe(5120);
  });

  it("keeps a limit when only one side defines it", () => {
    const noLimit = makeSnapshot({
      boxId: "box-1",
      takenMs: 3_000,
      cpuPercent: 1,
      memPercent: 1,
      diskPercent: 1
    });
    const peak = maxSnapshot(a, noLimit);
    expect(peak.limitMb).toBe(2048);
    expect(peak.limitDiskMb).toBe(10240);
  });
});
