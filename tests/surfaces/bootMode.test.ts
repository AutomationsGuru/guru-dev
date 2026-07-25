import { describe, expect, it } from "vitest";

import { runBootMode } from '../../src/surfaces/bootMode.js';
import type { BootModeState } from '../../src/surfaces/bootMode.js';
import type { HeadlessBootRitualInput } from '../../src/boot/headless.js';

interface CapturingSink {
  readonly lines: readonly string[];
  readonly stream: NodeJS.WritableStream;
}

function capturingSink(): CapturingSink {
  const lines: string[] = [];
  const stream: NodeJS.WritableStream = {
    write(chunk: unknown): boolean {
      lines.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    },
    end(): void {},
    destroy(): void {}
  } as unknown as NodeJS.WritableStream;
  return { lines, stream };
}

function parseLines(lines: readonly string[]): Array<Record<string, unknown>> {
  return lines
    .join("")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("runBootMode", () => {
  it("streams six NDJSON events: five boot.phase then one boot.report", async () => {
    const sink = capturingSink();

    await runBootMode({
      sessionNumber: 7,
      cwd: "/home/operator/private-project",
      buildInput: (state: BootModeState): HeadlessBootRitualInput => ({
        ...(state.cwd !== undefined ? { cwd: state.cwd } : {}),
        sessionNumber: state.sessionNumber,
        phaseData: {
          kernel: {
            runtimeName: "guruharness",
            runtimeVersion: state.runtimeVersion,
            resolverReady: true
          },
          garage: { manifestCount: 1, verifiedLayerCount: 1, staleLayerCount: 0 },
          memory: { provider: "markdown", status: "ready", injectedFactCount: 0 }
        },
        workDeclaration: { availableCapabilityCount: 1, missingCapabilityCount: 0 },
        baselineHealth: () => ({ verdict: "GREEN", durationMs: 1 })
      }),
      output: sink.stream
    });

    const events = parseLines(sink.lines);
    expect(events).toHaveLength(6);
    expect(events.slice(0, 5).map((event) => event.type)).toEqual([
      "boot.phase",
      "boot.phase",
      "boot.phase",
      "boot.phase",
      "boot.phase"
    ]);
    expect(events[5]?.type).toBe("boot.report");

    const phases = events.slice(0, 5);
    expect(phases.map((event) => event.phase)).toEqual(["kernel", "garage", "memory", "work", "health"]);
    expect(phases.map((event) => event.ordinal)).toEqual([1, 2, 3, 4, 5]);

    const report = events[5];
    expect(report).toMatchObject({ type: "boot.report", sessionNumber: 7, phases: 5 });
  });

  it("does not touch the home counter when sessionNumber is injected", async () => {
    const sink = capturingSink();

    await runBootMode({
      sessionNumber: 7,
      buildInput: (state: BootModeState): HeadlessBootRitualInput => ({
        sessionNumber: state.sessionNumber,
        phaseData: {
          kernel: {
            runtimeName: "guruharness",
            runtimeVersion: state.runtimeVersion,
            resolverReady: false
          }
        }
      }),
      output: sink.stream
    });

    const report = parseLines(sink.lines).find((event) => event.type === "boot.report");
    expect(report?.sessionNumber).toBe(7);
  });

  it("marks the health phase as skip in dry-run mode when no baselineHealth is supplied", async () => {
    const sink = capturingSink();

    await runBootMode({
      sessionNumber: 7,
      dryRun: true,
      buildInput: (state: BootModeState): HeadlessBootRitualInput => ({
        sessionNumber: state.sessionNumber,
        dryRun: true,
        phaseData: {
          kernel: {
            runtimeName: "guruharness",
            runtimeVersion: state.runtimeVersion,
            resolverReady: true
          }
        }
      }),
      output: sink.stream
    });

    const events = parseLines(sink.lines);
    const health = events.find(
      (event) => event.type === "boot.phase" && event.phase === "health"
    );
    expect(health).toMatchObject({ type: "boot.phase", phase: "health", status: "skip" });
    expect(health?.lines).toEqual(["dry-run — baseline health not executed"]);
  });

  it("frames every event as exactly one LF-delimited JSON line", async () => {
    const sink = capturingSink();

    await runBootMode({
      sessionNumber: 3,
      cwd: "/tmp/synthetic-boot-mode-cwd",
      buildInput: (state: BootModeState): HeadlessBootRitualInput => ({
        ...(state.cwd !== undefined ? { cwd: state.cwd } : {}),
        sessionNumber: state.sessionNumber,
        phaseData: {
          kernel: {
            runtimeName: "guruharness",
            runtimeVersion: state.runtimeVersion,
            resolverReady: true
          }
        }
      }),
      output: sink.stream
    });

    // Each write is one event line ending in "\n" — concatenating and splitting
    // must yield exactly 6 non-empty records with no trailing partial frame.
    const concatenated = sink.lines.join("");
    expect(concatenated.endsWith("\n")).toBe(true);
    const nonEmpty = concatenated.split("\n").filter((line) => line.length > 0);
    expect(nonEmpty).toHaveLength(6);
    for (const line of nonEmpty) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
