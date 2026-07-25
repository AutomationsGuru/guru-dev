/**
 * TUI screen-buffer preference — pure resolver (IDEA-F377-ALTSCREEN-01).
 *
 * GuruHarness renders its TUI in one of two terminal modes:
 *   - `inline`     — render inline in the current scrollback (default; non-destructive,
 *                    the operator keeps their history and shell output).
 *   - `altScreen`  — render on the terminal's alternate screen buffer (fullscreen,
 *                    restored on exit, scrollback hidden while active).
 *
 * The chosen mode is a *preference*, not behavior: this module owns only the
 * resolution rule (operator decisions win over file config). It performs no I/O
 * and touches no terminal escape codes — those belong to the renderer. Keeping
 * this pure lets it be unit-tested without a TTY and lets the operator override
 * a file preference from the command line without editing config.
 */

/**
 * Where the TUI renders. Lowercase, hyphen-free tokens so they serialize
 * cleanly into config files and CLI flags.
 */
export type ScreenBufferMode = "inline" | "altScreen";

/** The set of valid mode tokens, for validation without a zod import. */
export const SCREEN_BUFFER_MODES: readonly ScreenBufferMode[] = ["inline", "altScreen"] as const;

/**
 * Inputs to {@link resolveScreenBufferPreference}.
 *
 * `pref` is the operator's durable preference from config (may be absent if
 * unset). `cliFlag` is a one-shot override supplied on the command line (may be
 * absent). Either may carry an invalid token; the resolver never throws for a
 * bad token — it falls back to the default rather than blocking boot.
 */
export interface ResolveScreenBufferInput {
  /** Config-file preference, if any. `undefined`/`null` means "not configured". */
  readonly pref?: ScreenBufferMode | string | null | undefined;
  /** CLI override, if any. `undefined`/`null` means "no flag passed". */
  readonly cliFlag?: ScreenBufferMode | string | null | undefined;
}

/**
 * Default mode when neither the CLI flag nor a valid config preference applies.
 *
 * `inline` is the safe, non-destructive default: it preserves the operator's
 * scrollback and never seizes the terminal, which matches a bare boot that knows
 * it should not destroy what is already on screen (hard limit 1: no destruction
 * without preservation). Operators who want fullscreen opt in explicitly.
 */
export const DEFAULT_SCREEN_BUFFER_MODE: ScreenBufferMode = "inline";

/** True iff `value` is one of the recognized {@link ScreenBufferMode} tokens. */
export function isScreenBufferMode(value: unknown): value is ScreenBufferMode {
  return typeof value === "string" && (SCREEN_BUFFER_MODES as readonly string[]).includes(value);
}

/**
 * Resolve the effective screen-buffer mode.
 *
 * Precedence, highest first:
 *   1. CLI flag  — when the operator passes `--screen-buffer`, their decision
 *                  wins outright (operator-override: obey the decision, never
 *                  silently route around it). An invalid CLI token is ignored
 *                  rather than honored, so a typo cannot silently flip modes.
 *   2. Config pref — the durable file preference, when it is a valid token.
 *   3. Default     — {@link DEFAULT_SCREEN_BUFFER_MODE}.
 *
 * Invalid tokens (either source) never throw and never block boot: they are
 * skipped and the next-lower precedence applies. This keeps a malformed config
 * or a misspelled flag from dead-ending startup (never-stuck), at the cost of a
 * caller-visible signal via {@link ResolveScreenBufferResult.invalidInput}.
 *
 * @returns the chosen mode plus a short audit trail of what was honored.
 */
export interface ResolveScreenBufferResult {
  /** The mode the renderer should use. */
  readonly mode: ScreenBufferMode;
  /**
   * Which source the result came from: `"cli"` (flag honored), `"pref"`
   * (config honored), or `"default"` (no valid input). Purely informational.
   */
  readonly source: "cli" | "pref" | "default";
  /**
   * Any input token that was present but rejected as invalid, surfaced so a
   * caller can warn the operator that a typo/config error was ignored. Empty
   * when all inputs were valid or absent.
   */
  readonly invalidInput: ScreenBufferMode[];
}

/**
 * Resolve the effective screen-buffer mode from a config preference and an
 * optional CLI override. CLI wins over file; invalid tokens fall through to the
 * default instead of blocking boot.
 *
 * @example
 *   resolveScreenBufferPreference({ cliFlag: "inline", pref: "altScreen" })
 *     // → { mode: "inline", source: "cli", invalidInput: [] }
 *   resolveScreenBufferPreference({ pref: "altScreen" })
 *     // → { mode: "altScreen", source: "pref", invalidInput: [] }
 *   resolveScreenBufferPreference({})
 *     // → { mode: "inline", source: "default", invalidInput: [] }
 */
export function resolveScreenBufferPreference(
  input: ResolveScreenBufferInput = {}
): ResolveScreenBufferResult {
  const cliFlag = input.cliFlag ?? undefined;
  const pref = input.pref ?? undefined;

  const invalidInput: ScreenBufferMode[] = [];

  // 1. CLI override wins. An invalid CLI token is collected (so the caller can
  //    warn the operator) but NOT honored — a typo must not silently flip modes.
  if (cliFlag !== undefined) {
    if (isScreenBufferMode(cliFlag)) {
      return { mode: cliFlag, source: "cli", invalidInput };
    }
    invalidInput.push(cliFlag as ScreenBufferMode);
  }

  // 2. Durable config preference, when valid.
  if (pref !== undefined) {
    if (isScreenBufferMode(pref)) {
      return { mode: pref, source: "pref", invalidInput };
    }
    invalidInput.push(pref as ScreenBufferMode);
  }

  // 3. Safe, non-destructive default.
  return { mode: DEFAULT_SCREEN_BUFFER_MODE, source: "default", invalidInput };
}
