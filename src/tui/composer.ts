import { gradientRule } from "./gradient.js";
import { visibleWidth } from "./components.js";
import type { Painter } from "./theme.js";

/**
 * Composer chrome (TUI polish → composer, 2026-07-04): the framing around the
 * input — a top rule with a right-justified mode label (Claude-style), and the
 * hint line under the pinned status bar. Pure render (no I/O); the controller in
 * guru.ts draws them below the input with the verified relative-move overlay
 * technique (no DECSC/DECRC), so they stay pinned and reflow on resize.
 */

/**
 * The top rule above the input: a full-width gradient rule with a mode label
 * right-justified on it (e.g. "▸ scout · YOLO"). Spans the whole terminal width.
 */
export function composerTopRule(painter: Painter, columns: number, modeLabel?: string): string {
  const width = Math.max(8, columns);
  const label = modeLabel && modeLabel.length > 0 ? ` ${modeLabel} ` : "";
  const labelVisible = visibleWidth(label);
  const ruleWidth = Math.max(1, width - labelVisible);
  const rule = gradientRule(painter, [...painter.tokens.banner], ruleWidth);
  return labelVisible > 0 ? `${rule}${painter.fg("accent", label)}` : rule;
}

/** The hint line under the composer: available keys, muted. Full-width, left-aligned. */
export function composerHintLine(painter: Painter, extras: readonly string[] = []): string {
  // esc interrupt is LIVE: mid-turn Esc/Ctrl+C abort the running agentSession.
  const hints = ["/ commands", "↵ run", "esc/ctrl+c interrupt", "ctrl+d exit", ...extras];
  return painter.fg("fgFaint", `  ${hints.join(" · ")}`);
}
