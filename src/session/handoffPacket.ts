import { scrubSecretValues } from "../safety/secretSafety.js";

import type { CompactionState } from "../compaction/schemas.js";
import { z } from "zod";

/**
 * Session handoff packet (idea F311): when context pressure crosses a threshold,
 * render a compact markdown packet the operator (or the next session) can apply.
 *
 * This module is pure orchestration — no I/O, no wall clock, no network. The
 * caller injects `now`, the connected route's context window, and the latest
 * compaction residual (if any). It composes with the compaction engine's
 * `CompactionState` so a packet never loses what the runtime already folded.
 *
 * Operator-gated by construction: `apply` only returns the inject text. It does
 * not auto-continue a session. Auto-continue requires an explicit operator
 * decision (see PLAN exclusions) and is owned outside this module.
 */

/** Fraction of the context window at/above which a packet is generated. */
export const DEFAULT_HANDOFF_PRESSURE_THRESHOLD = 0.85;

/** Cap the rendered packet so an apply-inject can never itself overflow context. */
export const MAX_HANDOFF_PACKET_CHARS = 8_000;

export const HandoffPacketConfigSchema = z
  .object({
    /** Master switch. false = maybeGenerate always returns null. */
    enabled: z.boolean().default(true),
    /** Context pressure fraction in (0, 1] that triggers a packet. */
    contextPressureThreshold: z.number().positive().max(1).default(DEFAULT_HANDOFF_PRESSURE_THRESHOLD),
    /** Hard cap on the rendered markdown body (apply-inject safety). */
    maxPacketChars: z.number().int().positive().default(MAX_HANDOFF_PACKET_CHARS)
  })
  .strict();
export type HandoffPacketConfig = z.infer<typeof HandoffPacketConfigSchema>;

export const HandoffPacketSchema = z
  .object({
    /** ISO timestamp from the injected clock — never wall clock inside the module. */
    generatedAt: z.string().trim().min(1),
    /** lastInputTokens / contextWindowTokens, clamped to [0, 1]. */
    contextPressure: z.number().min(0).max(1),
    /** The scrubbed, capped markdown body to inject. */
    summary: z.string().min(1)
  })
  .strict();
export type HandoffPacket = z.infer<typeof HandoffPacketSchema>;

/** Inputs the caller supplies from the live session; all optional-safe fields. */
export interface HandoffContext {
  readonly config: HandoffPacketConfig;
  /** Connected route's context window, or undefined if unknown. */
  readonly contextWindowTokens: number | undefined;
  /** Most recent request's input token count from the route's usage. */
  readonly lastInputTokens: number;
  /** Latest compaction residual, if the runtime has folded history already. */
  readonly compaction?: CompactionState;
  /** Free-text operator focus to carry across the handoff (e.g. current goal). */
  readonly focusNote?: string;
  /** Clock injection — the REPL wires real time; tests wire a fake. */
  readonly now: () => Date;
}

/** Context pressure as a [0,1] fraction; 0 when the window is unknown. */
export function computeContextPressure(input: {
  readonly contextWindowTokens: number | undefined;
  readonly lastInputTokens: number;
}): number {
  if (input.contextWindowTokens === undefined || input.contextWindowTokens <= 0) {
    return 0;
  }
  if (input.lastInputTokens <= 0) {
    return 0;
  }
  return Math.min(1, input.lastInputTokens / input.contextWindowTokens);
}

/** True when packets are enabled and pressure has reached the threshold. */
export function shouldGenerateHandoff(input: {
  readonly config: HandoffPacketConfig;
  readonly contextWindowTokens: number | undefined;
  readonly lastInputTokens: number;
}): boolean {
  if (!input.config.enabled) {
    return false;
  }
  const pressure = computeContextPressure(input);
  return pressure >= input.config.contextPressureThreshold;
}

/** Render the markdown body — compaction residual first, then operator focus. */
function renderSummary(ctx: HandoffContext): string {
  const sections: string[] = [];

  const residual = ctx.compaction?.summary?.trim();
  if (residual && residual.length > 0) {
    sections.push(`## Compaction residual\n\n${residual}`);
  }

  const focus = ctx.focusNote?.trim();
  if (focus && focus.length > 0) {
    sections.push(`## Operator focus\n\n${focus}`);
  }

  // A packet with no residual and no focus still carries the pressure signal so
  // the apply side has *something* honest to inject rather than an empty body.
  if (sections.length === 0) {
    sections.push("## Status\n\nContext pressure crossed the handoff threshold; no compaction residual or operator focus was supplied.");
  }

  return sections.join("\n\n");
}

/**
 * Generate a handoff packet when context pressure is at/above the threshold.
 * Returns null when disabled or below threshold — the caller treats null as
 * "no packet this turn."
 */
export function maybeGenerateHandoff(ctx: HandoffContext): HandoffPacket | null {
  if (!shouldGenerateHandoff(ctx)) {
    return null;
  }
  const pressure = computeContextPressure(ctx);
  const body = scrubSecretValues(renderSummary(ctx));
  const capped =
    body.length <= ctx.config.maxPacketChars
      ? body
      : `${body.slice(0, ctx.config.maxPacketChars)}\n[… packet truncated at ${ctx.config.maxPacketChars} chars …]`;

  // A packet must never carry an empty body across a handoff — that would let
  // an apply silently inject nothing while claiming a handoff happened.
  if (capped.trim().length === 0) {
    return null;
  }

  return HandoffPacketSchema.parse({
    generatedAt: ctx.now().toISOString(),
    contextPressure: pressure,
    summary: capped
  });
}

/** Prefix the apply path recognizes (and can later replace) on re-apply. */
export const HANDOFF_INJECT_PREFIX = "[session handoff]";

/**
 * Render the text an apply step prepends to the next session's context.
 * Pure: returns the string only. The session owner decides whether/when to
 * inject it — there is no auto-continue without the operator here.
 */
export function applyHandoff(packet: HandoffPacket): string {
  const validated = HandoffPacketSchema.parse(packet);
  const pct = Math.round(validated.contextPressure * 100);
  return `${HANDOFF_INJECT_PREFIX} (${pct}% context pressure @ ${validated.generatedAt})\n${validated.summary.trim()}`;
}
