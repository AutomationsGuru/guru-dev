import { describe, expect, it } from "vitest";

import {
  BoxLifecycleError,
  BoxRecordSchema,
  type BoxRegistry,
  createBox,
  createRegistry,
  destroyBox,
  getBox,
  listBoxes,
  startBox,
  stopBox,
} from '../../src/sandbox/boxLifecycle.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function registryWith(
  id: string,
  status: "created" | "running" | "stopped",
): BoxRegistry {
  const r = createRegistry();
  r.set(id, { id, status });
  return r;
}

// ── create ───────────────────────────────────────────────────────────────────

describe("createBox", () => {
  it("creates a box in 'created' status", () => {
    const reg = createRegistry();
    const box = createBox(reg, "b1");

    expect(box.id).toBe("b1");
    expect(box.status).toBe("created");
    expect(BoxRecordSchema.parse(box)).toEqual(box);
    expect(getBox(reg, "b1")).toEqual(box);
  });

  it("rejects duplicate id", () => {
    const reg = createRegistry();
    createBox(reg, "b1");

    expect(() => createBox(reg, "b1")).toThrow(BoxLifecycleError);
    try {
      createBox(reg, "b1");
    } catch (e) {
      expect(e).toBeInstanceOf(BoxLifecycleError);
      expect((e as BoxLifecycleError).boxId).toBe("b1");
      expect((e as BoxLifecycleError).attempted).toBe("create");
    }
  });
});

// ── start ────────────────────────────────────────────────────────────────────

describe("startBox", () => {
  it("transitions created → running", () => {
    const reg = registryWith("b1", "created");
    const box = startBox(reg, "b1");

    expect(box.status).toBe("running");
    expect(getBox(reg, "b1")!.status).toBe("running");
  });

  it("transitions stopped → running (restart)", () => {
    const reg = registryWith("b1", "stopped");
    const box = startBox(reg, "b1");

    expect(box.status).toBe("running");
  });

  it("rejects start on a non-existent box", () => {
    const reg = createRegistry();
    expect(() => startBox(reg, "b1")).toThrow(BoxLifecycleError);
  });

  it("rejects start on already running box", () => {
    const reg = registryWith("b1", "running");
    expect(() => startBox(reg, "b1")).toThrow(BoxLifecycleError);
  });

  it("rejects start on destroyed box", () => {
    const reg = createRegistry();
    reg.set("b1", { id: "b1", status: "destroyed" });
    expect(() => startBox(reg, "b1")).toThrow(BoxLifecycleError);
  });
});

// ── stop ─────────────────────────────────────────────────────────────────────

describe("stopBox", () => {
  it("transitions running → stopped", () => {
    const reg = registryWith("b1", "running");
    const box = stopBox(reg, "b1");

    expect(box.status).toBe("stopped");
    expect(getBox(reg, "b1")!.status).toBe("stopped");
  });

  it("rejects stop on a non-existent box", () => {
    const reg = createRegistry();
    expect(() => stopBox(reg, "b1")).toThrow(BoxLifecycleError);
  });

  it("rejects stop on created box (not yet started)", () => {
    const reg = registryWith("b1", "created");
    expect(() => stopBox(reg, "b1")).toThrow(BoxLifecycleError);
  });

  it("rejects stop on already stopped box", () => {
    const reg = registryWith("b1", "stopped");
    expect(() => stopBox(reg, "b1")).toThrow(BoxLifecycleError);
  });

  it("rejects stop on destroyed box", () => {
    const reg = createRegistry();
    reg.set("b1", { id: "b1", status: "destroyed" });
    expect(() => stopBox(reg, "b1")).toThrow(BoxLifecycleError);
  });
});

// ── destroy ──────────────────────────────────────────────────────────────────

