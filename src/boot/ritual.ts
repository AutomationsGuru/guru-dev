import { z } from "zod";

// G1055 LHT runtime lifecycle: types + session context for config-driven init
import type { GuruHarnessConfig, LHTProfileMinima } from "../types.js";
import { createSessionContext } from "../session/context.js";
import { DEFAULT_PROFILE_MINIMA } from "../lht/profile-minima.js";

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

export const BootReportSchema = z
  .object({
    sessionNumber: z.number().int().nonnegative(),
    phases: z.array(BootPhaseResultSchema).length(PHASE_SEQUENCE.length)
  })
  .strict()
  .superRefine((report, context) => {
    report.phases.forEach((phase, index) => {
      const expected = PHASE_SEQUENCE[index];
      if (
        expected &&
        (phase.phase !== expected.phase || phase.ordinal !== index + 1 || phase.title !== expected.title)
      ) {
        context.addIssue({
          code: "custom",
          path: ["phases", index],
          message: `expected canonical phase ${index + 1}: ${expected.phase}`
        });
      }
    });
  });
export type BootReport = z.infer<typeof BootReportSchema>;

// === G1055 LHT runtime lifecycle vars (module-scoped, non-intrusive when disabled) ===
let lhtPollInterval: NodeJS.Timeout | null = null;
let lhtEnabled = false;
let lhtPollIntervalMs = 5000;
let profileMinima: LHTProfileMinima | undefined;

/**
 * Initialize LHT from optional GuruHarnessConfig.lht.
 * Defaults pollIntervalMs to 5000, wires profileMinima from config or default.
 * All subsequent LHT behavior is gated on lhtEnabled.
 */
function initializeLhtFromConfig(config?: GuruHarnessConfig): void {
  const lht = config?.lht;
  lhtEnabled = !!lht?.enabled;
  if (lhtEnabled) {
    lhtPollIntervalMs = lht?.pollIntervalMs ?? 5000;
    profileMinima = lht?.profileMinima ?? DEFAULT_PROFILE_MINIMA;
  }
}

export function getLhtPollInterval(): number {
  return lhtPollIntervalMs;
}

export function shutdownLht(): void {
  if (lhtPollInterval) {
    clearInterval(lhtPollInterval);
    lhtPollInterval = null;
  }
  lhtEnabled = false;
}

/**
 * Run the five phases IN ORDER. Non-skippable: a hook that throws degrades to a
 * `warn` phase and the ritual still completes all five. Returns the typed report.
 */
export function runBootRitual(hooks: BootRitualHooks, sessionNumber: number, config?: GuruHarnessConfig): BootReport {
  // G1055: Wire LHT initialization in PHASE 1 when enabled (guarded, non-intrusive when disabled)
  if (config?.lht?.enabled) {
    initializeLhtFromConfig(config);
  }

  const phases: BootPhaseResult[] = [];
  PHASE_SEQUENCE.forEach((step, index) => {
    let output: PhaseOutput;
    try {
      output = hooks[step.key]();
    } catch {
      output = { status: "warn", lines: ["phase hook failed; continuing"] };
    }
    phases.push({
      phase: step.phase,
      ordinal: index + 1,
      title: step.title,
      status: output.status,
      lines: [...output.lines]
    });

    // G1055: PHASE 1 (kernel) already initialized above when enabled
    // G1055: Add LHT state to session context in PHASE 2 (garage)
    if (lhtEnabled && index === 1) {
      createSessionContext(config); // populates SessionContext.lht from config
    }

    // G1055: Add graceful shutdown via shutdownLht in PHASE 4 (work declaration)
    if (lhtEnabled && index === 3) {
      shutdownLht();
    }
  });

  return BootReportSchema.parse({ sessionNumber, phases });
}

// G1055: Graceful LHT shutdown is wired in PHASE 4 via shutdownLht() when enabled.
// No top-level process handlers here to keep ritual pure and testable.
