import { z } from "zod";

/**
 * The enforced boot ritual (Boot Ritual wave, ADR 2026-07-05-boot-ritual, THERE
 * v2 §4 + Article 4). Five ORDERED, NON-SKIPPABLE phases run as deterministic
 * code every wake: Kernel assertion → Garage inspection → Memory injection →
 * Work declaration → Baseline health. This module OWNS the order and phase
 * identity; the hooks (built from live state in guru.ts) only produce content.
 * Pure + unit-testable: a mis-ordered or dropped phase is a test failure.
 */

export const BootPhaseSchema = z.enum(["kernel", "garage", "memory", "work", "health"]);
export type BootPhase = z.infer<typeof BootPhaseSchema>;

export const PhaseStatusSchema = z.enum(["ok", "warn", "skip"]);
export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;

export interface PhaseOutput {
  readonly status: PhaseStatus;
  readonly lines: readonly string[];
}

export const BootPhaseResultSchema = z
  .object({
    phase: BootPhaseSchema,
    ordinal: z.number().int().min(1).max(5),
    title: z.string(),
    status: PhaseStatusSchema,
    lines: z.array(z.string())
  })
  .strict();
export type BootPhaseResult = z.infer<typeof BootPhaseResultSchema>;

export const BootReportSchema = z
  .object({
    sessionNumber: z.number().int().nonnegative(),
    phases: z.array(BootPhaseResultSchema).length(5)
  })
  .strict();
export type BootReport = z.infer<typeof BootReportSchema>;

export interface BootRitualHooks {
  /** Phase 1: identity + connected model + resolver-ready + cwd, out loud. */
  readonly kernelAssert: () => PhaseOutput;
  /** Phase 2: typed garage manifest query — suit, last worn, verification, stale. */
  readonly inspectGarage: () => PhaseOutput;
  /** Phase 3: decay-ranked memory injection with provenance. */
  readonly injectMemory: () => PhaseOutput;
  /** Phase 4: work declaration — have/lack → proactive resolver + gap records. */
  readonly declareWork: () => PhaseOutput;
  /** Phase 5: baseline health — the configured fast test green (TTFV). */
  readonly baselineHealth: () => PhaseOutput;
}

/** The fixed, enforced order. The ritual NEVER reorders or drops a phase. */
const PHASE_SEQUENCE: readonly { readonly phase: BootPhase; readonly title: string; readonly key: keyof BootRitualHooks }[] = [
  { phase: "kernel", title: "Kernel assertion", key: "kernelAssert" },
  { phase: "garage", title: "Garage inspection", key: "inspectGarage" },
  { phase: "memory", title: "Memory injection", key: "injectMemory" },
  { phase: "work", title: "Work declaration", key: "declareWork" },
  { phase: "health", title: "Baseline health", key: "baselineHealth" }
];

/**
 * Run the five phases IN ORDER. Non-skippable: a hook that throws degrades to a
 * `warn` phase and the ritual still completes all five. Returns the typed report.
 */
export function runBootRitual(hooks: BootRitualHooks, sessionNumber: number): BootReport {
  const phases: BootPhaseResult[] = [];
  PHASE_SEQUENCE.forEach((step, index) => {
    let output: PhaseOutput;
    try {
      output = hooks[step.key]();
    } catch (error) {
      output = { status: "warn", lines: [`phase failed: ${error instanceof Error ? error.message : String(error)}`] };
    }
    phases.push({
      phase: step.phase,
      ordinal: index + 1,
      title: step.title,
      status: output.status,
      lines: [...output.lines]
    });
  });
  return BootReportSchema.parse({ sessionNumber, phases });
}
