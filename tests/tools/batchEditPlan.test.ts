import { describe, expect, it } from "vitest";

import {
  type BatchEditPatch,
  validateBatchEditPlan
} from '../../src/tools/batchEditPlan.js';

describe("validateBatchEditPlan", () => {
  it("returns valid for a single well-formed patch", () => {
    const patches: BatchEditPatch[] = [
      { path: "src/foo.ts", old: "hello", new: "world" }
    ];

    const result = validateBatchEditPlan(patches);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.patches).toEqual(patches);
  });

  it("returns valid for multiple non-overlapping paths", () => {
    const patches: BatchEditPatch[] = [
      { path: "src/foo.ts", old: "hello", new: "world" },
      { path: "src/bar.ts", old: "old code", new: "new code" },
      { path: "src/baz.ts", old: "x", new: "y" }
    ];

    const result = validateBatchEditPlan(patches);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.patches).toEqual(patches);
  });

  it("rejects overlapping same-path patches", () => {
    const patches: BatchEditPatch[] = [
      { path: "src/foo.ts", old: "hello", new: "world" },
      { path: "src/foo.ts", old: "other", new: "replacement" }
    ];

    const result = validateBatchEditPlan(patches);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("src/foo.ts");
    expect(result.errors[0]).toMatch(/overlap/i);
  });

  it("rejects multiple overlapping paths (more than two)", () => {
    const patches: BatchEditPatch[] = [
      { path: "a.ts", old: "a1", new: "b1" },
      { path: "a.ts", old: "a2", new: "b2" },
      { path: "a.ts", old: "a3", new: "b3" }
    ];

    const result = validateBatchEditPlan(patches);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects empty patch list", () => {
    const result = validateBatchEditPlan([]);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("empty");
  });

  it("rejects patch with empty path", () => {
    const patches: BatchEditPatch[] = [
      { path: "", old: "hello", new: "world" }
    ];

    const result = validateBatchEditPlan(patches);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("path");
  });

  it("rejects patch with empty old text", () => {
    const patches: BatchEditPatch[] = [
      { path: "src/foo.ts", old: "", new: "world" }
    ];

    const result = validateBatchEditPlan(patches);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("old");
  });

  it("rejects patch with whitespace-only path", () => {
    const patches: BatchEditPatch[] = [
      { path: "   ", old: "hello", new: "world" }
    ];

    const result = validateBatchEditPlan(patches);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects patch with whitespace-only old text", () => {
    const patches: BatchEditPatch[] = [
      { path: "src/foo.ts", old: "   ", new: "world" }
    ];

    const result = validateBatchEditPlan(patches);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("collects multiple validation errors", () => {
    const patches: BatchEditPatch[] = [
      { path: "", old: "hello", new: "a" },
      { path: "src/a.ts", old: "", new: "b" },
      { path: "src/x.ts", old: "x1", new: "y1" },
      { path: "src/x.ts", old: "x2", new: "y2" }
    ];

    const result = validateBatchEditPlan(patches);

    expect(result.valid).toBe(false);
    // should have: empty-path, empty-old, and overlap errors
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});