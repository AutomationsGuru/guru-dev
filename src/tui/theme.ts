import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

/**
 * AutomationsGuru Terminal Design System v1 — token engine.
 * Source of truth: `Terminal Design System/TERMINAL_DESIGN_SPEC.md` (kit, repo-adjacent).
 * Truecolor-first with strict 256/16 fallbacks and NO_COLOR/non-TTY discipline (§7).
 */

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/u);

export const ThemeFileSchema = z
  .object({
    name: z.string().default("automationsguru"),
    colors: z
      .object({
        accent: HexColor.optional(),
        accent2: HexColor.optional(),
        success: HexColor.optional(),
        warning: HexColor.optional(),
        error: HexColor.optional(),
        info: HexColor.optional(),
        muted: HexColor.optional(),
        border: HexColor.optional(),
        badgeFg: HexColor.optional(),
        badgeBg: HexColor.optional(),
        banner: z.array(HexColor).min(2).optional(),
        bg: HexColor.optional(),
        bgPanel: HexColor.optional(),
        bgSelect: HexColor.optional(),
        fg: HexColor.optional(),
        fgBright: HexColor.optional(),
        fgFaint: HexColor.optional(),
        addedBg: HexColor.optional(),
        removedBg: HexColor.optional(),
        badgeFgOnColor: HexColor.optional()
      })
      .partial()
      .default({})
  })
  .strict();

export type ThemeFile = z.infer<typeof ThemeFileSchema>;

export type ColorLevel = "truecolor" | "256" | "16" | "none";

export interface ThemeTokens {
  readonly accent: string;
  readonly accent2: string;
  readonly success: string;
  readonly warning: string;
  readonly error: string;
  readonly info: string;
  readonly muted: string;
  readonly border: string;
  readonly badgeFg: string;
  readonly badgeBg: string;
  readonly banner: readonly string[];
  readonly bg: string;
  readonly bgPanel: string;
  readonly bgSelect: string;
  readonly fg: string;
  readonly fgBright: string;
  readonly fgFaint: string;
  readonly addedBg: string;
  readonly removedBg: string;
  readonly badgeFgOnColor: string;
}

/** Kit defaults — theme.json (§1) + extended palette (§2), baked verbatim. */
export const KIT_TOKENS: ThemeTokens = {
  accent: "#B56EF1",
  accent2: "#E958BE",
  success: "#31C48D",
  warning: "#F2A33C",
  error: "#F73B4A",
  info: "#7E8FFA",
  muted: "#7A6C95",
  border: "#3A2A5C",
  badgeFg: "#FFFFFF",
  badgeBg: "#8C11E1",
  banner: ["#F73B4A", "#C7288F", "#8C11E1", "#B56EF1"],
  bg: "#1A1130",
  bgPanel: "#271A45",
  bgSelect: "#3A2A5C",
  fg: "#E7E2F0",
  fgBright: "#FFFFFF",
  fgFaint: "#564574",
  addedBg: "#142E26",
  removedBg: "#331522",
  badgeFgOnColor: "#10091E"
};

/** Strict ANSI-16 fallback roles (§2). Values are SGR codes; bg roles noted. */
const ANSI16_FG: Readonly<Partial<Record<keyof ThemeTokens, number>>> = {
  accent: 95, // bright magenta (13)
  accent2: 35, // magenta (5)
  success: 92, // bright green (10)
  warning: 93, // bright yellow (11)
  error: 91, // bright red (9)
  info: 94, // bright blue (12)
  muted: 90, // bright black (8)
  border: 90,
  fg: 37, // white (7)
  fgBright: 97, // bright white (15)
  fgFaint: 90,
  badgeFg: 97,
  badgeFgOnColor: 30
};
const ANSI16_BG: Readonly<Partial<Record<keyof ThemeTokens, number>>> = {
  badgeBg: 45, // magenta bg (5)
  bgPanel: 100,
  bgSelect: 100,
  addedBg: 42,
  removedBg: 41,
  success: 102,
  warning: 103,
  error: 101
};

