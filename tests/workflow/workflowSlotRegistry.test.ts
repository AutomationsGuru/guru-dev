import { describe, expect, it } from "vitest";

import { createWorkflowSlotRegistry, type WorkflowStepHandler } from '../../src/workflow/workflowSlotRegistry.js';

describe("createWorkflowSlotRegistry", () => {
  it("returns null for a missing slot", () => {
    const registry = createWorkflowSlotRegistry();
    expect(registry.get("nonexistent")).toBeNull();
  });

  it("registers and retrieves a handler by id", () => {
    const registry = createWorkflowSlotRegistry();
    const handler: WorkflowStepHandler = () => {};
    registry.register("build", handler);
    expect(registry.get("build")).toBe(handler);
  });

  it("overwrites a handler when re-registering the same id", () => {
    const registry = createWorkflowSlotRegistry();
    const first: WorkflowStepHandler = () => {};
    const second: WorkflowStepHandler = () => {};
    registry.register("deploy", first);
    registry.register("deploy", second);
    expect(registry.get("deploy")).toBe(second);
  });

  it("is empty and has size 0 when freshly created", () => {
    const registry = createWorkflowSlotRegistry();
    expect(registry.isEmpty()).toBe(true);
    expect(registry.size()).toBe(0);
    expect(registry.ids()).toEqual([]);
  });

  it("tracks size and ids after registration", () => {
    const registry = createWorkflowSlotRegistry();
    registry.register("lint", () => {});
    registry.register("test", () => {});
    expect(registry.isEmpty()).toBe(false);
    expect(registry.size()).toBe(2);
    expect(registry.ids()).toEqual(["lint", "test"]);
  });

  it("removes a slot and returns null afterward", () => {
    const registry = createWorkflowSlotRegistry();
    const handler: WorkflowStepHandler = () => {};
    registry.register("cleanup", handler);
    expect(registry.get("cleanup")).toBe(handler);
    registry.remove("cleanup");
    expect(registry.get("cleanup")).toBeNull();
    expect(registry.isEmpty()).toBe(true);
  });

  it("remove is a no-op for a missing slot", () => {
    const registry = createWorkflowSlotRegistry();
    expect(() => registry.remove("nonexistent")).not.toThrow();
    expect(registry.isEmpty()).toBe(true);
    expect(registry.size()).toBe(0);
  });

  it("returns independent registries (no shared state)", () => {
    const a = createWorkflowSlotRegistry();
    const b = createWorkflowSlotRegistry();
    a.register("only-in-a", () => {});
    expect(a.get("only-in-a")).not.toBeNull();
    expect(b.get("only-in-a")).toBeNull();
  });
});
