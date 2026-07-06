import { runCapabilitySmoke } from "../readiness/capabilitySmoke.js";
import type { ReviewGateVerdict } from "../review/gates.js";
import type { SmokeStageDeps } from "./smokeStage.js";

/**
 * Assemble the live SMOKE deps (self-build P7): capability-smoke proves the harness NUCLEUS
 * still boots after a build, and an optional bounded self-call (a driveTurn) proves the new
 * code answers. Wired into `--run` so SMOKE actually runs instead of degrading to YELLOW.
 * capability-smoke is injectable for tests.
 */

export interface MakeSmokeDepsInput {
  readonly cwd?: string;
  readonly runCapabilitySmoke?: (options: { readonly cwd?: string }) => Promise<{ readonly verdict: ReviewGateVerdict }>;
  readonly selfCall?: (signal: AbortSignal) => Promise<unknown>;
  readonly timeoutMs?: number;
}

export function makeSmokeDeps(input: MakeSmokeDepsInput = {}): SmokeStageDeps {
  const smoke = input.runCapabilitySmoke ?? ((options) => runCapabilitySmoke(options));
  return {
    runSmoke: async () => {
      const report = await smoke(input.cwd ? { cwd: input.cwd } : {});
      return { verdict: report.verdict };
    },
    ...(input.selfCall ? { selfCall: input.selfCall } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {})
  };
}
