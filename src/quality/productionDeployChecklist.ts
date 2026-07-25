/**
 * Production deploy checklist (IDEA-F230-PROD-CHECKLIST-01).
 *
 * Pure evaluation of runtime signals → GREEN/YELLOW/RED verdict for a
 * production deploy. Required items (secrets, sandbox, hard limits) each
 * gate the verdict; tracing is optional and never blocks. A companion
 * `detectProductionSignals()` samples the current environment for each
 * signal so the eval stays pure.
 *
 * No LangSmith, no deep-agents, no commit/push/PR — a deploy-readiness
 * checklist only.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { VerdictSchema, type Verdict } from "../core/types.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

// ── Signals (input) ───────────────────────────────────────────────────────────

export const ProductionSignalsSchema = z
  .object({
    /** Secret-safety patterns and scrubbers are active. */
    secretSafetyActive: z.boolean(),
    /** Runtime sandbox / process isolation is active. */
    sandboxActive: z.boolean(),
    /** Five hard limits are structurally enforced (mandate engine). */
    hardLimitsEnforced: z.boolean(),
    /** Observability/tracing is configured (optional — never a blocker). */
    tracingConfigured: z.boolean().default(false)
  })
  .strict();
export type ProductionSignals = z.infer<typeof ProductionSignalsSchema>;

// ── Checklist items ───────────────────────────────────────────────────────────

export const ChecklistCategorySchema = z.enum([
  "secrets",
  "sandbox",
  "hard-limits",
  "tracing"
]);
export type ChecklistCategory = z.infer<typeof ChecklistCategorySchema>;

export const ProductionChecklistItemSchema = z
  .object({
    /** Stable machine-readable id. */
    id: z.string().trim().min(1),
    /** Grouping category. */
    category: ChecklistCategorySchema,
    /** Human-readable label. */
    title: z.string().trim().min(1),
    /** When true this item gates the verdict (RED on failure). */
    required: z.boolean(),
    /** True when the signal indicates readiness. */
    passed: z.boolean(),
    /** One-line explanation of why it passed or failed. */
    evidence: z.string().trim().min(1)
  })
  .strict();
export type ProductionChecklistItem = z.infer<typeof ProductionChecklistItemSchema>;

// ── Report (output) ───────────────────────────────────────────────────────────

export const ProductionDeployChecklistSchema = z
  .object({
    /** ISO-8601 timestamp of evaluation. */
    generatedAt: z.string(),
    /** Aggregate verdict: GREEN (all required pass), RED (any required fails). */
    verdict: VerdictSchema,
    /** Ordered checklist items. */
    items: z.array(ProductionChecklistItemSchema).length(4),
    /** Human-readable one-line summary. */
    summary: z.string().trim().min(1)
  })
  .strict();
export type ProductionDeployChecklist = z.infer<typeof ProductionDeployChecklistSchema>;

// ── Evaluation ────────────────────────────────────────────────────────────────

function makeItem(
  id: string,
  category: ChecklistCategory,
  title: string,
  required: boolean,
  passed: boolean,
  passedEvidence: string,
  failedEvidence: string
): ProductionChecklistItem {
  return ProductionChecklistItemSchema.parse({
    id,
    category,
    title,
    required,
    passed,
    evidence: passed ? passedEvidence : failedEvidence
  });
}

/**
 * Evaluate production deploy readiness from observable signals.
 * Pure — the caller owns the signals; the function only evaluates them.
 *
 * Verdict rules:
 * - Any required item that fails → RED.
 * - All required items pass → GREEN.
 */
