import { describe, expect, it } from "vitest";

import { resolveWorkerModel, type WorkerDef } from '../../src/swarm/subagentModelOverride.js';

describe("resolveWorkerModel", () => {
  it("prefers a worker definition model override", () => {
    const definition: WorkerDef = { modelId: "worker-model" };

    expect(resolveWorkerModel("parent-model", definition)).toBe("worker-model");
  });

  it("inherits the parent model when the worker definition has no override", () => {
    const definition: WorkerDef = {};

    expect(resolveWorkerModel("parent-model", definition)).toBe("parent-model");
  });

  it("inherits the parent model when the override is empty", () => {
    expect(resolveWorkerModel("parent-model", { modelId: "" })).toBe("parent-model");
  });

  it("trims a model override before resolving it", () => {
    expect(resolveWorkerModel("parent-model", { modelId: "  worker-model  " })).toBe("worker-model");
  });
});
