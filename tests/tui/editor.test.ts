import { describe, expect, it } from "vitest";

import {
  charDisplayWidth,
  createEditorState,
  editorReduce,
  editorText,
  renderEditorFrame,
  stringDisplayWidth,
  type EditorKey,
  type EditorState
} from "../../src/tui/editor.js";
import { createPainter } from "../../src/tui/theme.js";

/** Drive the reducer with a sequence of keys; return the final step. */
function drive(state: EditorState, keys: readonly EditorKey[]) {
  let current = state;
  let last = { state: current, effect: { kind: "none" as const } as ReturnType<typeof editorReduce>["effect"] };
  for (const key of keys) {
    last = editorReduce(current, key);
    current = last.state;
  }
  return { state: current, effect: last.effect };
}

const type = (text: string): EditorKey[] => [...text].map((char) => ({ sequence: char, name: char }));
const KEY = {
  enter: { name: "return", sequence: "\r" } as EditorKey, // Enter = CR
  ctrlJ: { name: "enter", sequence: "\n" } as EditorKey, // Ctrl+J = LF
  shiftEnter: { name: "return", shift: true, sequence: "\r" } as EditorKey,
  up: { name: "up" } as EditorKey,
  down: { name: "down" } as EditorKey,
  left: { name: "left" } as EditorKey,
  right: { name: "right" } as EditorKey,
  backspace: { name: "backspace" } as EditorKey,
  ctrl: (name: string): EditorKey => ({ name, ctrl: true })
};

