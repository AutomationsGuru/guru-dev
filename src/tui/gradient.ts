import { hexToRgb, type Painter } from "./theme.js";

/**
 * Gradient engine per spec §3: piecewise-linear interpolation in sRGB across
 * evenly-spaced stops; `t = col / (width − 1)` over the COLUMN INDEX OF THE WHOLE
 * BLOCK (same t for every row, so multi-row banners align hues vertically).
 * Spaces advance t but paint nothing.
 */

export function sampleGradient(stops: readonly string[], t: number): [number, number, number] {
  const clamped = Math.min(1, Math.max(0, t));
  if (stops.length === 1) {
    return hexToRgb(stops[0]!);
  }
  const scaled = clamped * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const local = scaled - index;
  const [r1, g1, b1] = hexToRgb(stops[index]!);
  const [r2, g2, b2] = hexToRgb(stops[index + 1]!);

  return [Math.round(r1 + (r2 - r1) * local), Math.round(g1 + (g2 - g1) * local), Math.round(b1 + (b2 - b1) * local)];
}

/** Paint a single-line string with a per-column gradient. */
export function gradientLine(painter: Painter, stops: readonly string[], text: string, blockWidth?: number): string {
  const width = Math.max(1, blockWidth ?? text.length);
  let out = "";
  for (let col = 0; col < text.length; col += 1) {
    const char = text[col]!;
    if (char === " ") {
      out += char;
      continue;
    }
    const [r, g, b] = sampleGradient(stops, width === 1 ? 0 : col / (width - 1));
    out += painter.hex(`#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`, char);
  }
  return out;
}

/** Paint a multi-row block: same t per column across all rows (§3). */
export function gradientBlock(painter: Painter, stops: readonly string[], lines: readonly string[]): string[] {
  const width = Math.max(1, ...lines.map((line) => line.length));

  return lines.map((line) => gradientLine(painter, stops, line, width));
}

/** Section divider: gradient rule of ─, or plain border color as fallback. */
export function gradientRule(painter: Painter, stops: readonly string[], width: number): string {
  if (painter.level === "none" || painter.level === "16") {
    return painter.fg("border", "─".repeat(width));
  }
  return gradientLine(painter, stops, "─".repeat(width), width);
}
