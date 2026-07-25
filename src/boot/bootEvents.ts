import { z } from "zod";

import { runHeadlessBootRitual, type HeadlessBootRitualInput } from "./headless.js";
import { BootPhaseSchema, PhaseStatusSchema } from "./ritual.js";

/**
 * Headless JSON event stream (Headless JSON Events wave, ADR 2026-07-19-boot-events).
 *
 * A machine-readable companion to `runHeadlessBootRitual`: instead of returning the
 * fully-formed `BootReport` at once, the boot is published as ONE bounded JSON event
 * per phase followed by a terminal `boot.report` event. Each event is a single line
 * (LF-delimited) suitable for stdout consumption by CI, orchestrators, and the RPC
 * surface. The ritual itself is unchanged — this layer only frames its output.
 *
 * Ownership:
 * - This module OWNS the event envelope schema (`type`, `ordinal`, `phase`, `status`,
 *   `lines`) and the ordered emit discipline (5 phase events, then the report).
 * - It depends ONLY on `runHeadlessBootRitual`'s documented return type.
 * - The ritual's phase order, allowlist, and bounded-evidence rules are owned by
 *   `./headless.js` and `./ritual.js`; this module never re-validates or copies them.
 */

export const BootPhaseEventSchema = z
  .object({
    type: z.literal("boot.phase"),
    ordinal: z.number().int().min(1).max(5),
    phase: BootPhaseSchema,
    status: PhaseStatusSchema,
    lines: z.array(z.string())
  })
  .strict();
export type BootPhaseEvent = z.infer<typeof BootPhaseEventSchema>;

export const BootReportEventSchema = z
  .object({
    type: z.literal("boot.report"),
    sessionNumber: z.number().int().nonnegative(),
    phases: z.number().int().min(0)
  })
  .strict();
export type BootReportEvent = z.infer<typeof BootReportEventSchema>;

export const BootEventSchema = z.discriminatedUnion("type", [BootPhaseEventSchema, BootReportEventSchema]);
export type BootEvent = z.infer<typeof BootEventSchema>;

export type BootEmit = (event: BootEvent) => void;

export interface StreamBootEventsOptions {
  /**
   * Test seam only; production callers omit it and the canonical
   * `runHeadlessBootRitual` runs. Mirrors the ritualRunner seam in headless.ts.
   */
  readonly ritualRunner?: (input: HeadlessBootRitualInput) => ReturnType<typeof runHeadlessBootRitual>;
}

/**
 * Run the headless boot ritual and stream its result as bounded JSON events.
 *
 * Emits exactly `phases.length` `boot.phase` events (in canonical order) followed
 * by exactly one `boot.report` event. The ritual is invoked exactly once. The
 * `emit` callback receives fully validated events — it is never called with a
 * partial or out-of-order phase. Throws only if the underlying ritual or its
 * evidence fails validation (the ritual itself degrades hook failures to `warn`,
 * so an honest degraded boot still streams successfully).
 */
export function streamBootEvents(
  input: HeadlessBootRitualInput,
  emit: BootEmit,
  options: StreamBootEventsOptions = {}
): void {
  const runRitual = options.ritualRunner ?? runHeadlessBootRitual;
  const report = runRitual(input);
  for (const phase of report.phases) {
    emit(
      BootPhaseEventSchema.parse({
        type: "boot.phase",
        ordinal: phase.ordinal,
        phase: phase.phase,
        status: phase.status,
        lines: [...phase.lines]
      })
    );
  }
  emit(
    BootReportEventSchema.parse({
      type: "boot.report",
      sessionNumber: report.sessionNumber,
      phases: report.phases.length
    })
  );
}
