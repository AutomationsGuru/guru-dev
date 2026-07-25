/**
 * Completion gate-as-code: evaluate named predicate functions against an evidence bag.
 *
 * Lightweight, pure-TypeScript gate evaluation with no shell commands, no external
 * tools, and no model calls. Each gate is a predicate (evidence → boolean); the
 * harness runs them all and derives a GREEN / YELLOW / RED verdict from the results.
 *
 * This is the programmatic complement to the command-based gates in gates.ts —
 * useful when a gate condition is expressible as a pure function over structured
 * evidence rather than a shell command.
 */

/** A predicate function: receives the evidence bag, returns true when the gate passes. */
export type CompletionPredicate = (evidence: Record<string, unknown>) => boolean;

/** Verdict for a single gate or an aggregate report. */
export type CompletionGateVerdict = "GREEN" | "YELLOW" | "RED";

/** A named completion gate — a predicate plus metadata. */
export interface CompletionGate {
  readonly name: string;
  readonly predicate: CompletionPredicate;
  readonly required: boolean;
}

/** Result of evaluating a single gate against an evidence bag. */
export interface CompletionGateResult {
  readonly name: string;
  readonly passed: boolean;
  readonly required: boolean;
}

/** Aggregate report after running all gates. */
export interface CompletionGateReport {
  readonly verdict: CompletionGateVerdict;
  readonly results: readonly CompletionGateResult[];
  readonly passed: number;
  readonly failed: number;
  readonly summary: string;
}

/**
 * Evaluate every gate against the evidence bag and return an aggregate report.
 *
 * Each predicate runs inside a try/catch — a throwing predicate is treated as a
 * failed gate, never a crash. The verdict is RED when any required gate fails,
 * YELLOW when only optional gates fail or no gates are configured, and GREEN
 * only when every gate passes.
 *
 * @param gates  The gates to evaluate.
 * @param evidence  The evidence bag passed to each predicate.
 * @returns A report with per-gate results, counts, verdict, and a summary line.
 */
export function runGates(
  gates: readonly CompletionGate[],
  evidence: Record<string, unknown>
): CompletionGateReport {
  const results: CompletionGateResult[] = gates.map((gate) => {
    let passed: boolean;
    try {
      passed = gate.predicate(evidence);
    } catch {
      passed = false;
    }
    return { name: gate.name, passed, required: gate.required };
  });

  const failed = results.filter((r) => !r.passed).length;
  const passed = results.length - failed;
  const verdict = deriveVerdict(results);

  return {
    verdict,
    results,
    passed,
    failed,
    summary: `${verdict}: ${passed} gate(s) passed, ${failed} gate(s) failed.`
  };
}

function deriveVerdict(results: readonly CompletionGateResult[]): CompletionGateVerdict {
  if (results.length === 0) {
    return "YELLOW";
  }
  const failures = results.filter((r) => !r.passed);
  if (failures.some((r) => r.required)) {
    return "RED";
  }
  if (failures.length > 0) {
    return "YELLOW";
  }
  return "GREEN";
}
