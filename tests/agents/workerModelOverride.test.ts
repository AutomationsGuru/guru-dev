import { describe, expect, it } from "vitest";

import { resolveWorkerModel, type WorkerModelOverride } from '../../src/agents/workerModelOverride.js';

describe("workerModelOverride — resolveWorkerModel (F276)", () => {
  it("override wins when it is a non-empty string", () => {
    expect(resolveWorkerModel("parent-model", "child-model")).toBe("child-model");
  });

  it("returns the override's own model id, distinct from the parent route's", () => {
    expect(resolveWorkerModel("claude-opus-4-8", "deepseek-v4")).toBe("deepseek-v4");
  });

  it("trims the override before applying it", () => {
    expect(resolveWorkerModel("parent-model", "  child-model  ")).toBe("child-model");
  });

  it("falls back to the parent route when the override is undefined", () => {
    expect(resolveWorkerModel("parent-model", undefined)).toBe("parent-model");
  });

  it("falls back to the parent route when the override is empty or whitespace", () => {
    expect(resolveWorkerModel("parent-model", "")).toBe("parent-model");
    expect(resolveWorkerModel("parent-model", "   ")).toBe("parent-model");
  });

  it("accepts a worker def object carrying an optional modelOverride", () => {
    const def: WorkerModelOverride = { modelOverride: "child-model" };
    expect(resolveWorkerModel("parent-model", def)).toBe("child-model");
  });

  it("falls back when the def object carries an empty modelOverride", () => {
    const def: WorkerModelOverride = { modelOverride: "  " };
    expect(resolveWorkerModel("parent-model", def)).toBe("parent-model");
  });

  it("falls back when the def object has no modelOverride field", () => {
    expect(resolveWorkerModel("parent-model", {})).toBe("parent-model");
  });
});
