/**
 * Minimal ANSI escape helpers + theme token map (Dev 4 / D4.1).
 *
 * Dependency-free. Used by the renderer to colorize panes. A real terminal backend
 * (D4.1) writes these codes to stdout in raw mode; tests assert on the composed
 * frame strings.
 */

export interface AnsiTheme {
  readonly reset: string;
  readonly dim: string;
  readonly bold: string;
  readonly fg: Readonly<Record<string, string>>;
}

const sgr = (code: number): string => `\x1b[${code}m`;

export const DEFAULT_ANSI_THEME: AnsiTheme = {
  reset: sgr(0),
  dim: sgr(2),
  bold: sgr(1),
  fg: {
    default: sgr(39),
    bright: sgr(97),
    green: sgr(32),
    yellow: sgr(33),
    red: sgr(31),
    cyan: sgr(36),
    magenta: sgr(35),
    blue: sgr(34),
    white: sgr(37)
  }
};

/** Status vocabulary → color name (frozen crush §1.3 status set). */
export const STATUS_COLOR: Readonly<Record<string, string>> = {
  active: "green",
  "ready-unverified": "cyan",
  "missing-key": "yellow",
  "needs-login": "yellow",
  "router-offline": "yellow",
  "pending-quota": "yellow",
  "works-with-caveat": "yellow",
  delegated: "cyan",
  "excluded-by-policy": "red"
};

export function colorize(theme: AnsiTheme, color: string, text: string): string {
  const code = theme.fg[color] ?? theme.fg.default;
  return `${code}${text}${theme.reset}`;
}

export function dim(theme: AnsiTheme, text: string): string {
  return `${theme.dim}${text}${theme.reset}`;
}

export function bold(theme: AnsiTheme, text: string): string {
  return `${theme.bold}${text}${theme.reset}`;
}

export function clearScreen(): string {
  return "\x1b[2J\x1b[H";
}

/** Strip ANSI escapes from a frame (used by tests / plain fallbacks). */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
