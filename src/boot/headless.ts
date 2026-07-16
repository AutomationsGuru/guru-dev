import { z } from "zod";

import {
  BootReportSchema,
  runBootRitual,
  type BootPhase,
  type BootReport,
  type BootRitualHooks,
  type PhaseOutput
} from "./ritual.js";

const BoundedCountSchema = z.number().int().nonnegative().max(1_000_000);

const HeadlessPhaseDataSchema = z
  .object({
    kernel: z
      .object({
        runtimeName: z.literal("guruharness"),
        runtimeVersion: z.string().min(1).max(32).regex(/^\d+\.\d+\.\d+$/u),
        resolverReady: z.boolean()
      })
      .strict()
      .optional(),
    garage: z
      .object({
        manifestCount: BoundedCountSchema,
        verifiedLayerCount: BoundedCountSchema,
        staleLayerCount: BoundedCountSchema
      })
      .strict()
      .optional(),
    memory: z
      .object({
        provider: z.enum(["markdown", "postgres"]),
        status: z.enum(["ready", "missing-env", "offline", "error"]),
        injectedFactCount: BoundedCountSchema
      })
      .strict()
      .optional()
  })
  .strict();

const HeadlessWorkDeclarationSchema = z
  .object({
    availableCapabilityCount: BoundedCountSchema,
    missingCapabilityCount: BoundedCountSchema
  })
  .strict();

const HeadlessHealthObservationSchema = z
  .object({
    verdict: z.enum(["GREEN", "RED"]),
    durationMs: z.number().int().nonnegative().max(300_000).optional()
  })
  .strict();

const HeadlessBootDataSchema = z
  .object({
    cwd: z.string().trim().min(1).max(4_096).optional(),
    sessionNumber: z.number().int().nonnegative(),
    dryRun: z.boolean().default(false),
    phaseData: HeadlessPhaseDataSchema.default({}),
    workDeclaration: HeadlessWorkDeclarationSchema.optional()
  })
  .strict();

const HookFailureEvidencePattern = /^phase hook failed; continuing$/u;
const HeadlessEvidenceAllowlist = {
  kernel: [
    /^kernel evidence unavailable; workspace (?:provided|unavailable)$/u,
    /^runtime guruharness@\d+\.\d+\.\d+ · resolver (?:ready|unavailable) · workspace (?:provided|unavailable)$/u,
    HookFailureEvidencePattern
  ],
  garage: [
    /^garage evidence unavailable$/u,
    /^garage \d+ manifest\(s\) · \d+ verified layer\(s\) · \d+ stale layer\(s\)$/u,
    HookFailureEvidencePattern
  ],
  memory: [
    /^memory evidence unavailable$/u,
    /^memory (?:markdown|postgres)\/(?:ready|missing-env|offline|error) · \d+ fact\(s\) injected$/u,
    HookFailureEvidencePattern
  ],
  work: [
    /^work declaration unavailable$/u,
    /^work declared · \d+ capability\(s\) available · \d+ missing$/u,
    HookFailureEvidencePattern
  ],
  health: [
    /^dry-run — baseline health not executed$/u,
    /^baseline health probe unavailable$/u,
    /^baseline health (?:GREEN|RED)(?: \(\d+ms\))?$/u,
    HookFailureEvidencePattern
  ]
} satisfies Readonly<Record<BootPhase, readonly RegExp[]>>;

const HeadlessBootReportSchema = BootReportSchema.superRefine((report, ctx) => {
  report.phases.forEach((phase, phaseIndex) => {
    if (phase.lines.length > 8) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "headless phase evidence exceeds the line allowlist",
        path: ["phases", phaseIndex, "lines"]
      });
    }

    phase.lines.forEach((line, lineIndex) => {
      if (line.length > 240) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "headless phase evidence line exceeds the length limit",
          path: ["phases", phaseIndex, "lines", lineIndex]
        });
      }

      if (!HeadlessEvidenceAllowlist[phase.phase].some((pattern) => pattern.test(line))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "headless phase evidence is not allowlisted",
          path: ["phases", phaseIndex, "lines", lineIndex]
        });
      }
    });
  });
});