describe("destroyBox", () => {
  it("transitions created → destroyed", () => {
    const reg = registryWith("b1", "created");
    const box = destroyBox(reg, "b1");

    expect(box.status).toBe("destroyed");
    expect(getBox(reg, "b1")!.status).toBe("destroyed");
  });

  it("transitions running → destroyed", () => {
    const reg = registryWith("b1", "running");
    const box = destroyBox(reg, "b1");

    expect(box.status).toBe("destroyed");
  });

  it("transitions stopped → destroyed", () => {
    const reg = registryWith("b1", "stopped");
    const box = destroyBox(reg, "b1");

    expect(box.status).toBe("destroyed");
  });

  it("rejects destroy on already destroyed box", () => {
    const reg = createRegistry();
    reg.set("b1", { id: "b1", status: "destroyed" });
    expect(() => destroyBox(reg, "b1")).toThrow(BoxLifecycleError);
  });

  it("rejects destroy on non-existent box", () => {
    const reg = createRegistry();
    expect(() => destroyBox(reg, "b1")).toThrow(BoxLifecycleError);
  });
});

// ── lifecycle sequence ───────────────────────────────────────────────────────

describe("lifecycle sequence", () => {
  it("full create → start → stop → start → stop → destroy", () => {
    const reg = createRegistry();

    const b1 = createBox(reg, "box-1");
    expect(b1.status).toBe("created");

    const b2 = startBox(reg, "box-1");
    expect(b2.status).toBe("running");

    const b3 = stopBox(reg, "box-1");
    expect(b3.status).toBe("stopped");

    const b4 = startBox(reg, "box-1");
    expect(b4.status).toBe("running");

    const b5 = stopBox(reg, "box-1");
    expect(b5.status).toBe("stopped");

    const b6 = destroyBox(reg, "box-1");
    expect(b6.status).toBe("destroyed");

    // terminal — further operations rejected
    expect(() => startBox(reg, "box-1")).toThrow(BoxLifecycleError);
    expect(() => stopBox(reg, "box-1")).toThrow(BoxLifecycleError);
    expect(() => destroyBox(reg, "box-1")).toThrow(BoxLifecycleError);
  });

  it("fast path: create → destroy (skip run)", () => {
    const reg = createRegistry();
    createBox(reg, "box-1");
    const b = destroyBox(reg, "box-1");
    expect(b.status).toBe("destroyed");
  });
});

// ── registry ─────────────────────────────────────────────────────────────────

describe("registry", () => {
  it("listBoxes returns all boxes", () => {
    const reg = createRegistry();
    createBox(reg, "a");
    createBox(reg, "b");
    createBox(reg, "c");

    const all = listBoxes(reg);
    expect(all).toHaveLength(3);
    expect(all.map((b) => b.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("getBox returns undefined for missing box", () => {
    const reg = createRegistry();
    expect(getBox(reg, "nope")).toBeUndefined();
  });

  it("createRegistry returns an empty registry", () => {
    const reg = createRegistry();
    expect(listBoxes(reg)).toEqual([]);
    expect(reg).toBeInstanceOf(Map);
  });
});

// ── schema validation ────────────────────────────────────────────────────────

describe("BoxRecordSchema", () => {
  it("rejects objects missing id", () => {
    expect(() => BoxRecordSchema.parse({ status: "created" })).toThrow();
  });

  it("rejects objects with invalid status", () => {
    expect(() => BoxRecordSchema.parse({ id: "b1", status: "paused" })).toThrow();
  });

  it("rejects objects with extra fields", () => {
    expect(() =>
      BoxRecordSchema.parse({ id: "b1", status: "created", extra: true }),
    ).toThrow();
  });

  it("accepts valid minimal record", () => {
    const r = BoxRecordSchema.parse({ id: "b1", status: "created" });
    expect(r).toEqual({ id: "b1", status: "created" });
  });
});

// ── error shape ──────────────────────────────────────────────────────────────

describe("BoxLifecycleError", () => {
  it("carries structured fields for callers", () => {
    const err = new BoxLifecycleError("b1", "running", "destroy", "still running, stop first");
    expect(err.boxId).toBe("b1");
    expect(err.from).toBe("running");
    expect(err.attempted).toBe("destroy");
    expect(err.message).toContain("cannot destroy");
    expect(err.message).toContain("still running");
  });
});
