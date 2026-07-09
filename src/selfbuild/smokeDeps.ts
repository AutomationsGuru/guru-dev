import { runCapabilitySmoke } from "../readiness/capabilitySmoke.js";
import type { ReviewGateVerdict } from "../review/gates.js";
import { createHarnessRuntime } from "../runtime/session.js";
import type { SmokeStageDeps } from "./smokeStage.js";

/**
 * Assemble the live SMOKE deps (self-build P7): capability-smoke proves the harness NUCLEUS
 * still boots after a build, and a bounded self-call proves the session/tool path still
 * answers. Wired into `--run` so SMOKE actually runs instead of half-skipping.
 *
 * Default self-call is model-free: start a real session and execute a read-only tool
 * (repo.context.resolve). That proves the post-build harness can still serve work without
 * spending tokens. Callers can inject a full driveTurn when they want a model round-trip.
 */

export interface MakeSmokeDepsInput {
  readonly cwd?: string;
  readonly runCapabilitySmoke?: (options: { readonly cwd?: string }) => Promise<{ readonly verdict: ReviewGateVerdict }>;
  readonly selfCall?: (signal: AbortSignal) => Promise<unknown>;
  readonly timeoutMs?: number;
  /** When true, skip the default self-call (tests that only care about nucleus boot). */
  readonly skipSelfCall?: boolean;
}

/** Default SMOKE self-call: live session + one read-only tool. Honors abort. */
export async function defaultSmokeSelfCall(signal: AbortSignal, cwd?: string): Promise<void> {
  if (signal.aborted) {
    throw new Error("aborted before smoke self-call");
  }
  const runtime = createHarnessRuntime();
  const session = await runtime.startSession(cwd ? { cwd } : {});
  if (signal.aborted) {
    throw new Error("aborted during smoke self-call");
  }
  const observation = await runtime.executeTool(
    session.id,
    "repo.context.resolve",
    { includeContents: false },
    signal
  );
  if (observation.status === "failed") {
    throw new Error(observation.error ?? "smoke self-call tool failed");
  }
  if (signal.aborted) {
    throw new Error("aborted after smoke self-call");
  }
}

export function makeSmokeDeps(input: MakeSmokeDepsInput = {}): SmokeStageDeps {
  const smoke = input.runCapabilitySmoke ?? ((options) => runCapabilitySmoke(options));
  const selfCall =
    input.selfCall ??
    (input.skipSelfCall
      ? undefined
      : (signal: AbortSignal) => defaultSmokeSelfCall(signal, input.cwd));
  return {
    runSmoke: async () => {
      const report = await smoke(input.cwd ? { cwd: input.cwd } : {});
      return { verdict: report.verdict };
    },
    ...(selfCall ? { selfCall } : {}),
    // Default 60s is long for network shares — 30s keeps the cycle honest without hanging.
    timeoutMs: input.timeoutMs ?? 30_000
  };
}
