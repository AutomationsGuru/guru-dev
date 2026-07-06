import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { gradientLine } from "./gradient.js";
import { compactMark } from "./components.js";
import type { Painter } from "./theme.js";

/**
 * Splash & marks per spec §4. The .ans lockup and AG-mark art are kit assets copied
 * verbatim into `assets/` — never re-typeset the wordmark.
 * Width ladder: ≥162 cols full lockup · ≥40 AG mark · below that compact mark.
 */

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets");

function readAsset(name: string): string | null {
  try {
    return readFileSync(join(ASSETS_DIR, name), "utf8");
  } catch {
    return null;
  }
}

/** Dynamic eyebrow: real runtime values, ALL CAPS, tracked, accent (§4). */
export function renderEyebrow(painter: Painter, info: { version: string; themeName: string; node: string }, artWidth = 160, wordmarkStart = 41): string {
  const text = `GURU HARNESS VERSION ${info.version} · THEME ${info.themeName.toUpperCase()} · NODE ${info.node}`;
  const span = artWidth - wordmarkStart;
  const pad = wordmarkStart + Math.max(0, Math.floor((span - text.length) / 2));

  return " ".repeat(pad) + painter.fg("accent", text);
}

/** AG mark (18-row block, one brand-ramp color per row) from ascii-art.txt. */
export function renderAgMark(painter: Painter): string[] | null {
  const raw = readAsset("ag-mark.txt");
  if (raw === null) {
    return null;
  }
  const rows: string[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const match = /^(.*?)\s*(#[0-9a-fA-F]{6})\s*$/u.exec(line);
    if (!match) {
      continue;
    }
    const [, art, hex] = match;
    if ((art ?? "").trim().length === 0) {
      continue;
    }
    rows.push(painter.hex(hex!, art!.trimEnd()));
  }
  return rows.length > 0 ? rows : null;
}

export interface SplashInfo {
  readonly version: string;
  readonly themeName: string;
  readonly node: string;
}

/**
 * Full-width framing band: a brand-gradient hatch that spans the WHOLE terminal
 * width so the splash reaches both edges at any window size (Crush-style stretch).
 * An optional right-justified label rides the band.
 */
export function hatchBand(painter: Painter, columns: number, rightLabel?: string): string {
  const width = Math.max(8, columns);
  const labelText = rightLabel ?? "";
  const labelVisible = labelText.length;
  const hatchWidth = Math.max(0, width - (labelVisible > 0 ? labelVisible + 2 : 0));
  const hatch = "▚".repeat(hatchWidth);
  const painted = painter.level === "none" ? hatch : gradientLine(painter, [...painter.tokens.banner], hatch, Math.max(1, hatchWidth));
  return labelVisible > 0 ? `${painted}  ${painter.fg("accent", labelText)}` : painted;
}

/**
 * Full-width eyebrow: real runtime values right-justified to the terminal edge
 * (§4), so it stretches with the window instead of padding to a fixed art width.
 */
function fullWidthEyebrow(painter: Painter, info: SplashInfo, columns: number): string {
  const text = `GURU HARNESS VERSION ${info.version} · THEME ${info.themeName.toUpperCase()} · NODE ${info.node}`;
  const pad = Math.max(1, columns - text.length - 1);
  return " ".repeat(pad) + painter.fg("accent", text);
}

/**
 * Splash for the current terminal width — ALWAYS full-width: the logo art is
 * framed top and bottom by a hatch band that spans the whole window, and the
 * eyebrow right-justifies to the edge. Truecolor + wide → .ans lockup; medium →
 * AG mark + wordmark title; narrow/no-color → gradient banner. Every tier
 * stretches edge-to-edge rather than sitting left-justified.
 */
export function renderSplash(painter: Painter, info: SplashInfo, columns: number = process.stdout.columns ?? 80): string {
  const topBand = hatchBand(painter, columns);
  const bottomBand = hatchBand(painter, columns, `v${info.version}`);

  // Wide truecolor: the full "Guru Harness" lockup (160-col art), framed full-width.
  if (painter.level === "truecolor" && columns >= 160) {
    const raw = readAsset("splash.ans");
    if (raw !== null) {
      const artRows = raw.split(/\r?\n/u).slice(0, 18);
      return `${topBand}\n${artRows.join("\n")}\n${fullWidthEyebrow(painter, info, columns)}\n${bottomBand}\n`;
    }
  }

  // Medium: the AG monogram + a real wordmark title line, framed full-width so a
  // windowed terminal gets a branded, edge-to-edge splash (not a bare monogram).
  if (painter.level !== "none" && columns >= 44) {
    const mark = renderAgMark(painter);
    if (mark !== null) {
      const wordmark = gradientLine(painter, [...painter.tokens.banner], "guru harness");
      const title = `${compactMark(painter)}  ${wordmark}  ${painter.fg("fgFaint", `v${info.version} · ${info.themeName} · node ${info.node}`)}`;
      return `${topBand}\n${mark.join("\n")}\n\n${title}\n${bottomBand}\n`;
    }
  }

  // Narrow / no-color: a full-width gradient banner line, still edge-to-edge.
  const banner = gradientLine(painter, [...painter.tokens.banner], "guru harness");
  const rule = painter.level === "none" ? "-".repeat(Math.max(8, columns)) : hatchBand(painter, columns);
  return `${rule}\n${painter.level === "none" ? "guru harness" : banner}  ${painter.fg("fgFaint", `v${info.version} · node ${info.node}`)}\n`;
}