describe("editor reducer — the ADR key map", () => {
  it("Ctrl+J inserts a newline (THE contract); Enter submits the joined buffer", () => {
    const typed = drive(createEditorState(), [...type("line one"), KEY.ctrlJ, ...type("line two")]);
    expect(typed.state.lines).toEqual(["line one", "line two"]);
    const submitted = drive(typed.state, [KEY.enter]);
    expect(submitted.effect).toEqual({ kind: "submit", text: "line one\nline two" });
    expect(editorText(submitted.state)).toBe(""); // fresh buffer after submit
  });

  it("Shift+Enter inserts a newline where the terminal reports it", () => {
    const step = drive(createEditorState(), [...type("a"), KEY.shiftEnter, ...type("b")]);
    expect(step.state.lines).toEqual(["a", "b"]);
  });

  it("newline splits at the cursor; backspace at column 0 joins lines back", () => {
    const split = drive(createEditorState(), [...type("hello"), KEY.left, KEY.left, KEY.ctrlJ]);
    expect(split.state.lines).toEqual(["hel", "lo"]);
    expect(split.state.row).toBe(1);
    expect(split.state.col).toBe(0);
    const joined = drive(split.state, [KEY.backspace]);
    expect(joined.state.lines).toEqual(["hello"]);
    expect(joined.state.col).toBe(3);
  });

  it("← and → cross line boundaries", () => {
    const state = drive(createEditorState(), [...type("ab"), KEY.ctrlJ, ...type("cd")]).state;
    const back = drive(state, [KEY.left, KEY.left, KEY.left]); // from (1,2) → (1,0)... → (0,2)
    expect(back.state.row).toBe(0);
    expect(back.state.col).toBe(2);
    const forward = drive(back.state, [KEY.right]);
    expect(forward.state.row).toBe(1);
    expect(forward.state.col).toBe(0);
  });

  it("↑/↓ navigate WITHIN a multi-line buffer; history only at the edges", () => {
    const multi = drive(createEditorState(["old entry"]), [...type("first"), KEY.ctrlJ, ...type("second")]).state;
    expect(multi.row).toBe(1);
    const up = drive(multi, [KEY.up]); // moves to row 0 — NOT history
    expect(up.state.row).toBe(0);
    expect(editorText(up.state)).toBe("first\nsecond");
    const historyRecall = drive(up.state, [KEY.up]); // at row 0 → history
    expect(editorText(historyRecall.state)).toBe("old entry");
  });

  it("↑/↓ preserve the visual column across wide and ZWJ graphemes", () => {
    const family = "👨‍👩‍👧‍👦";
    const fromFamily: EditorState = {
      ...createEditorState(),
      lines: ["abcd", family],
      row: 1,
      col: family.length
    };
    expect(drive(fromFamily, [KEY.up]).state.col).toBe(2);

    const fromCjk: EditorState = {
      ...createEditorState(),
      lines: ["abcd", "汉"],
      row: 1,
      col: 1
    };
    expect(drive(fromCjk, [KEY.up]).state.col).toBe(2);
  });

  it("history: ↑ recalls, ↓ returns to the preserved draft (readline-compatible)", () => {
    const state = createEditorState(["one", "two"]);
    const typedDraft = drive(state, type("draft"));
    const up1 = drive(typedDraft.state, [KEY.up]);
    expect(editorText(up1.state)).toBe("two");
    const up2 = drive(up1.state, [KEY.up]);
    expect(editorText(up2.state)).toBe("one");
    const downTwice = drive(up2.state, [KEY.down, KEY.down]);
    expect(editorText(downTwice.state)).toBe("draft"); // the draft survives
  });

  it("submit records history (deduped against the last entry)", () => {
    const first = drive(createEditorState(), [...type("hello"), KEY.enter]);
    expect(first.state.history).toEqual(["hello"]);
    const again = drive(first.state, [...type("hello"), KEY.enter]);
    expect(again.state.history).toEqual(["hello"]); // no consecutive dupes
  });

  it("Ctrl+U / Ctrl+K / Ctrl+W kill; Ctrl+A / Ctrl+E jump", () => {
    const base = drive(createEditorState(), type("alpha beta gamma")).state;
    expect(drive(base, [KEY.ctrl("w")]).state.lines[0]).toBe("alpha beta ");
    expect(drive(base, [KEY.ctrl("u")]).state.lines[0]).toBe("");
    const mid = drive(base, [KEY.ctrl("a"), KEY.right, KEY.right, KEY.right, KEY.right, KEY.right]).state; // after "alpha"
    expect(drive(mid, [KEY.ctrl("k")]).state.lines[0]).toBe("alpha");
    expect(drive(base, [KEY.ctrl("a")]).state.col).toBe(0);
    expect(drive(base, [KEY.ctrl("e")]).state.col).toBe("alpha beta gamma".length);
  });

  it("Ctrl+W deletes a trailing emoji word whole (never splits a surrogate pair)", () => {
    // "foo 😀" — 😀 is a surrogate pair (2 UTF-16 units). Old code stepped back
    // one UTF-16 unit at a time, leaving a lone high surrogate (\uD83E) that
    // corrupted the buffer. The fix steps whole code points via prevCharLength.
    const withEmoji = drive(createEditorState(), type("foo 😀")).state;
    const after = drive(withEmoji, [KEY.ctrl("w")]).state;
    expect(after.lines[0]).toBe("foo ");
    // No lone surrogate left behind: every remaining char is a complete code point.
    const line = after.lines[0] ?? "";
    for (const char of line) {
      expect(char.codePointAt(0)).toBeLessThan(0xd800);
    }
    // An emoji-leading word deletes whole too.
    expect(drive(drive(createEditorState(), type("x 😀yo")).state, [KEY.ctrl("w")]).state.lines[0]).toBe("x ");
    // A CJK word deletes whole (汉 is BMP, exercises the same whole-step path).
    expect(drive(drive(createEditorState(), type("foo 汉")).state, [KEY.ctrl("w")]).state.lines[0]).toBe("foo ");
  });

  it("Ctrl+C interrupts; Ctrl+D on an EMPTY buffer is EOF, otherwise forward-deletes", () => {
    expect(drive(createEditorState(), [KEY.ctrl("c")]).effect.kind).toBe("interrupt");
    expect(drive(createEditorState(), [KEY.ctrl("d")]).effect.kind).toBe("eof");
    const withText = drive(createEditorState(), [...type("ab"), KEY.ctrl("a"), KEY.ctrl("d")]);
    expect(withText.state.lines[0]).toBe("b");
    expect(withText.effect.kind).toBe("render");
  });

  it.each([
    ["emoji modifier", "👍🏽"],
    ["ZWJ family", "👨‍👩‍👧‍👦"],
    ["regional-indicator flag", "🇺🇸"],
    ["combining sequence", "é"]
  ])("moves across and backspaces the whole %s grapheme", (_label, grapheme) => {
    const typed = drive(createEditorState(), [{ sequence: `A${grapheme}B` }]).state;
    const beforeGrapheme = drive(typed, [KEY.left, KEY.left]).state;
    expect(beforeGrapheme.col).toBe(1);

    const afterGrapheme = drive(beforeGrapheme, [KEY.right]).state;
    expect(afterGrapheme.col).toBe(1 + grapheme.length);

    const removed = drive(afterGrapheme, [KEY.backspace]).state;
    expect(removed.lines[0]).toBe("AB");
    expect(removed.col).toBe(1);
  });

  it.each([
    ["emoji modifier", "👍🏽"],
    ["ZWJ family", "👨‍👩‍👧‍👦"],
    ["regional-indicator flag", "🇺🇸"]
  ])("forward-deletes the whole %s grapheme", (_label, grapheme) => {
    const typed = drive(createEditorState(), [{ sequence: `${grapheme}B` }, KEY.ctrl("a")]).state;
    const removed = drive(typed, [{ name: "delete" }]).state;
    expect(removed.lines[0]).toBe("B");
    expect(removed.col).toBe(0);
  });
});

