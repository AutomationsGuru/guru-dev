import { describe, expect, it } from "vitest";

import { createEditorState, editorReduce, editorText, withBufferText } from "../../src/tui/editor.js";
import { roundedBox, visibleWidth } from "../../src/tui/components.js";
import { composerHintLine } from "../../src/tui/composer.js";
import { createPainter } from "../../src/tui/theme.js";

const paint = createPainter({ tokens: undefined as never, name: "test" });
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, "");

/**
 * Usability-audit regressions (2026-07-09) — the quiet-file batch:
 * surrogate-safe ↑/↓, pasted-tab normalization, roundedBox terminal clamp,
 * whole-hint trimming on narrow terminals.
 */
describe("editor — ↑/↓ never parks the cursor inside a surrogate pair", () => {
  it("snaps to the code-point boundary when the column clamp lands mid-emoji", () => {
    // Line 1: "aaaa" (cursor at col 4) · Line 2: "😀😀" (4 UTF-16 units).
    let state = withBufferText(createEditorState(), "aaaa\n😀😀");
    state = { ...state, row: 0, col: 3 }; // col 3 on line 2 = middle of the second 😀
    const step = editorReduce(state, { name: "down" });
    expect(step.state.row).toBe(1);
    expect(step.state.col).toBe(2); // snapped back to the boundary between the emoji
    // Typing there must not corrupt the buffer into lone surrogates.
    const typed = editorReduce(step.state, { sequence: "x", name: "x" });
    expect(editorText(typed.state)).toBe("aaaa\n😀x😀");
  });

  it("↑ snaps too (clamp from a longer line below)", () => {
    let state = withBufferText(createEditorState(), "😀😀\nbbbb");
    state = { ...state, row: 1, col: 3 };
    const step = editorReduce(state, { name: "up" });
    expect(step.state.col).toBe(2);
  });
});

describe("editor — pasted tabs normalize to spaces (wrap math cannot model tab stops)", () => {
  it("replaces every pasted \\t with four spaces", () => {
    const state = createEditorState();
    const step = editorReduce(state, { name: "paste", sequence: "if (x) {\n\treturn;\n}" });
    expect(editorText(step.state)).toBe("if (x) {\n    return;\n}");
    expect(editorText(step.state)).not.toContain("\t");
  });
});

describe("roundedBox — clamps to maxWidth so one long line cannot shatter the panel", () => {
  it("keeps every row within maxWidth and clips the long line with an ellipsis", () => {
    const longLine = `resolver: bound (never-stuck ready) · cwd: ${"P:/guruharness/very/deep/path/".repeat(4)}`;
    const rows = roundedBox(paint, ["short line", longLine], { title: "BOOT RITUAL", maxWidth: 79 });
    for (const row of rows) {
      expect(visibleWidth(row), strip(row)).toBeLessThanOrEqual(79);
    }
    expect(strip(rows[2] ?? "")).toContain("…");
    // Box shape intact: every row has both borders.
    expect(strip(rows[1] ?? "").startsWith("│")).toBe(true);
    expect(strip(rows[1] ?? "").endsWith("│")).toBe(true);
    expect(strip(rows[rows.length - 1] ?? "").startsWith("╰")).toBe(true);
  });

  it("no clamp without a TTY/maxWidth (pure callers unchanged)", () => {
    const wide = "x".repeat(300);
    const rows = roundedBox(paint, [wide], {});
    expect(strip(rows[1] ?? "")).toContain(wide);
  });
});

describe("composerHintLine — drops whole hints on narrow terminals, never chops mid-word", () => {
  it("keeps the hint list readable at 80 columns", () => {
    const extras = ["ctrl+j newline", "@ files", "tab paths", "type+↵ steer", "alt+↵ follow-up"];
    const line = strip(composerHintLine(paint, extras, 80));
    expect(visibleWidth(line)).toBeLessThanOrEqual(79);
    // Whatever survived must be complete items joined by the separator.
    const shown = line.trim().split(" · ");
    const all = ["/ commands", "↵ run", "esc/ctrl+c interrupt", "ctrl+d exit", ...extras];
    for (const item of shown) {
      expect(all).toContain(item);
    }
  });

  it("wide terminals still get the full list", () => {
    const extras = ["ctrl+j newline", "@ files", "tab paths", "type+↵ steer", "alt+↵ follow-up"];
    const line = strip(composerHintLine(paint, extras, 200));
    for (const item of extras) {
      expect(line).toContain(item);
    }
  });

  it("always shows at least the first hint even on absurdly narrow widths", () => {
    const line = strip(composerHintLine(paint, [], 10));
    expect(line).toContain("/ commands");
  });

  it("shows interrupt-first hints when busy=true, omits idle run command", () => {
    const line = strip(composerHintLine(paint, [], 80, true));
    expect(line).toContain("esc/ctrl+c interrupt");
    expect(line).toContain("↵ steer");
    expect(line).not.toContain("/ commands");
    expect(line).not.toContain("↵ run");
  });
});
