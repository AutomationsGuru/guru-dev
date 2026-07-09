import { gradientLine } from "./gradient.js";
import type { Painter, ThemeTokens } from "./theme.js";

/** Component recipes per spec §5. */

export const GLYPHS = {
  ok: "✓",
  fail: "✖",
  warn: "!",
  running: "●",
  pending: "◌",
  user: "▸",
  agent: "▲"
} as const;

/**
 * Display width of one code point: 0 for combining/zero-width, 2 for wide
 * (CJK/emoji), else 1. Mirrors editor.ts charDisplayWidth — kept local to avoid a
 * circular import (editor.ts imports visibleWidth from here).
 */
function charDisplayWidth(codePoint: number): number {
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) || // combining diacritics
    (codePoint >= 0x200b && codePoint <= 0x200f) || // zero-width space/joiners/marks
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || // variation selectors
    codePoint === 0xfeff // zero-width no-break space (BOM)
  ) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) || // CJK radicals … Yi
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compat ideographs
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK compat forms
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // fullwidth forms
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) || // emoji blocks
    (codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK ext B+
  ) {
    return 2;
  }
  return 1;
}

/**
 * Visible width of a string with ANSI escapes stripped, counted in DISPLAY
 * cells (CJK/emoji = 2) — not UTF-16 code units. The status bar gap math, box
 * padding, and table column widths all depend on this matching what the
 * terminal actually draws (review 2026-07-08: the old `.length` overflowed the
 * edge by one cell per wide char and wrapped the pinned status bar).
 */
export function visibleWidth(text: string): number {
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/\x1b\[[0-9;]*m/gu, "");
  let width = 0;
  for (const char of stripped) {
    width += charDisplayWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

export type BadgeKind = "brand" | "success" | "warning" | "error" | "ghost";

/** ` LABEL ` badge — 1-space padding, bold, uppercase (§5). */
export function badge(painter: Painter, label: string, kind: BadgeKind = "brand"): string {
  const text = ` ${label.toUpperCase()} `;
  if (kind === "ghost" || painter.level === "none") {
    return painter.fg("muted", `[${label.toUpperCase()}]`);
  }
  const map: Record<Exclude<BadgeKind, "ghost">, { bg: keyof ThemeTokens; fg: keyof ThemeTokens }> = {
    brand: { bg: "badgeBg", fg: "badgeFg" },
    success: { bg: "success", fg: "badgeFgOnColor" },
    warning: { bg: "warning", fg: "badgeFgOnColor" },
    error: { bg: "error", fg: "badgeFg" }
  };
  const { bg, fg } = map[kind];

  return painter.bold(painter.bg(bg, text, fg));
}

/** Rounded box (§5): `╭─╮ │ ╰─╯` in border; optional inline title, muted bold. */
export function roundedBox(painter: Painter, lines: readonly string[], options: { title?: string; width?: number; focused?: boolean } = {}): string[] {
  const contentWidth = Math.max(options.width ?? 0, ...lines.map(visibleWidth), options.title ? visibleWidth(options.title) + 4 : 0);
  const borderToken: keyof ThemeTokens = options.focused ? "accent" : "border";
  const edge = (text: string): string => painter.fg(borderToken, text);
  // Title row chrome: "╭─ " + title + " " + dashes + "╮" must total contentWidth + 4.
  const title = options.title
    ? `${edge("╭─ ")}${painter.bold(painter.fg("muted", options.title))}${edge(` ${"─".repeat(Math.max(0, contentWidth - visibleWidth(options.title) - 1))}╮`)}`
    : edge(`╭${"─".repeat(contentWidth + 2)}╮`);

  return [
    title,
    ...lines.map((line) => `${edge("│")} ${line}${" ".repeat(Math.max(0, contentWidth - visibleWidth(line)))} ${edge("│")}`),
    edge(`╰${"─".repeat(contentWidth + 2)}╯`)
  ];
}

export interface TableColumn {
  readonly header: string;
  /** Right-pad target; computed from data when omitted. */
  readonly width?: number;
}

/**
 * Table per §5: header bold fgBright, one border rule under it, no verticals;
 * zebra via dim on alternate rows.
 */
export function renderTable(painter: Painter, columns: readonly TableColumn[], rows: readonly (readonly string[])[], options: { zebra?: boolean } = {}): string[] {
  const widths = columns.map((column, index) =>
    Math.max(column.width ?? 0, visibleWidth(column.header), ...rows.map((row) => visibleWidth(row[index] ?? "")))
  );
  const pad = (text: string, width: number): string => `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
  const headerLine = columns.map((column, index) => painter.bold(painter.fg("fgBright", pad(column.header, widths[index]!)))).join("  ");
  const ruleLine = painter.fg("border", widths.map((width) => "─".repeat(width)).join("──"));
  const body = rows.map((row, rowIndex) => {
    const line = row.map((cell, index) => pad(cell, widths[index]!)).join("  ");
    return options.zebra && rowIndex % 2 === 1 ? painter.dim(line) : line;
  });

  return [headerLine, ruleLine, ...body];
}

/** Key-hint row (§5): key on bgSelect chip in fgBright, label muted. */
export function keyHints(painter: Painter, hints: readonly { key: string; label: string }[]): string {
  return hints
    .slice(0, 6)
    .map((hint) => `${painter.bg("bgSelect", painter.fg("fgBright", ` ${hint.key} `))} ${painter.fg("muted", hint.label)}`)
    .join("   ");
}

/** Spinner per §6: braille frames @80ms, color breathing through the brand ramp. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_RAMP = ["#F73B4A", "#D12C81", "#8C11E1", "#B56EF1", "#8C11E1", "#D12C81"] as const;

export function spinnerFrame(painter: Painter, tick: number): string {
  const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
  const color = SPINNER_RAMP[Math.floor(tick / 2) % SPINNER_RAMP.length]!;

  return painter.hex(color, frame);
}

/** Compact inline mark (§4): `▲ guru harness` — never re-typeset the wordmark. */
export function compactMark(painter: Painter): string {
  const harness = gradientLine(painter, ["#C7288F", "#B56EF1"], "harness");

  return `${painter.hex("#C7288F", "▲")} ${painter.bold(painter.fg("fgBright", "guru"))} ${harness}`;
}
