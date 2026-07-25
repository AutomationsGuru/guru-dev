import { describe, expect, it } from "vitest";

import { StepCheckpointSchema } from '../../src/workspace/stepCheckpoint.js';
import { StepCheckpointStore } from '../../src/workspace/stepCheckpointStore.js';

describe("StepCheckpointStore (IDEA-F62-CHECKPOINT-01)", () => {
  it("returns the most recent pre-mutation snapshots and removes only that restore point", () => {
    const store = new StepCheckpointStore();
    store.pushCheckpoint("step-1", [
      { path: "src/a.ts", content: "before a" },
      { path: "src/new.ts", content: null }
    ]);
    store.pushCheckpoint("step-2", [{ path: "src/b.ts", content: "before b" }]);

    expect(store.undoLast()).toEqual({
      checkpoint: { id: "step-2", snapshots: [{ path: "src/b.ts", content: "before b" }] },
      snapshots: [{ path: "src/b.ts", content: "before b" }]
    });
    expect(store.depth).toBe(1);
    expect(store.undoLast()).toEqual({
      checkpoint: {
        id: "step-1",
        snapshots: [
          { path: "src/a.ts", content: "before a" },
          { path: "src/new.ts", content: null }
        ]
      },
      snapshots: [
        { path: "src/a.ts", content: "before a" },
        { path: "src/new.ts", content: null }
      ]
    });
  });

  it("caps retained restore points by evicting the oldest checkpoint", () => {
    const store = new StepCheckpointStore({ maxDepth: 2 });
    store.pushCheckpoint("step-1", [{ path: "one.txt", content: "one" }]);
    store.pushCheckpoint("step-2", [{ path: "two.txt", content: "two" }]);
    store.pushCheckpoint("step-3", [{ path: "three.txt", content: "three" }]);

    expect(store.depth).toBe(2);
    expect(store.undoLast().checkpoint.id).toBe("step-3");
    expect(store.undoLast().checkpoint.id).toBe("step-2");
    expect(() => store.undoLast()).toThrow(/empty/i);
  });

  it("fails closed when no restore point exists", () => {
    const store = new StepCheckpointStore();

    expect(() => store.undoLast()).toThrow(/empty|restore point/i);
    expect(store.depth).toBe(0);
  });

  it("copies caller snapshots and restore output so later mutation cannot corrupt history", () => {
    const store = new StepCheckpointStore();
    const snapshots = [{ path: "src/a.ts", content: "before" }];
    store.pushCheckpoint("step-1", snapshots);
    snapshots[0]!.content = "mutated by caller";

    const restored = store.undoLast();
    (restored.snapshots[0] as { content: string | null }).content = "mutated restore result";

    expect(restored.checkpoint.snapshots[0]).toEqual({ path: "src/a.ts", content: "before" });
  });

  it("rejects invalid capacity and malformed checkpoints before changing the stack", () => {
    expect(() => new StepCheckpointStore({ maxDepth: 0 })).toThrow(/positive integer/i);
    expect(() => new StepCheckpointStore({ maxDepth: 1.5 })).toThrow(/positive integer/i);

    const store = new StepCheckpointStore();
    expect(() => store.pushCheckpoint("step-1", [{ path: "src/a.ts", content: "a" }, { path: "src/a.ts", content: "b" }])).toThrow(
      /duplicated/i
    );
    expect(store.depth).toBe(0);
    expect(() => StepCheckpointSchema.parse({ id: "step-1", snapshots: [] })).toThrow();
  });
});