export type HeadlessBootPhaseData = z.input<typeof HeadlessPhaseDataSchema>;
export type HeadlessWorkDeclaration = z.input<typeof HeadlessWorkDeclarationSchema>;
export type HeadlessHealthObservation = z.input<typeof HeadlessHealthObservationSchema>;
export type HeadlessBaselineHealth = () => unknown;
export type HeadlessBootRitualRunner = (hooks: BootRitualHooks, sessionNumber: number) => unknown;

export interface HeadlessBootRitualInput {
  readonly cwd?: string;
  readonly sessionNumber: number;
  readonly dryRun?: boolean;
  readonly phaseData?: HeadlessBootPhaseData;
  readonly workDeclaration?: HeadlessWorkDeclaration;
  readonly baselineHealth?: HeadlessBaselineHealth;
  /** Test seam only; production callers use the canonical runBootRitual. */
  readonly ritualRunner?: HeadlessBootRitualRunner;
}

/**
 * Build a bounded, machine-readable boot report for non-interactive entrypoints.
 * All content is derived from a fixed allowlist; cwd values and hook diagnostics
 * are never copied into the report.
 */
export function runHeadlessBootRitual(input: HeadlessBootRitualInput): BootReport {
  const { baselineHealth, ritualRunner, ...serializableInput } = input;
  if (baselineHealth !== undefined && typeof baselineHealth !== "function") {
    throw new TypeError("baselineHealth must be a function");
  }
  if (ritualRunner !== undefined && typeof ritualRunner !== "function") {
    throw new TypeError("ritualRunner must be a function");
  }
  const parsed = HeadlessBootDataSchema.parse(serializableInput);
  const kernel = parsed.phaseData.kernel;
  const garage = parsed.phaseData.garage;
  const memory = parsed.phaseData.memory;

  const hooks: BootRitualHooks = {
    kernelAssert: (): PhaseOutput => {
      const workspace = parsed.cwd ? "provided" : "unavailable";
      if (!kernel) {
        return { status: "warn", lines: [`kernel evidence unavailable; workspace ${workspace}`] };
      }
      return {
        status: kernel.resolverReady && parsed.cwd ? "ok" : "warn",
        lines: [
          `runtime ${kernel.runtimeName}@${kernel.runtimeVersion} · resolver ${kernel.resolverReady ? "ready" : "unavailable"} · workspace ${workspace}`
        ]
      };
    },
    inspectGarage: (): PhaseOutput => {
      if (!garage) {
        return { status: "skip", lines: ["garage evidence unavailable"] };
      }
      return {
        status: garage.staleLayerCount > 0 ? "warn" : "ok",
        lines: [
          `garage ${garage.manifestCount} manifest(s) · ${garage.verifiedLayerCount} verified layer(s) · ${garage.staleLayerCount} stale layer(s)`
        ]
      };
    },
    injectMemory: (): PhaseOutput => {
      if (!memory) {
        return { status: "skip", lines: ["memory evidence unavailable"] };
      }
      return {
        status: memory.status === "ready" ? "ok" : "warn",
        lines: [`memory ${memory.provider}/${memory.status} · ${memory.injectedFactCount} fact(s) injected`]
      };
    },
    declareWork: (): PhaseOutput => {
      if (!parsed.workDeclaration) {
        return { status: "skip", lines: ["work declaration unavailable"] };
      }
      return {
        status: parsed.workDeclaration.missingCapabilityCount > 0 ? "warn" : "ok",
        lines: [
          `work declared · ${parsed.workDeclaration.availableCapabilityCount} capability(s) available · ${parsed.workDeclaration.missingCapabilityCount} missing`
        ]
      };
    },
    baselineHealth: (): PhaseOutput => {
      if (parsed.dryRun) {
        return { status: "skip", lines: ["dry-run — baseline health not executed"] };
      }
      if (!baselineHealth) {
        return { status: "skip", lines: ["baseline health probe unavailable"] };
      }
      const observation = HeadlessHealthObservationSchema.parse(baselineHealth());
      const duration = observation.durationMs === undefined ? "" : ` (${observation.durationMs}ms)`;
      return {
        status: observation.verdict === "GREEN" ? "ok" : "warn",
        lines: [`baseline health ${observation.verdict}${duration}`]
      };
    }
  };

  const untrustedReport = (ritualRunner ?? runBootRitual)(hooks, parsed.sessionNumber);
  return HeadlessBootReportSchema.parse(untrustedReport);
}
