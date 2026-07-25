import { z } from "zod";

/**
 * Telemetry sharing policy (Work ID IDEA-F563-TELE-01: "Telemetry default-off
 * policy — share_crew style sharing requires explicit opt-in; default false").
 *
 * GuruHarness is a private, operator-owned agent harness. Any egress of crew /
 * telemetry data ("share_crew"-style sharing) is a trust boundary: the default
 * must be silence. This module encodes that as a PURE, FAIL-CLOSED policy —
 * sharing turns on ONLY when the operator has explicitly and validly opted in.
 * A missing, partial, or malformed config can never accidentally open the door.
 *
 * Two independent gates, both defaulting to false, must BOTH be true to share:
 *   - `enabled`   — the telemetry subsystem is switched on at all.
 *   - `shareCrew` — crew-style data specifically is authorized to leave.
 * Requiring both means a stray `shareCrew: true` in a config where telemetry was
 * never enabled still shares nothing, and vice versa — defense in depth against
 * a single mis-set flag causing silent data egress.
 */

/**
 * Telemetry sharing configuration. `.strict()` so an unknown/typo'd key is a
 * parse failure rather than a silently-ignored field — a misspelled gate must
 * never leave sharing at its (unsafe-looking) intended value.
 */
export const TelemetrySharingConfigSchema = z
  .object({
    /**
     * Master switch for the telemetry subsystem. Defaults to false: telemetry is
     * off until the operator turns it on. This is the outer gate.
     */
    enabled: z.boolean().default(false),
    /**
     * Explicit authorization for "share_crew"-style crew/telemetry sharing —
     * the actual data-egress opt-in. Defaults to false: no sharing without a
     * deliberate, typed `true`. This is the inner gate.
     */
    shareCrew: z.boolean().default(false)
  })
  .strict();

export type TelemetrySharingConfig = z.infer<typeof TelemetrySharingConfigSchema>;

/**
 * The canonical default: everything off. Parsed from `{}` so the schema's own
 * defaults are the single source of truth for "safe defaults".
 */
export const DEFAULT_TELEMETRY_SHARING_CONFIG: TelemetrySharingConfig = TelemetrySharingConfigSchema.parse({});

/**
 * Fail-closed predicate: may this harness share crew/telemetry data right now?
 *
 * Accepts `unknown` on purpose — callers pass a slice of the loosely-typed
 * harness config, which may be undefined, null, a partial object, or (from a
 * corrupt/hand-edited file) outright garbage. Every ambiguous, absent, or
 * invalid input resolves to `false`. It NEVER throws for ordinary bad input:
 * a broken config must degrade to "share nothing", not crash the turn.
 *
 * Returns true ONLY when a valid config explicitly sets BOTH gates to true.
 */
export function mayShare(config?: unknown): boolean {
  // try/catch AND safeParse: malformed input becomes a "no", never an exception.
  // The try/catch keeps the fail-closed guarantee independent of zod internals —
  // even an exotic input (e.g. an object with a throwing getter) degrades to
  // "share nothing" rather than propagating an error into the caller's turn.
  try {
    const parsed = TelemetrySharingConfigSchema.safeParse(config ?? {});
    if (!parsed.success) {
      // Unknown keys (.strict), wrong types, or non-object garbage → fail closed.
      return false;
    }
    // Both gates required: the subsystem must be on AND crew sharing authorized.
    return parsed.data.enabled === true && parsed.data.shareCrew === true;
  } catch {
    return false;
  }
}