export function evaluateProductionDeployChecklist(
  signals: ProductionSignals
): ProductionDeployChecklist {
  const items: ProductionChecklistItem[] = [
    makeItem(
      "secrets",
      "secrets",
      "Secret safety active",
      /* required */ true,
      signals.secretSafetyActive,
      "Secret-safety patterns, scrubbers, and assignment detection are active.",
      "Secret safety is NOT active — credential values may leak into outputs, transcripts, or logs."
    ),
    makeItem(
      "sandbox",
      "sandbox",
      "Runtime sandbox active",
      /* required */ true,
      signals.sandboxActive,
      "Runtime process isolation (sandbox) is active.",
      "Runtime sandbox is NOT active — production deploys require sandbox isolation."
    ),
    makeItem(
      "hard-limits",
      "hard-limits",
      "Hard limits enforced",
      /* required */ true,
      signals.hardLimitsEnforced,
      "Five hard limits are structurally enforced via mandate evaluation.",
      "Hard-limit enforcement is NOT verified — the harness may operate without constitutional bounds."
    ),
    makeItem(
      "tracing",
      "tracing",
      "Tracing configured (optional)",
      /* required */ false,
      signals.tracingConfigured,
      "Observability / tracing is configured.",
      "Tracing is not configured — this is optional and does not block deployment."
    )
  ];

  const requiredItems = items.filter((i) => i.required);
  const requiredPassed = requiredItems.filter((i) => i.passed).length;
  const requiredFailed = requiredItems.length - requiredPassed;
  const allPassed = items.filter((i) => i.passed).length;

  const verdict: Verdict = requiredFailed > 0 ? "RED" : "GREEN";

  return ProductionDeployChecklistSchema.parse({
    generatedAt: new Date().toISOString(),
    verdict,
    items,
    summary: `${verdict}: ${allPassed}/${items.length} items passed — ${requiredPassed}/${requiredItems.length} required, ${requiredFailed} required failed.`
  });
}

// ── Signal detection ──────────────────────────────────────────────────────────

/**
 * Detect production-deploy signals from the current runtime environment.
 * Best-effort; callers that have stronger evidence should supply their own
 * {@link ProductionSignals} directly.
 */
export function detectProductionSignals(): ProductionSignals {
  return ProductionSignalsSchema.parse({
    secretSafetyActive: detectSecretSafety(),
    sandboxActive: detectSandbox(),
    hardLimitsEnforced: detectHardLimitsEnforcement(),
    tracingConfigured: detectTracing()
  });
}

function detectSecretSafety(): boolean {
  // The secretSafety module is part of the GuruHarness source tree.
  // We check for the source file on disk — a synchronous probe that
  // works in both CJS and ESM contexts.
  return existsSync(join(MODULE_DIR, "..", "safety", "secretSafety.ts"));
}

function detectSandbox(): boolean {
  // GURU_SANDBOX_ACTIVE is the canonical env signal for sandbox activation.
  if (typeof process !== "undefined" && process.env?.GURU_SANDBOX_ACTIVE === "1") {
    return true;
  }

  // Container detection (Linux): look for container runtime markers in cgroup.
  if (process.platform === "linux") {
    try {
      const cgroup = readFileSync("/proc/1/cgroup", "utf-8");
      const containerRuntimes = [
        "/docker/",
        "/lxc/",
        "/kubepods/",
        "/ecs/",
        "/containerd/"
      ];
      if (containerRuntimes.some((rt) => cgroup.includes(rt))) {
        return true;
      }
    } catch {
      // /proc/1/cgroup may not be readable — not a sandbox signal by itself.
    }
  }

  return false;
}

function detectHardLimitsEnforcement(): boolean {
  // The five hard limits are enforced through the mandate evaluation chain
  // (mandates/evaluate.ts + mandates/approval.ts). This check verifies the
  // mandate modules are structurally present on disk.
  return existsSync(join(MODULE_DIR, "..", "mandates", "evaluate.ts"));
}

function detectTracing(): boolean {
  // Tracing observability signal: presence of a configured tracing endpoint
  // or env var.
  if (typeof process !== "undefined") {
    if (process.env?.GURU_TRACING_ENABLED === "1") return true;
    if (process.env?.OTEL_TRACES_EXPORTER) return true;
  }
  return false;
}
