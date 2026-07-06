import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPainter, detectColorLevel, hexToRgb, KIT_TOKENS, loadTheme, rgbTo256 } from "../../src/tui/theme.js";
import { gradientBlock, gradientRule, sampleGradient } from "../../src/tui/gradient.js";
import { badge, compactMark, renderTable, roundedBox, spinnerFrame, visibleWidth } from "../../src/tui/components.js";
import { renderEyebrow, renderSplash } from "../../src/tui/splash.js";

describe("theme engine (Terminal Design System v1)", () => {
  it("emits 24-bit SGR for truecolor", () => {
    const painter = createPainter({ level: "truecolor" });
    expect(painter.fg("accent", "x")).toBe("\x1b[38;2;181;110;241mx\x1b[0m");
  });

  it("quantizes to the xterm 256 cube", () => {
    const painter = createPainter({ level: "256" });
    expect(painter.fg("error", "x")).toMatch(/^\x1b\[38;5;\d+mx/u);
    expect(rgbTo256(0, 0, 0)).toBe(16);
    expect(rgbTo256(255, 255, 255)).toBe(231);
  });

  it("uses the strict ANSI-16 role mapping from spec §2", () => {
    const painter = createPainter({ level: "16" });
    expect(painter.fg("accent", "x")).toBe("\x1b[95mx\x1b[0m"); // bright magenta = 13
    expect(painter.fg("error", "x")).toBe("\x1b[91mx\x1b[0m"); // bright red = 9
    expect(painter.fg("muted", "x")).toBe("\x1b[90mx\x1b[0m"); // bright black = 8
  });

  it("drops all color at level none but keeps text", () => {
    const painter = createPainter({ level: "none" });
    expect(painter.fg("accent", "hello")).toBe("hello");
    expect(painter.bold("hi")).toBe("hi");
  });

  it("NO_COLOR and non-TTY force level none; WT_SESSION implies truecolor", () => {
    expect(detectColorLevel({ NO_COLOR: "1", COLORTERM: "truecolor" }, true)).toBe("none");
    expect(detectColorLevel({ COLORTERM: "truecolor" }, false)).toBe("none");
    expect(detectColorLevel({ WT_SESSION: "abc" }, true)).toBe("truecolor");
    expect(detectColorLevel({ TERM: "xterm-256color" }, true)).toBe("256");
  });

  it("loads operator theme.json over kit defaults and falls back safely", () => {
    const dir = mkdtempSync(join(tmpdir(), "guru-theme-"));
    try {
      const file = join(dir, "theme.json");
      writeFileSync(file, JSON.stringify({ name: "custom", colors: { accent: "#112233" } }));
      const loaded = loadTheme(file);
      expect(loaded.source).toBe("file");
      expect(loaded.name).toBe("custom");
      expect(loaded.tokens.accent).toBe("#112233");
      expect(loaded.tokens.error).toBe(KIT_TOKENS.error); // unspecified → kit default

      const missing = loadTheme(join(dir, "nope.json"));
      expect(missing.source).toBe("defaults");
      expect(missing.tokens).toEqual(KIT_TOKENS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gradient engine (spec §3)", () => {
  it("interpolates piecewise-linearly across stops", () => {
    expect(sampleGradient(["#000000", "#ffffff"], 0)).toEqual([0, 0, 0]);
    expect(sampleGradient(["#000000", "#ffffff"], 1)).toEqual([255, 255, 255]);
    expect(sampleGradient(["#000000", "#ffffff"], 0.5)).toEqual([128, 128, 128]);
  });

  it("uses the same t per column across all rows (block alignment)", () => {
    const painter = createPainter({ level: "truecolor" });
    const [row1, row2] = gradientBlock(painter, ["#ff0000", "#0000ff"], ["AB", "CD"]);
    const colorOf = (painted: string): string[] => [...painted.matchAll(/38;2;(\d+;\d+;\d+)/gu)].map((m) => m[1]!);
    expect(colorOf(row1!)).toEqual(colorOf(row2!)); // col colors identical row-to-row
  });

  it("spaces advance t but paint nothing", () => {
    const painter = createPainter({ level: "truecolor" });
    const painted = gradientBlock(painter, ["#ff0000", "#0000ff"], ["A B"])[0]!;
    expect(painted).toContain(" ");
    expect([...painted.matchAll(/38;2/gu)]).toHaveLength(2); // only 2 painted glyphs
  });

  it("falls back to border color at 16/none levels", () => {
    const painter = createPainter({ level: "none" });
    expect(gradientRule(painter, ["#ff0000", "#0000ff"], 4)).toBe("────");
  });
});

describe("components (spec §5)", () => {
  const painter = createPainter({ level: "truecolor" });

  it("badges are padded, uppercase, and ghost badges are bracketed", () => {
    expect(visibleWidth(badge(painter, "run"))).toBe(5); // " RUN "
    expect(badge(createPainter({ level: "none" }), "edit", "ghost")).toBe("[EDIT]");
  });

  it("tables render bold header, border rule, and aligned rows", () => {
    const lines = renderTable(painter, [{ header: "id" }, { header: "status" }], [["1", "ok"], ["22", "meh"]]);
    expect(lines).toHaveLength(4);
    expect(visibleWidth(lines[2]!)).toBe(visibleWidth(lines[3]!));
    expect(lines[1]!).toContain("─");
  });

  it("rounded boxes align edges around ANSI-painted content", () => {
    const content = painter.fg("success", "ok");
    const box = roundedBox(painter, [content], { title: "T" });
    const widths = box.map(visibleWidth);
    expect(new Set(widths).size).toBe(1); // all rows same visible width
  });

  it("spinner cycles braille frames with brand-ramp colors", () => {
    expect(visibleWidth(spinnerFrame(painter, 0))).toBe(1);
    expect(spinnerFrame(painter, 0)).not.toBe(spinnerFrame(painter, 2));
  });

  it("compact mark keeps the ▲ + wordmark shape", () => {
    expect(visibleWidth(compactMark(painter))).toBe("▲ guru harness".length);
  });
});

describe("splash (spec §4)", () => {
  it("centers the dynamic eyebrow under the wordmark span", () => {
    const painter = createPainter({ level: "truecolor" });
    const eyebrow = renderEyebrow(painter, { version: "0.1.0", themeName: "automationsguru", node: "22.0.0" });
    const visible = eyebrow.replace(/\x1b\[[0-9;]*m/gu, "");
    expect(visible).toContain("GURU HARNESS VERSION 0.1.0 · THEME AUTOMATIONSGURU · NODE 22.0.0");
    expect(visible.indexOf("GURU")).toBeGreaterThanOrEqual(41);
  });

  it("degrades honestly: non-truecolor or narrow → compact forms, never the .ans", () => {
    const noColor = renderSplash(createPainter({ level: "none" }), { version: "0.1.0", themeName: "x", node: "22" }, 200);
    expect(noColor).toContain("guru harness");
    expect(noColor).not.toContain("\x1b[38;2");

    const narrow = renderSplash(createPainter({ level: "truecolor" }), { version: "0.1.0", themeName: "x", node: "22" }, 100);
    expect(narrow.split("\n").length).toBeLessThan(25);
  });

  it("always stretches full-width: framing bands fill to the terminal edge at any size", () => {
    const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/gu, "");
    for (const cols of [60, 100, 160, 220]) {
      const out = renderSplash(createPainter({ level: "truecolor" }), { version: "0.8.0", themeName: "automationsguru", node: "24" }, cols);
      const lines = strip(out).split("\n");
      // The top framing band (hatch) should span ~the full width, not sit left-justified short.
      const bandLine = lines.find((l) => l.includes("▚"));
      expect(bandLine, `band present at ${cols}`).toBeDefined();
      expect(visibleWidth(bandLine ?? ""), `band fills width at ${cols}`).toBeGreaterThanOrEqual(cols - 2);
    }
  });

  it("full-width eyebrow right-justifies to the terminal edge, not a fixed 160", () => {
    const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/gu, "");
    const wide = renderSplash(createPainter({ level: "truecolor" }), { version: "0.8.0", themeName: "automationsguru", node: "24" }, 220);
    const eyebrowLine = strip(wide).split("\n").find((l) => l.includes("GURU HARNESS VERSION"));
    expect(eyebrowLine).toBeDefined();
    // Its right edge reaches near the terminal width (stretched), not stuck at ~160.
    expect(visibleWidth(eyebrowLine ?? "")).toBeGreaterThan(200);
  });
});

describe("FORCE_COLOR override", () => {
  it("wins over TTY detection at each level", () => {
    expect(detectColorLevel({ FORCE_COLOR: "3" }, false)).toBe("truecolor");
    expect(detectColorLevel({ FORCE_COLOR: "2" }, false)).toBe("256");
    expect(detectColorLevel({ FORCE_COLOR: "1" }, false)).toBe("16");
    expect(detectColorLevel({ FORCE_COLOR: "0", COLORTERM: "truecolor" }, true)).toBe("none");
  });
});
