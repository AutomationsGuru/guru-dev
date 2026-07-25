/**
 * instructionFadeDetector — pure-functional threshold check that decides when
 * a system/mandate reminder should be reinjected because the operator's last
 * inject has "faded" past either a turn budget or a token budget.
 *
 * Composition note (F133 ↔ F107): the detector is intentionally decoupled
 * from the F107 reminder payload/policy. F107 (system reminders) decides WHAT
 * to say and HOW to phrase it; this module decides WHETHER a reminder is due
 * given the counters kept by the session loop. Callers compute `turnsSince` /
 * `tokensSince` from their own authoritative counters, call `shouldRemind`,
 * and on a true result inject via F107 and then call `markReminded` to reset
 * the state. If F107 is absent, callers may ignore the detector — it remains
 * a passive predicate with no runtime side effects.
 *
 * Pure module: no imports from `node:fs`, `mandates/`, or any runtime source.
 * `shouldRemind` is a pure function over its args; `markReminded` returns a
 * new state object rather than mutating.
 */

export type FadeThresholds = {
  readonly turns: number;
  readonly tokens: number;
};

export type FadeState = {
  readonly lastRemindedTurn: number;
  readonly lastRemindedTokens: number;
};

export type FadeReminderInput = {
  readonly turnsSince: number;
  readonly tokensSince: number;
  readonly thresholds?: FadeThresholds;
};

export const DEFAULT_FADE_THRESHOLDS: FadeThresholds = {
  turns: 10,
  tokens: 4000
};

export function createFadeState(input: {
  readonly turn: number;
  readonly tokens: number;
}): FadeState {
  return {
    lastRemindedTurn: input.turn,
    lastRemindedTokens: input.tokens
  };
}

export function shouldRemind(input: FadeReminderInput): boolean {
  const thresholds = input.thresholds ?? DEFAULT_FADE_THRESHOLDS;
  if (input.turnsSince < 0 || input.tokensSince < 0) return false;
  return input.turnsSince >= thresholds.turns || input.tokensSince >= thresholds.tokens;
}

export function markReminded(state: FadeState, input: { readonly turn: number; readonly tokens: number }): FadeState {
  return {
    lastRemindedTurn: input.turn,
    lastRemindedTokens: input.tokens
  };
}