#!/usr/bin/env node
/**
 * README screenshot generator (standing rule 2026-07-05: README refreshes on
 * every version push — these regenerate with it).
 *
 * HONESTY: every frame is produced by the SHIPPED TUI renderer (dist/tui/*,
 * dist/guru.js) with the real painter and brand tokens — this is what the
 * terminal actually draws, captured to SVG instead of a screenshot. Build
 * first: `npm run build && node scripts/render-readme-shots.mjs`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const { createPainter } = await import(new URL("../dist/tui/theme.js", import.meta.url).href);
const { renderSplash } = await import(new URL("../dist/tui/splash.js", import.meta.url).href);
const { composerTopRule, composerHintLine } = await import(new URL("../dist/tui/composer.js", import.meta.url).href);
const { createMenuState } = await import(new URL("../dist/tui/menu.js", import.meta.url).href);
const { badge, GLYPHS } = await import(new URL("../dist/tui/components.js", import.meta.url).href);
const { buildStatusBar, buildMenuOverlayRows } = await import(new URL("../dist/guru.js", import.meta.url).href);
const pkg = (await import(new URL("../package.json", import.meta.url).href, { with: { type: "json" } })).default;

const paint = createPainter({ level: "truecolor" });

// ---------------------------------------------------------------------------
// ANSI → SVG (hand-rolled; truecolor SGR + bold + reset are all the renderer emits)
// ---------------------------------------------------------------------------
const FONT = `"Cascadia Code", "Consolas", "DejaVu Sans Mono", monospace`;
const CHAR_W = 7.8;
const LINE_H = 19;
const FONT_SIZE = 13;
const PAD = 18;

function esc(text) {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function parseAnsiLine(line) {
  const spans = [];
  let fg = null;
  let bg = null;
  let bold = false;
  let buffer = "";
  const flush = () => {
    if (buffer.length > 0) {
      spans.push({ text: buffer, fg, bg, bold });
      buffer = "";
    }
  };
  const re = /\x1b\[([0-9;]*)m/gu;
  let last = 0;
  for (const match of line.matchAll(re)) {
    buffer += line.slice(last, match.index);
    flush();
    last = match.index + match[0].length;
    const codes = (match[1] ?? "").split(";").map((value) => Number.parseInt(value || "0", 10));
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
      if (code === 0) {
        fg = null;
        bg = null;
        bold = false;
      } else if (code === 1) {
        bold = true;
      } else if (code === 22) {
        bold = false;
      } else if (code === 39) {
        fg = null;
      } else if (code === 49) {
        bg = null;
      } else if (code === 38 && codes[i + 1] === 2) {
        fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      } else if (code === 48 && codes[i + 1] === 2) {
        bg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      }
    }
  }
  buffer += line.slice(last);
  flush();
  return spans;
}

function ansiToSvg(lines, { columns, background, defaultFg }) {
  const width = Math.ceil(columns * CHAR_W + PAD * 2);
  const height = Math.ceil(lines.length * LINE_H + PAD * 2);
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  parts.push(`<rect width="100%" height="100%" rx="10" fill="${background}"/>`);
  lines.forEach((line, row) => {
    const y = PAD + row * LINE_H + FONT_SIZE;
    const spans = parseAnsiLine(line);
    let col = 0;
    // Background runs first (behind the text row).
    for (const span of spans) {
      if (span.bg) {
        parts.push(
          `<rect x="${(PAD + col * CHAR_W).toFixed(1)}" y="${(y - FONT_SIZE - 2).toFixed(1)}" width="${(span.text.length * CHAR_W).toFixed(1)}" height="${LINE_H}" fill="${span.bg}"/>`
        );
      }
      col += span.text.length;
    }
    col = 0;
    const tspans = spans
      .map((span) => {
        const x = PAD + col * CHAR_W;
        col += span.text.length;
        if (span.text.trim().length === 0) {
          return "";
        }
        const weight = span.bold ? ` font-weight="700"` : "";
        return `<text x="${x.toFixed(1)}" y="${y}" font-family='${FONT}' font-size="${FONT_SIZE}" xml:space="preserve" fill="${span.fg ?? defaultFg}"${weight}>${esc(span.text)}</text>`;
      })
      .join("");
    parts.push(tspans);
  });
  parts.push("</svg>");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Frame 1: the splash (full 160-col truecolor lockup — the real boot banner)
// ---------------------------------------------------------------------------
const SPLASH_COLS = 160;
const splashLines = renderSplash(paint, { version: pkg.version, themeName: paint.name ?? "brand", node: process.version.slice(1) }, SPLASH_COLS).split("\n");

// ---------------------------------------------------------------------------
// Frame 2: a session frame — real renderer functions, synthetic session state
// (the same technique the unit suite uses; nothing hand-drawn).
// ---------------------------------------------------------------------------
const COLS = 110;
const mut = (token, text) => paint.fg(token, text);

// Numbers must be internally consistent with the compaction trace below
// (adversarial review 2026-07-05): zai/glm-5-turbo's REAL window is 200k
// (modelSheet), auto-trigger fires at window − reserve ≈ 184k, and the
// post-compaction ctx reflects the folded history.
const sessionState = {
  session: { repo: { repoRoot: join(root) } },
  connectedRoute: {
    routeId: "zai/glm-5-turbo",
    apiFamily: "openai-chat-completions",
    context: { contextWindowTokens: 200_000 },
    compat: { supportsReasoningEffort: false }
  },
  modelIdOverride: null,
  activeRole: null,
  usage: { inputTokens: 201_400, outputTokens: 9_800, turns: 24, lastRequestInputTokens: 21_300, lastInputTokens: 21_300 },
  yolo: true,
  lookahead: { enabled: true },
  mandate: { grants: [{ scope: "space" }] }
};

const menu = createMenuState(
  [
    { id: "/model", label: "/model", hint: "browse 103 routes · connect", drillable: true },
    { id: "/compact", label: "/compact", hint: "fold older history into a summary" },
    { id: "/remember", label: "/remember", hint: "save a durable memory fact" },
    { id: "/role", label: "/role", hint: "suit up for the day's work", drillable: true },
    { id: "/yolo", label: "/yolo", hint: "lift the permission gates (ritual)" }
  ],
  "/"
);

const frame = [
  `${mut("fgFaint", "›")} ${mut("fg", "the tests fail — find the bug, fix it, prove it passes")}`,
  "",
  `  ${badge(paint, "READ")} ${mut("fg", "src/payments/invoice.ts")} ${mut("fgFaint", "· 214 lines")}`,
  `  ${badge(paint, "RUN")} ${mut("fg", "npm test")} ${mut("fgFaint", "· exit 1 · 2 failing")}`,
  `  ${mut("warning", "↻")} ${mut("muted", "retrying… attempt 1/3 · in 2.0s (HTTP 429)")}`,
  `  ${badge(paint, "EDIT")} ${mut("fg", "src/payments/invoice.ts")} ${mut("fgFaint", "· 1 replacement")}`,
  `  ${badge(paint, "RUN")} ${mut("fg", "npm test")} ${mut("fgFaint", "· exit 0 · 118 passing")}`,
  `  ${mut("accent2", "⛁")} ${mut("muted", "compacting context… ~184k tok")}`,
  `  ${mut("success", GLYPHS.ok)} ${mut("fg", "compacted ~184k → ~21k tok")}${mut("muted", " · summary #1 · clean cut")}`,
  "",
  `${mut("accent2", GLYPHS.agent)} ${mut("fg", "Fixed: the rounding in applyDiscount dropped sub-cent totals. Both tests now pass — 118/118 green.")}`,
  "",
  composerTopRule(paint, COLS, "zai/glm-5-turbo"),
  `${mut("fgFaint", "›")} ${mut("fg", "/")}`,
  ...buildMenuOverlayRows(paint, menu),
  buildStatusBar(sessionState, COLS),
  composerHintLine(paint, ["ctrl+j newline", "@ files", "tab paths"], { mode: "idle" })
];

// ---------------------------------------------------------------------------
mkdirSync(join(root, "assets", "readme"), { recursive: true });
const bgHex = paint.tokens?.bg ?? "#12091F";
writeFileSync(join(root, "assets", "readme", "splash.svg"), ansiToSvg(splashLines, { columns: SPLASH_COLS, background: bgHex, defaultFg: "#E9DEF8" }));
writeFileSync(join(root, "assets", "readme", "session.svg"), ansiToSvg(frame, { columns: COLS, background: bgHex, defaultFg: "#E9DEF8" }));
console.log(`wrote assets/readme/splash.svg (${splashLines.length} lines @ ${SPLASH_COLS} cols)`);
console.log(`wrote assets/readme/session.svg (${frame.length} lines @ ${COLS} cols)`);