export function hexToRgb(hex: string): [number, number, number] {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

/** Standard xterm 256 cube quantization. */
export function rgbTo256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const level = (value: number): number => (value < 48 ? 0 : value < 115 ? 1 : Math.min(5, Math.floor((value - 35) / 40)));

  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

export function detectColorLevel(env: NodeJS.ProcessEnv = process.env, isTty: boolean = process.stdout.isTTY === true): ColorLevel {
  // FORCE_COLOR (ecosystem convention) wins over TTY detection: 3=truecolor, 2=256, 1=16, 0=off.
  if (env.FORCE_COLOR !== undefined) {
    const forced = env.FORCE_COLOR;
    if (forced === "0") return "none";
    if (forced === "2") return "256";
    if (forced === "1") return "16";
    return "truecolor";
  }
  if (env.NO_COLOR !== undefined || !isTty || env.TERM === "dumb") {
    return "none";
  }
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm.includes("truecolor") || colorterm.includes("24bit") || env.WT_SESSION !== undefined) {
    return "truecolor";
  }
  if ((env.TERM ?? "").includes("256")) {
    return "256";
  }
  return "16";
}

export interface Painter {
  readonly level: ColorLevel;
  readonly tokens: ThemeTokens;
  readonly name: string;
  /** Raw SGR open sequence for a token (for adapting legacy theme structs). */
  open(token: keyof ThemeTokens): string;
  /** Foreground paint (auto reset). */
  fg(token: keyof ThemeTokens, text: string): string;
  /** Background paint (auto reset); composes with an optional fg token. */
  bg(token: keyof ThemeTokens, text: string, fgToken?: keyof ThemeTokens): string;
  /** Foreground paint with an arbitrary hex (gradients); falls back honestly. */
  hex(hexColor: string, text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  italic(text: string): string;
}

function sgrForHex(hexColor: string, level: ColorLevel, background: boolean): string {
  const [r, g, b] = hexToRgb(hexColor);
  const base = background ? 48 : 38;
  if (level === "truecolor") {
    return `\x1b[${base};2;${r};${g};${b}m`;
  }
  if (level === "256") {
    return `\x1b[${base};5;${rgbTo256(r, g, b)}m`;
  }
  return "";
}

export function createPainter(options: { tokens?: ThemeTokens; level?: ColorLevel; name?: string } = {}): Painter {
  const tokens = options.tokens ?? KIT_TOKENS;
  const level = options.level ?? detectColorLevel();
  const name = options.name ?? "automationsguru";
  const reset = level === "none" ? "" : "\x1b[0m";
  const wrap = (open: string, text: string): string => (open.length === 0 ? text : `${open}${text}${reset}`);

  const fgOpen = (token: keyof ThemeTokens): string => {
    if (level === "none") return "";
    if (level === "16") {
      const code = ANSI16_FG[token];
      return code === undefined ? "" : `\x1b[${code}m`;
    }
    const value = tokens[token];
    return typeof value === "string" ? sgrForHex(value, level, false) : "";
  };
  const bgOpen = (token: keyof ThemeTokens): string => {
    if (level === "none") return "";
    if (level === "16") {
      const code = ANSI16_BG[token];
      return code === undefined ? "" : `\x1b[${code}m`;
    }
    const value = tokens[token];
    return typeof value === "string" ? sgrForHex(value, level, true) : "";
  };

  return {
    level,
    tokens,
    name,
    open: fgOpen,
    fg: (token, text) => wrap(fgOpen(token), text),
    bg: (token, text, fgToken) => wrap(`${bgOpen(token)}${fgToken ? fgOpen(fgToken) : ""}`, text),
    hex: (hexColor, text) => wrap(level === "16" ? fgOpen("accent") : sgrForHex(hexColor, level, false), text),
    bold: (text) => (level === "none" ? text : `\x1b[1m${text}\x1b[22m`),
    dim: (text) => (level === "none" ? text : `\x1b[2m${text}\x1b[22m`),
    italic: (text) => (level === "none" ? text : `\x1b[3m${text}\x1b[23m`)
  };
}

export const THEME_FILE_PATH = join(homedir(), ".guruharness", "theme.json");

/** Load the operator theme; missing/invalid file → kit defaults (never throws). */
export function loadTheme(filePath: string = THEME_FILE_PATH): { tokens: ThemeTokens; name: string; source: "file" | "defaults" } {
  try {
    const parsed = ThemeFileSchema.safeParse(JSON.parse(readFileSync(filePath, "utf8")));
    if (!parsed.success) {
      return { tokens: KIT_TOKENS, name: "automationsguru", source: "defaults" };
    }
    const colors = parsed.data.colors;
    return {
      tokens: {
        ...KIT_TOKENS,
        ...Object.fromEntries(Object.entries(colors).filter(([, value]) => value !== undefined))
      } as ThemeTokens,
      name: parsed.data.name,
      source: "file"
    };
  } catch {
    return { tokens: KIT_TOKENS, name: "automationsguru", source: "defaults" };
  }
}
