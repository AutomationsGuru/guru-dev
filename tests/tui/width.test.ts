import { describe, expect, it } from "vitest";

import { charDisplayWidth } from "../../src/tui/width.js";
import { stringDisplayWidth } from "../../src/tui/editor.js";
import { visibleWidth } from "../../src/tui/components.js";

/**
 * Usability-audit regression (2026-07-09): East-Asian-Width Wide BMP symbols
 * (⚡✅❌⭐ …) render 2 cells in real terminals (Windows Terminal, xterm, kitty)
 * but were counted 1. The default '⚡YOLO' status chip alone made the pinned
 * status bar one cell wider than computed — full-bleed → xenl soft-wrap → the
 * per-keystroke composer frame-stacking bug v1.4.1 fixed came straight back
 * for every YOLO-mode session.
 */
describe("charDisplayWidth — EAW-Wide BMP symbols", () => {
  it("counts emoji-presentation symbols as 2 cells", () => {
    for (const [glyph, code] of [
      ["⚡", 0x26a1],
      ["✅", 0x2705],
      ["❌", 0x274c],
      ["⭐", 0x2b50],
      ["⭕", 0x2b55],
      ["⏳", 0x23f3],
      ["⏰", 0x23f0],
      ["✨", 0x2728],
      ["☕", 0x2615],
      ["⌚", 0x231a],
      ["❗", 0x2757],
      ["⛔", 0x26d4]
    ] as const) {
      expect(charDisplayWidth(code), `${glyph} U+${code.toString(16)}`).toBe(2);
    }
  });

  it("keeps the harness's own chrome glyphs at 1 cell (EAW Narrow/Ambiguous)", () => {
    for (const [glyph, code] of [
      ["▸ prompt", 0x25b8],
      ["▲ agent", 0x25b2],
      ["⠋ spinner", 0x280b],
      ["⛨ mandate chip", 0x26e8],
      ["⛃ scout chip", 0x26c3],
      ["⛁ compaction", 0x26c1],
      ["⊘ interrupt", 0x2298],
      ["● running", 0x25cf],
      ["✓ ok", 0x2713],
      ["✖ fail", 0x2716],
      ["… ellipsis", 0x2026]
    ] as const) {
      expect(charDisplayWidth(code), glyph).toBe(1);
    }
  });

  it("the default YOLO status chip measures 6 cells through every width helper", () => {
    expect(stringDisplayWidth("⚡YOLO")).toBe(6);
    expect(visibleWidth("⚡YOLO")).toBe(6);
    // Styled, as the status bar actually paints it: ANSI stripped first.
    expect(visibleWidth("\x1b[33m⚡YOLO\x1b[39m")).toBe(6);
  });

  it("supplementary enclosed blocks before U+1F300 are wide (🀄 🃏 🆎 🈚)", () => {
    expect(charDisplayWidth(0x1f004)).toBe(2);
    expect(charDisplayWidth(0x1f0cf)).toBe(2);
    expect(charDisplayWidth(0x1f18e)).toBe(2);
    expect(charDisplayWidth(0x1f21a)).toBe(2);
  });

  it("existing contracts hold: CJK 2, ASCII 1, combining/zero-width 0", () => {
    expect(charDisplayWidth(0x6c49)).toBe(2); // 汉
    expect(charDisplayWidth(0x61)).toBe(1); // a
    expect(charDisplayWidth(0x0301)).toBe(0); // combining acute
    expect(charDisplayWidth(0xfe0f)).toBe(0); // variation selector
  });
});
