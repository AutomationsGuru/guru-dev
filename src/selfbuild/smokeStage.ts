import type { ReviewGateVerdict } from "../review/gates.js";

/**
 * SMOKE stage (self-build P2): after a build, prove the harness NUCLEUS still boots
 * (capability smoke) AND make one real self-call (an AgentSession.driveTurn against the
 * new code). Both are bounded by a per-task timeout so a build-introduced infinite loop
 * is ABORTED and recorded as a blocker, never a hang. The smoke runner + self-call are
 * injected by the caller (P7 wires the real capabilitySmoke + driveTurn).
 */

export type SelfCallOutcome = "ok" | "timeout" | "error" | "skipped";

export interface SmokeStageResult {
  readonly verdict: ReviewGateVerdict;
  readonly smokeVerdict: ReviewGateVerdict;
  readonly selfCall: SelfCallOutcome;
  readonly summary: string;
}

export interface SmokeStageDeps {
  /** Capability smoke — the nucleus must still boot. Returns its verdict. */
  readonly runSmoke: () => Promise<{ readonly verdict: ReviewGateVerdict }>;
  /** One real self-call against the new code (a driveTurn). Should honor the abort signal. */
  readonly selfCall?: (signal: AbortSignal) => Promise<unknown>;
  /** Per-task ceiling; the stage ALWAYS returns within this even if the self-call ignores the signal. */
  readonly timeoutMs?: number;
}

export async function runSmokeStage(deps: SmokeStageDeps): Promise<SmokeStageResult> {
  const smoke = await deps.runSmoke();
  if (smoke.verdict === "RED") {
    return { verdict: "RED", smokeVerdict: smoke.verdict, selfCall: "skipped", summary: "SMOKE RED — the harness nucleus no longer boots." };
  }

  if (!deps.selfCall) {
    return { verdict: smoke.verdict, smokeVerdict: smoke.verdict, selfCall: "skipped", summary: `SMOKE ${smoke.verdict} — nucleus boots (no self-call wired).` };
  }

  const controller = new AbortController();
  // Race the self-call against the timeout so a hang is BOUNDED even if the call ignores
  // the abort signal — the stage still returns within timeoutMs.
  const outcome = await Promise.race<SelfCallOutcome>([
    deps.selfCall(controller.signal).then(
      () => "ok" as const,
      () => (controller.signal.aborted ? "timeout" : "error")
    ),
    new Promise<SelfCallOutcome>((resolve) => {
      setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, deps.timeoutMs ?? 60_000);
    })
  ]);

  if (outcome === "ok") {
    return { verdict: smoke.verdict, smokeVerdict: smoke.verdict, selfCall: "ok", summary: `SMOKE ${smoke.verdict} — nucleus boots + self-call returned.` };
  }
  const reason = outcome === "timeout" ? "the self-call hung past the timeout (aborted)" : "the self-call errored";
  return { verdict: "RED", smokeVerdict: smoke.verdict, selfCall: outcome, summary: `SMOKE RED — ${reason}.` };
}