describe("renderEditorFrame — wrap-aware rows + cursor math", () => {
  const paint = createPainter({ level: "none" });
  const prompt = { text: "> ", width: 2 };

  it("single line renders one row with the prompt; cursor col accounts for it", () => {
    const state = drive(createEditorState(), type("hello")).state;
    const frame = renderEditorFrame(paint, state, prompt, 80);
    expect(frame.rows).toHaveLength(1);
    expect(frame.rows[0]).toBe("> hello");
    expect(frame.cursorRow).toBe(0);
    expect(frame.cursorCol).toBe(2 + 5 + 1);
  });

  it("logical lines beyond the first get continuation padding", () => {
    const state = drive(createEditorState(), [...type("one"), { name: "enter", sequence: "\n" }, ...type("two")]).state;
    const frame = renderEditorFrame(paint, state, prompt, 80);
    expect(frame.rows).toHaveLength(2);
    expect(frame.rows[1]).toBe("  two");
    expect(frame.cursorRow).toBe(1);
  });

  it("long lines WRAP at the content width and the cursor lands on the right visual row", () => {
    const state = drive(createEditorState(), type("x".repeat(15))).state;
    const frame = renderEditorFrame(paint, state, prompt, 12); // content width 10
    expect(frame.rows).toHaveLength(2);
    expect(frame.rows[0]).toBe(`> ${"x".repeat(10)}`);
    expect(frame.cursorRow).toBe(1); // cursor after char 15 → second visual row
    expect(frame.cursorCol).toBe(2 + 5 + 1);
  });

  it("CJK wraps by DISPLAY width (2 cells/char) so terminal rows match renderer rows", () => {
    const state = drive(createEditorState(), type("汉".repeat(8))).state; // 16 display cells
    const frame = renderEditorFrame(paint, state, prompt, 12); // content width 10 → 5 chars/row
    expect(frame.rows).toHaveLength(2);
    expect(frame.rows[0]).toBe(`> ${"汉".repeat(5)}`);
    expect(frame.rows[1]).toBe(`  ${"汉".repeat(3)}`);
    expect(frame.cursorRow).toBe(1);
    expect(frame.cursorCol).toBe(2 + 6 + 1); // 3 wide chars = 6 display cells
  });

  it("combining marks are ZERO display cells — composed text measures as its base char (review follow-up)", () => {
    expect(stringDisplayWidth("é")).toBe(1); // e + combining acute
    expect(stringDisplayWidth("a​b")).toBe(2); // zero-width space
    expect(charDisplayWidth(0xfe0f)).toBe(0); // variation selector
    const state = drive(createEditorState(), [{ sequence: "éx" }]).state;
    const frame = renderEditorFrame(paint, state, prompt, 80);
    expect(frame.cursorCol).toBe(2 + 2 + 1); // 2 cells, not 3
  });

  it("backspace over an emoji removes the WHOLE code point (never a lone surrogate)", () => {
    const typed = drive(createEditorState(), [{ sequence: "hi😀" }]).state;
    const backspaced = drive(typed, [KEY.backspace]);
    expect(backspaced.state.lines[0]).toBe("hi");
    const left = drive(typed, [KEY.left]);
    expect(left.state.col).toBe(2); // stepped over both UTF-16 units
  });

  it("EXACT wrap boundary: cursor at col n×contentWidth gets its own empty visual row (cursor wrap fix)", () => {
    const state = drive(createEditorState(), type("x".repeat(20))).state; // col 20 = 2×10
    const frame = renderEditorFrame(paint, state, prompt, 12);
    expect(frame.rows).toHaveLength(3); // two full rows + the empty cursor row
    expect(frame.cursorRow).toBe(2);
    expect(frame.cursorCol).toBe(2 + 1); // prompt pad + column 1
  });

  it.each([
    ["emoji modifier", "👍🏽"],
    ["ZWJ family", "👨‍👩‍👧‍👦"],
    ["regional-indicator flag", "🇺🇸"]
  ])("renders the %s grapheme as one two-cell glyph", (_label, grapheme) => {
    const state = drive(createEditorState(), [{ sequence: `${grapheme}x` }]).state;
    const frame = renderEditorFrame(paint, state, prompt, 80);
    expect(frame.rows).toEqual([`> ${grapheme}x`]);
    expect(frame.cursorCol).toBe(2 + 3 + 1);
  });

  it("keeps a regional-indicator flag intact when wrapping", () => {
    const state = drive(createEditorState(), [{ sequence: "xxxxx🇺🇸" }]).state;
    const frame = renderEditorFrame(paint, state, prompt, 8); // content width 6
    expect(frame.rows).toEqual(["> xxxxx", "  🇺🇸"]);
    expect(frame.cursorRow).toBe(1);
    expect(frame.cursorCol).toBe(2 + 2 + 1);
  });
});
