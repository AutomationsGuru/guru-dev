import { describe, expect, it, vi } from "vitest";

import {
  BootEventSchema,
  BootPhaseEventSchema,
  BootReportEventSchema,
  streamBootEvents,
  type BootEvent,
  type BootEmit
} from '../../src/boot/bootEvents.js';
import { runHeadlessBootRitual, type HeadlessBootRitualInput } from '../../src/boot/headless.js';
import { runBootRitual } from '../../src/boot/ritual.js';

function completeInput(overrides: Partial<HeadlessBootRitualInput> = {}): HeadlessBootRitualInput {
  return {
    cwd: "/home/operator/private-project",
    sessionNumber: 9,
    phaseData: {
      kernel: {
        runtimeName: "guruharness",
        runtimeVersion: "1.5.1",
        resolverReady: true
      },
      garage: {
        manifestCount: 2,
        verifiedLayerCount: 4,
        staleLayerCount: 0
      },
      memory: {
        provider: "markdown",
        status: "ready",
        injectedFactCount: 3
      }
    },
    workDeclaration: {
      availableCapabilityCount: 5,
      missingCapabilityCount: 0
    },
    baselineHealth: () => ({ verdict: "GREEN", durationMs: 12 }),
    ...overrides
  };
}

function collect(input: HeadlessBootRitualInput, options?: Parameters<typeof streamBootEvents>[2]): BootEvent[] {
  const events: BootEvent[] = [];
  const emit: BootEmit = (event) => {
    events.push(event);
  };
  streamBootEvents(input, emit, options);
  return events;
}

describe("streamBootEvents", () => {
  it("emits exactly five phase events in canonical order then one report event", () => {
    const events = collect(completeInput());

    expect(events).toHaveLength(6);
    expect(events.map((event) => event.type)).toEqual([
      "boot.phase",
      "boot.phase",
      "boot.phase",
      "boot.phase",
      "boot.phase",
      "boot.report"
    ]);
    const phases = events.slice(0, 5) as Extract<BootEvent, { type: "boot.phase" }>[];
    expect(phases.map((phase) => phase.phase)).toEqual(["kernel", "garage", "memory", "work", "health"]);
    expect(phases.map((phase) => phase.ordinal)).toEqual([1, 2, 3, 4, 5]);
  });

  it("shapes each phase event with type/ordinal/phase/status/lines", () => {
    const events = collect(completeInput());
    const phases = events.slice(0, 5) as Extract<BootEvent, { type: "boot.phase" }>[];

    expect(phases[0]).toMatchObject({
      type: "boot.phase",
      ordinal: 1,
      phase: "kernel",
      status: "ok",
      lines: ["runtime guruharness@1.5.1 · resolver ready · workspace provided"]
    });
    expect(phases[1]).toMatchObject({
      type: "boot.phase",
      ordinal: 2,
      phase: "garage",
      status: "ok",
      lines: ["garage 2 manifest(s) · 4 verified layer(s) · 0 stale layer(s)"]
    });
    expect(phases[2]).toMatchObject({
      type: "boot.phase",
      ordinal: 3,
      phase: "memory",
      status: "ok",
      lines: ["memory markdown/ready · 3 fact(s) injected"]
    });
    expect(phases[3]).toMatchObject({
      type: "boot.phase",
      ordinal: 4,
      phase: "work",
      status: "ok",
      lines: ["work declared · 5 capability(s) available · 0 missing"]
    });
    expect(phases[4]).toMatchObject({
      type: "boot.phase",
      ordinal: 5,
      phase: "health",
      status: "ok",
      lines: ["baseline health GREEN (12ms)"]
    });

    for (const phase of phases) {
      expect(BootPhaseEventSchema.safeParse(phase).success).toBe(true);
      expect(BootEventSchema.safeParse(phase).success).toBe(true);
    }
  });

  it("emits a terminal boot.report event with the session number and phase count", () => {
    const events = collect(completeInput({ sessionNumber: 42 }));
    const report = events[5] as Extract<BootEvent, { type: "boot.report" }>;

    expect(report).toEqual({ type: "boot.report", sessionNumber: 42, phases: 5 });
    expect(BootReportEventSchema.safeParse(report).success).toBe(true);
    expect(BootEventSchema.safeParse(report).success).toBe(true);
  });

  it("runs the underlying ritual exactly once via the ritualRunner seam", () => {
    const ritualRunner = vi.fn(runHeadlessBootRitual);
    const input = completeInput({ sessionNumber: 7 });

    const events = collect(input, { ritualRunner });

    expect(ritualRunner).toHaveBeenCalledTimes(1);
    expect(ritualRunner).toHaveBeenCalledWith(input);
    expect(events).toHaveLength(6);
    const report = events[5] as Extract<BootEvent, { type: "boot.report" }>;
    expect(report.sessionNumber).toBe(7);
  });

  it("streams a degraded missing-evidence boot without throwing", () => {
    const events = collect({ sessionNumber: 0 });

    expect(events).toHaveLength(6);
    const phases = events.slice(0, 5) as Extract<BootEvent, { type: "boot.phase" }>[];
    expect(phases.map((phase) => phase.phase)).toEqual(["kernel", "garage", "memory", "work", "health"]);
    expect(phases.map((phase) => phase.status)).toEqual(["warn", "skip", "skip", "skip", "skip"]);
    expect(phases.map((phase) => phase.ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(phases[0]!.lines).toEqual(["kernel evidence unavailable; workspace unavailable"]);
    expect(phases[1]!.lines).toEqual(["garage evidence unavailable"]);
    expect(phases[2]!.lines).toEqual(["memory evidence unavailable"]);
    expect(phases[3]!.lines).toEqual(["work declaration unavailable"]);
    expect(phases[4]!.lines).toEqual(["baseline health probe unavailable"]);
    const report = events[5] as Extract<BootEvent, { type: "boot.report" }>;
    expect(report).toEqual({ type: "boot.report", sessionNumber: 0, phases: 5 });
  });

  it("honors the canonical runBootRitual when no seam is supplied", () => {
    const spy = vi.spyOn({ runBootRitual }, "runBootRitual");
    // Sanity shape: a healthy input round-trips through the real ritual.
    const events = collect(completeInput());

    expect(spy).not.toHaveBeenCalled();
    expect(events).toHaveLength(6);
    vi.restoreAllMocks();
  });
});
