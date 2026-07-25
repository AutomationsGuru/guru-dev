import { z } from "zod";

// ── Schemas ──────────────────────────────────────────────────────────────────

const QualityGateStatusSchema = z.enum(["pass", "fail", "skip"]);

export const QualityGateCheckSchema = z.object({
  name: z.string().min(1),
  status: QualityGateStatusSchema,
  reason: z.string().optional()
});

export const QualityGateChecklistSchema = z.object({
  checks: z.array(QualityGateCheckSchema).min(1)
});

// ── Derived types ────────────────────────────────────────────────────────────

export type QualityGateStatus = z.infer<typeof QualityGateStatusSchema>;
export type QualityGateCheck = z.infer<typeof QualityGateCheckSchema>;
export type QualityGateChecklist = z.infer<typeof QualityGateChecklistSchema>;

// ── Result types ─────────────────────────────────────────────────────────────

/** Pure evaluation result of a quality gate checklist. */
export interface QualityGateResult {
  readonly mayProceed: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly total: number;
  readonly summary: string;
}

// ── Evaluate ─────────────────────────────────────────────────────────────────

/**
 * Pure, deterministic evaluate of a quality gate checklist.
 *
 * - Every check is named with a `pass | fail | skip` status.
 * - `mayProceed` is `true` only when zero checks have `fail`.
 * - `skip` never blocks — it is explicitly neutral.
 *
 * The input is validated through Zod; invalid shape throws.
 */
export function evaluate(checks: readonly QualityGateCheck[]): QualityGateResult {
  const parsed = QualityGateChecklistSchema.parse({ checks: [...checks] });

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const check of parsed.checks) {
    switch (check.status) {
      case "pass":
        passed += 1;
        break;
      case "fail":
        failed += 1;
        break;
      case "skip":
        skipped += 1;
        break;
    }
  }

  const total = parsed.checks.length;
  const mayProceed = failed === 0;

  const summary =
    total === 0
      ? "No checks — proceed."
      : mayProceed
        ? `All ${total} check(s) clear (${passed} passed, ${skipped} skipped) — proceed.`
        : `${failed} of ${total} check(s) failed — blocked.`;

  return { mayProceed, passed, failed, skipped, total, summary };
}
