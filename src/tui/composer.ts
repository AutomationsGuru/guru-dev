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
  // `columns` is the usable paint width (callers pass termWidth-1). Do not subtract
  // again — a double clamp left a visible gap on the right of the mode rule.
  const width = Math.max(8, columns);
  const label = modeLabel && modeLabel.length > 0 ? ` ${modeLabel} ` : "";
  const labelVisible = visibleWidth(label);
  const ruleWidth = Math.max(1, width - labelVisible);
  const rule = gradientRule(painter, [...painter.tokens.banner], ruleWidth);
  return labelVisible > 0 ? `${rule}${painter.fg("accent", label)}` : rule;
}

/** The hint line under the composer: available keys, muted. Left-aligned; trims to fit. */
export function composerHintLine(
  painter: Painter,
  extras: readonly string[] = [],
  columns?: number,
  busy = false
): string {
  const effectiveColumns = columns ?? process.stdout.columns ?? Number.POSITIVE_INFINITY;
  // esc interrupt is LIVE: mid-turn Esc/Ctrl+C abort the running agentSession.
  const base = busy
    ? ["esc/ctrl+c interrupt", "↵ steer", "ctrl+d exit"]
    : ["/ commands", "↵ run", "esc/ctrl+c interrupt", "ctrl+d exit"];
  const hints = [...base, ...extras];
  // The full row is ~130 cells with the composer extras — on narrower terminals
  // the paint-time clamp chopped it MID-WORD ("type+↵ ste…"). Drop whole
  // trailing hints instead so what shows is always readable.
  const budget = Math.max(16, effectiveColumns - 1);
  const kept: string[] = [];
  let used = 2; // leading indent
  for (const hint of hints) {
    const width = visibleWidth(hint) + (kept.length > 0 ? 3 : 0); // " · "
    if (used + width > budget) {
      break;
    }
    kept.push(hint);
    used += width;
  }
  return painter.fg("fgFaint", `  ${(kept.length > 0 ? kept : hints.slice(0, 1)).join(" · ")}`);
}
