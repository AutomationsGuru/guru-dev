import { describe, expect, it } from "vitest";

import { compose, type WorkflowStep } from '../../src/workflow/workflowComposeBind.js';

describe("compose", () => {
  it("returns the two step lists in order without mutating either input", () => {
    const first: readonly WorkflowStep[] = Object.freeze([{ id: "plan" }, { id: "build" }]);
    const second: readonly WorkflowStep[] = Object.freeze([{ id: "verify" }]);

    const composed = compose(first, second);

    expect(composed).toEqual([{ id: "plan" }, { id: "build" }, { id: "verify" }]);
    expect(composed).not.toBe(first);
    expect(composed).not.toBe(second);
    expect(first).toEqual([{ id: "plan" }, { id: "build" }]);
    expect(second).toEqual([{ id: "verify" }]);
  });

  it("rejects duplicate IDs without merging or overwriting either list", () => {
    const first: readonly WorkflowStep[] = [{ id: "plan" }, { id: "build" }];
    const second: readonly WorkflowStep[] = [{ id: "build" }, { id: "verify" }];

    expect(() => compose(first, second)).toThrow("Duplicate workflow step id: build");
    expect(first).toEqual([{ id: "plan" }, { id: "build" }]);
    expect(second).toEqual([{ id: "build" }, { id: "verify" }]);
  });

  it("rejects duplicate IDs already present in either input list", () => {
    expect(() => compose([{ id: "plan" }, { id: "plan" }], [])).toThrow("Duplicate workflow step id: plan");
    expect(() => compose([], [{ id: "verify" }, { id: "verify" }])).toThrow("Duplicate workflow step id: verify");
  });
});
