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

/** Visible width of a string with ANSI escapes stripped. */
export function visibleWidth(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/gu, "").length;
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
  const contentWidth = Math.max(options.width ?? 0, ...lines.map(visibleWidth), options.title ? options.title.length + 4 : 0);
  const borderToken: keyof ThemeTokens = options.focused ? "accent" : "border";
  const edge = (text: string): string => painter.fg(borderToken, text);
  // Title row chrome: "╭─ " + title + " " + dashes + "╮" must total contentWidth + 4.
  const title = options.title
    ? `${edge("╭─ ")}${painter.bold(painter.fg("muted", options.title))}${edge(` ${"─".repeat(Math.max(0, contentWidth - options.title.length - 1))}╮`)}`
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
