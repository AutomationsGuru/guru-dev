import { z } from "zod";

import { makeGapRecord } from "../garage/gapRecords.js";
import type { GapRecord } from "../garage/manifest.js";
import { detectPotentialSecrets } from "../safety/policyGuard.js";

/**
 * LangSmith trace ATTACH stub (IDEA-F222-LANGSMITH-ATTACH-01 / R-DA-TRACE-ATTACH).
 *
 * Optional, disabled-by-default observability exporter scaffolding — NOT a live
 * LangSmith integration. The earlier F222 review (RED §3.2–§3.4) held that an
 * external trace ATTACH may not proceed without structural enforcement of:
 *
 *   §3.2 no unapproved spend  → export is blocked unless the operator explicitly
 *                               opts in (enabled) AND approves the spend/quota
 *                               (userApproved). Unknown cost is not free.
 *   §3.3 no leaked secrets    → a structural pre-export scrub rejects any span
 *                               whose fields match the secret detector; the API
 *                               key is referenced by env NAME only and its value
 *                               is never read for content, logged, or returned.
 *   §3.4 no out-of-scope cross→ the stub exports nothing by default and reports
 *                               an honest status instead of impersonating a live
 *                               trace sink; it registers as an ATTACH parity gap
 *                               with a promotion trigger to a native exporter.
 *
 * The exporter is a stub: when every gate is satisfied it reports "held" — the
 * span cleared the gates but no wire is attached yet. That keeps the harness
 * honest (never claims a delivery that did not happen) while giving the future
 * native/BUILD exporter a gated seam to register through.
 */

export const LangSmithTraceConfigSchema = z
  .object({
    /** Master switch. Default false — no default-on telemetry. */
    enabled: z.boolean().default(false),
    /** Operator spend/quota approval (§3.2). Default false — unknown cost is not free. */
    userApproved: z.boolean().default(false),
    /** Env var NAME holding the LangSmith API key. The value is never read for content. */
    apiKeyEnvVar: z.string().trim().min(1).default("LANGSMITH_API_KEY"),
    /** Optional trace endpoint override (self-hosted LangSmith). */
    endpoint: z.string().trim().min(1).optional()
  })
  .strict();
export type LangSmithTraceConfig = z.infer<typeof LangSmithTraceConfigSchema>;

export const LangSmithTraceSpanSchema = z
  .object({
    name: z.string().trim().min(1),
    input: z.string().default(""),
    output: z.string().default("")
  })
  .strict();
export type LangSmithTraceSpan = z.infer<typeof LangSmithTraceSpanSchema>;

export const LangSmithTraceStatusKindSchema = z.enum(["disabled", "missing-env", "awaiting-approval", "ready"]);
export type LangSmithTraceStatusKind = z.infer<typeof LangSmithTraceStatusKindSchema>;

export interface LangSmithTraceStatus {
  readonly status: LangSmithTraceStatusKind;
  /** True only when a span could clear every gate right now. */
  readonly exportEnabled: boolean;
  /** Env var NAMES that are missing — never values. */
  readonly missingEnvNames: readonly string[];
  readonly summary: string;
}

export interface LangSmithTraceExportResult {
  /**
   * "blocked"  — a hard gate refused the export (disabled / unapproved / missing
   *              key / potential secret). Nothing left the process.
   * "held"     — every gate cleared, but this is a stub: the span is staged at
   *              the seam, not delivered. Never reported as a real export.
   */
  readonly status: "blocked" | "held";
  readonly summary: string;
}

export interface LangSmithTraceExporter {
  status(): Promise<LangSmithTraceStatus>;
  exportSpan(span: LangSmithTraceSpan): Promise<LangSmithTraceExportResult>;
}

export interface LangSmithTraceExporterOptions {
  readonly config: LangSmithTraceConfig;
  readonly env?: NodeJS.ProcessEnv;
}

/** The ATTACH parity gap this stub rides (promotion trigger → native exporter). */
export function langSmithTraceGapRecord(createdAt: string): GapRecord {
  return makeGapRecord(
    "langsmith-trace-export",
    "attach",
    "LangSmith tracing is an optional ATTACH observability stub, not a native exporter. " +
      "Export is disabled by default and gated on operator approval (§3.2) plus a structural " +
      "pre-export secret scrub (§3.3). Promote to native when a first-party trace exporter " +
      "registers through the extension seam.",
    createdAt
  );
}

export function createLangSmithTraceExporter(options: LangSmithTraceExporterOptions): LangSmithTraceExporter {
  const config = LangSmithTraceConfigSchema.parse(options.config);
  const env = options.env ?? process.env;

  const apiKeyPresent = (): boolean => {
    const candidate = env[config.apiKeyEnvVar];
    return typeof candidate === "string" && candidate.trim().length > 0;
  };

  const missingEnvNames = (): string[] => (apiKeyPresent() ? [] : [config.apiKeyEnvVar]);

  /** Hard gates, evaluated in constitution order. Returns blockers, empty = clear. */
  const exportBlockers = (span: LangSmithTraceSpan): string[] => {
    const blockers: string[] = [];
    if (!config.enabled) {
      blockers.push("LangSmith tracing is disabled; enable observability.langsmith before exporting traces.");
    }
    if (!config.userApproved) {
      blockers.push("LangSmith trace export requires operator approval (spend/quota gate).");
    }
    if (!apiKeyPresent()) {
      blockers.push(`LangSmith requires ${config.apiKeyEnvVar}.`);
    }
    blockers.push(
      ...detectPotentialSecrets([
        { name: "span.name", value: span.name },
        { name: "span.input", value: span.input },
        { name: "span.output", value: span.output }
      ]).map((detection) => `Potential secret detected in ${detection.name} (${detection.kind}); trace export refused and value redacted.`)
    );
    return blockers;
  };

  return {
    async status() {
      if (!config.enabled) {
        return {
          status: "disabled",
          exportEnabled: false,
          missingEnvNames: [],
          summary: "LangSmith tracing is disabled. Enable observability.langsmith to attach optional trace export."
        };
      }
      const missing = missingEnvNames();
      if (missing.length > 0) {
        return {
          status: "missing-env",
          exportEnabled: false,
          missingEnvNames: missing,
          summary: "LangSmith tracing is enabled but its API-key environment variable is missing."
        };
      }
      if (!config.userApproved) {
        return {
          status: "awaiting-approval",
          exportEnabled: false,
          missingEnvNames: [],
          summary: "LangSmith tracing is configured but awaiting operator approval for trace export (spend/quota gate)."
        };
      }
      return {
        status: "ready",
        exportEnabled: true,
        missingEnvNames: [],
        summary: "LangSmith trace stub is gated-open; spans are held at the seam (no live wire attached)."
      };
    },

    async exportSpan(rawSpan) {
      const span = LangSmithTraceSpanSchema.parse(rawSpan);
      const blockers = exportBlockers(span);
      if (blockers.length > 0) {
        return { status: "blocked", summary: blockers.join(" ") };
      }
      // Stub: gates cleared, but no LangSmith client is wired. Stage at the seam;
      // never claim a delivery that did not happen.
      return { status: "held", summary: `Trace span "${span.name}" cleared every gate and is held at the attach seam (stub — no live exporter wired).` };
    }
  };
}
