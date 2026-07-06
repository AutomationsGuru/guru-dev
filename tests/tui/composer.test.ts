import { describe, expect, it } from "vitest";

import { composerTopRule, composerHintLine } from "../../src/tui/composer.js";
import { createPainter } from "../../src/tui/theme.js";
import { visibleWidth } from "../../src/tui/components.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/gu, "");

describe("composer chrome — pure render", () => {
  it("top rule spans the full terminal width at any size", () => {
    const p = createPainter({ level: "truecolor" });
    for (const cols of [60, 120, 200]) {
      const rule = strip(composerTopRule(p, cols));
      expect(visibleWidth(rule), `rule fills ${cols}`).toBe(cols);
      expect(rule).toMatch(/^─+$/u);
    }
  });

  it("top rule carries a right-justified mode label without overflowing width", () => {
    const p = createPainter({ level: "truecolor" });
    const rule = strip(composerTopRule(p, 100, "▸ YOLO · scout"));
    expect(visibleWidth(rule)).toBe(100);
    expect(rule).toContain("YOLO · scout");
    expect(rule.trimEnd().endsWith("YOLO · scout") || rule.endsWith("YOLO · scout ")).toBe(true);
  });

  it("hint line lists the core keys and merges extras", () => {
    const p = createPainter({ level: "truecolor" });
    const hint = strip(composerHintLine(p, ["shift+tab mode"]));
    expect(hint).toContain("/ commands");
    expect(hint).toContain("esc interrupt");
    expect(hint).toContain("shift+tab mode");
  });

  it("degrades to a plain rule with no color", () => {
    const p = createPainter({ level: "none" });
    const rule = strip(composerTopRule(p, 40));
    expect(visibleWidth(rule)).toBe(40);
  });
});
