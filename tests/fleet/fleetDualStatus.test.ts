import { describe, it, expect } from "vitest";

import {
  createFleetDualStatus,
  FleetProcessStatusSchema,
  FleetWorkStatusSchema,
  FleetDualStatusSchema,
  type FleetProcessStatus,
  type FleetWorkStatus
} from '../../src/fleet/fleetDualStatus.js';

// --- Schema shape ---

describe("FleetProcessStatusSchema", () => {
  it("accepts all declared process status values", () => {
    const values: FleetProcessStatus[] = ["starting", "running", "stopping", "stopped", "crashed"];
    for (const value of values) {
      expect(FleetProcessStatusSchema.parse(value)).toBe(value);
    }
  });

  it("rejects an invalid process status", () => {
    expect(() => FleetProcessStatusSchema.parse("flying")).toThrow();
  });
});

describe("FleetWorkStatusSchema", () => {
  it("accepts all declared work status values", () => {
    const values: FleetWorkStatus[] = ["idle", "working", "thinking", "blocked", "completed"];
    for (const value of values) {
      expect(FleetWorkStatusSchema.parse(value)).toBe(value);
    }
  });

  it("rejects an invalid work status", () => {
    expect(() => FleetWorkStatusSchema.parse("vacationing")).toThrow();
  });
});

describe("FleetDualStatusSchema", () => {
  it("accepts a valid dual status object", () => {
    const parsed = FleetDualStatusSchema.parse({ processStatus: "running", workStatus: "working" });
    expect(parsed).toEqual({ processStatus: "running", workStatus: "working" });
  });

  it("rejects extra fields via .strict()", () => {
    expect(() =>
      FleetDualStatusSchema.parse({ processStatus: "running", workStatus: "idle", extra: "nope" })
    ).toThrow();
  });
});

// --- Factory defaults ---

describe("createFleetDualStatus defaults", () => {
  it("defaults processStatus to 'starting'", () => {
    const h = createFleetDualStatus();
    expect(h.snapshot().processStatus).toBe("starting");
  });

  it("defaults workStatus to 'idle'", () => {
    const h = createFleetDualStatus();
    expect(h.snapshot().workStatus).toBe("idle");
  });
});

// --- Axis independence (core contract) ---

describe("axis independence", () => {
  it("setProcess changes only processStatus, not workStatus", () => {
    const h = createFleetDualStatus();
    const before = h.snapshot();

    h.setProcess("crashed");

    const after = h.snapshot();
    expect(after.processStatus).toBe("crashed");
    expect(after.workStatus).toBe(before.workStatus);
  });

  it("setWork changes only workStatus, not processStatus", () => {
    const h = createFleetDualStatus();
    const before = h.snapshot();

    h.setWork("blocked");

    const after = h.snapshot();
    expect(after.workStatus).toBe("blocked");
    expect(after.processStatus).toBe(before.processStatus);
  });

  it("both axes can be set independently — dual state is orthogonal", () => {
    const h = createFleetDualStatus();

    h.setProcess("running");
    h.setWork("thinking");
    expect(h.snapshot()).toEqual({ processStatus: "running", workStatus: "thinking" });

    h.setWork("blocked");
    expect(h.snapshot()).toEqual({ processStatus: "running", workStatus: "blocked" });

    h.setProcess("stopping");
    expect(h.snapshot()).toEqual({ processStatus: "stopping", workStatus: "blocked" });

    h.setWork("completed");
    h.setProcess("stopped");
    expect(h.snapshot()).toEqual({ processStatus: "stopped", workStatus: "completed" });
  });
});

// --- Snapshot immutability ---

describe("snapshot immutability", () => {
  it("returns a read-only copy — mutating the snapshot does not change internal state", () => {
    const h = createFleetDualStatus();
    h.setProcess("running");
    h.setWork("working");

    const snap = h.snapshot();
    // Attempt to mutate the snapshot (TS compile-time readonly, but we verify runtime behaviour too)
    (snap as Record<string, unknown>)["processStatus"] = "crashed";
    (snap as Record<string, unknown>)["workStatus"] = "idle";

    const fresh = h.snapshot();
    expect(fresh.processStatus).toBe("running");
    expect(fresh.workStatus).toBe("working");
  });
});

// --- Reset ---

describe("reset", () => {
  it("brings both axes back to defaults", () => {
    const h = createFleetDualStatus();

    h.setProcess("crashed");
    h.setWork("blocked");
    expect(h.snapshot()).toEqual({ processStatus: "crashed", workStatus: "blocked" });

    h.reset();
    expect(h.snapshot()).toEqual({ processStatus: "starting", workStatus: "idle" });
  });
});

// --- All enum value coverage ---

describe("full process status cycle", () => {
  it("can transition through every process status", () => {
    const h = createFleetDualStatus();
    const cycle: FleetProcessStatus[] = ["starting", "running", "stopping", "stopped", "crashed"];

    for (const status of cycle) {
      h.setProcess(status);
      expect(h.snapshot().processStatus).toBe(status);
    }
  });
});

describe("full work status cycle", () => {
  it("can transition through every work status", () => {
    const h = createFleetDualStatus();
    const cycle: FleetWorkStatus[] = ["idle", "working", "thinking", "blocked", "completed"];

    for (const status of cycle) {
      h.setWork(status);
      expect(h.snapshot().workStatus).toBe(status);
    }
  });
});