import { streamBootEvents, type BootEvent } from "../boot/bootEvents.js";
import type { HeadlessBootRitualInput } from "../boot/headless.js";
import { incrementSessionCounter, type SessionCounterOptions } from "../boot/sessionCounter.js";
import { getRuntimeInfo } from "../index.js";

/**
 * Headless boot mode (Headless JSON Events wave).
 *
 * `guru --mode boot` runs the enforced boot ritual once and publishes its result
 * as a bounded stream of LF-delimited JSON events to stdout: one `boot.phase`
 * event per canonical phase (in order), then a terminal `boot.report`. No banner,
 * no TUI, no REPL — a machine-readable observability surface for CI and
 * orchestrators that need the same five-phase boot the interactive runtime runs.
 *
 * Ownership (mirrors the rpc.ts lane split):
 * - This module owns: gathering the headless phase data (cwd, runtime identity,
 *   session number), invoking `incrementSessionCounter` once, framing each event
 *   as a single JSON line on the sink, and a clean exit.
 * - It depends ONLY on the documented exports of `boot/bootEvents.js`,
 *   `boot/sessionCounter.js`, and `getRuntimeInfo`.
 * - It does NOT own phase order, evidence allowlists, or the ritual itself
 *   (those live in `boot/headless.js` / `boot/ritual.js`).
 *
 * Secrecy: the headless ritual never copies cwd-derived secrets into evidence;
 * this surface only forwards the validated event objects the ritual produced.
 */

export interface BootModeOptions {
  /** Override the boot session counter (tests). Defaults to the home-counter. */
  readonly sessionCounter?: SessionCounterOptions;
  /** Override the persisted session number (tests) — skips the counter increment. */
  readonly sessionNumber?: number;
  /** Dry-run flag forwarded to the ritual (skips the baseline health probe). */
  readonly dryRun?: boolean;
  /** Working directory asserted by the kernel phase. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Writable sink for NDJSON events. Defaults to `process.stdout`. */
  readonly output?: NodeJS.WritableStream;
  /**
   * Test seam that builds the ritual input from gathered state. Production callers
   * omit it; the default builder below is used. Lets tests inject `phaseData`,
   * `workDeclaration`, `baselineHealth`, and `ritualRunner` without re-deriving them.
   */
  readonly buildInput?: (state: BootModeState) => HeadlessBootRitualInput;
}

export interface BootModeState {
  readonly sessionNumber: number;
  readonly dryRun: boolean;
  readonly cwd?: string;
  readonly runtimeVersion: string;
}

function defaultBuildInput(state: BootModeState): HeadlessBootRitualInput {
  // The headless ritual's machine identity is the lowercase literal `guruharness`
  // (HeadlessPhaseDataSchema), distinct from the human display name `GuruHarness`.
  // `runtimeVersion` is the package semver, which the schema also constrains.
  return {
    ...(state.cwd !== undefined ? { cwd: state.cwd } : {}),
    sessionNumber: state.sessionNumber,
    dryRun: state.dryRun,
    phaseData: {
      kernel: {
        runtimeName: "guruharness",
        runtimeVersion: state.runtimeVersion,
        resolverReady: Boolean(state.cwd)
      }
    }
  };
}

/** Run the headless boot mode and stream its events as NDJSON on the sink. */
export async function runBootMode(options: BootModeOptions = {}): Promise<void> {
  const output = options.output ?? process.stdout;
  const emit = (event: BootEvent): void => {
    output.write(`${JSON.stringify(event)}\n`);
  };

  const info = getRuntimeInfo();
  const sessionNumber =
    options.sessionNumber ?? incrementSessionCounter(options.sessionCounter ?? {});
    options.sessionNumber ?? incrementSessionCounter(options.sessionCounter ?? {});
  const state: BootModeState = {
    sessionNumber,
    dryRun: options.dryRun ?? false,
    cwd: options.cwd ?? process.cwd(),
    runtimeVersion: info.version
  };
  const buildInput = options.buildInput ?? defaultBuildInput;
  streamBootEvents(buildInput(state), emit);
}
