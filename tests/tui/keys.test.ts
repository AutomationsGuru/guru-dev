import { describe, expect, it } from "vitest";

import { createKeyDecoder, parseKeys } from "../../src/tui/keys.js";
import type { EditorKey } from "../../src/tui/editor.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("parseKeys — table-driven decoder branches", () => {
  const cases: ReadonlyArray<{ bytes: string; expect: Partial<EditorKey>; label: string }> = [
    { label: "Enter (CR)", bytes: "\r", expect: { name: "return" } },
    { label: "Ctrl+J (LF)", bytes: "\n", expect: { name: "enter" } },
    { label: "Tab", bytes: "\t", expect: { name: "tab" } },
    { label: "backspace 0x7f", bytes: "\x7f", expect: { name: "backspace" } },
    { label: "backspace 0x08", bytes: "\x08", expect: { name: "backspace" } },
    { label: "Ctrl+C", bytes: "\x03", expect: { name: "c", ctrl: true } },
    { label: "Ctrl+U", bytes: "\x15", expect: { name: "u", ctrl: true } },
    { label: "arrow up", bytes: "\x1b[A", expect: { name: "up" } },
    { label: "arrow left", bytes: "\x1b[D", expect: { name: "left" } },
    { label: "home CSI H", bytes: "\x1b[H", expect: { name: "home" } },
    { label: "end CSI F", bytes: "\x1b[F", expect: { name: "end" } },
    { label: "home tilde", bytes: "\x1b[1~", expect: { name: "home" } },
    { label: "delete tilde", bytes: "\x1b[3~", expect: { name: "delete" } },
    { label: "shift-tab CSI Z", bytes: "\x1b[Z", expect: { name: "tab", shift: true } },
    { label: "Shift+Enter CSI-u (kitty)", bytes: "\x1b[13;2u", expect: { name: "return", shift: true } },
    { label: "Shift+Enter CSI-u with ':' subparams (kitty)", bytes: "\x1b[13:13;2:1u", expect: { name: "return", shift: true } },
    { label: "Shift+Enter modifyOtherKeys", bytes: "\x1b[27;2;13~", expect: { name: "return", shift: true } },
    { label: "Alt+Enter modifyOtherKeys (WT/xterm)", bytes: "\x1b[27;3;13~", expect: { name: "return", meta: true } },
    { label: "Alt+Enter CSI-u (kitty)", bytes: "\x1b[13;3u", expect: { name: "return", meta: true } },
    { label: "Ctrl+Enter modifyOtherKeys", bytes: "\x1b[27;5;13~", expect: { name: "return", ctrl: true } },
    { label: "plain Enter CSI-u (unshifted)", bytes: "\x1b[13;1u", expect: { name: "return", shift: false } },
    { label: "shifted arrow \\x1b[1;2A", bytes: "\x1b[1;2A", expect: { name: "up", shift: true } },
    { label: "double ESC", bytes: "\x1b\x1b", expect: { name: "escape" } },
    { label: "Alt+Enter (ESC+CR)", bytes: "\x1b\r", expect: { name: "return", meta: true } }
  ];

  for (const testCase of cases) {
    it(testCase.label, () => {
      const parsed = parseKeys(testCase.bytes);
      expect(parsed.keys).toHaveLength(1);
      for (const [field, value] of Object.entries(testCase.expect)) {
        expect(parsed.keys[0]?.[field as keyof EditorKey], `${testCase.label}.${field}`).toBe(value);
      }
    });
  }

  it("':' subparams stay inside the CSI — no tail typed as text (review follow-up)", () => {
    const parsed = parseKeys("\x1b[13:2u");
    expect(parsed.keys).toHaveLength(1);
    expect(parsed.keys[0]?.name).toBe("return");
  });

  it("batches printable runs into ONE key (paste-friendly) and splits around controls", () => {
    const parsed = parseKeys("hello\rworld");
    expect(parsed.keys.map((key) => key.name ?? key.sequence)).toEqual(["hello", "return", "world"]);
  });

  it("CRLF is ONE 'return' (Windows ConPTY / mintty Enter), not submit + newline", () => {
    const parsed = parseKeys("\r\n");
    expect(parsed.keys).toHaveLength(1);
    expect(parsed.keys[0]?.name).toBe("return");
  });

  it("bare LF is 'enter' (Ctrl+J newline contract), untouched", () => {
    const parsed = parseKeys("\n");
    expect(parsed.keys).toHaveLength(1);
    expect(parsed.keys[0]?.name).toBe("enter");
  });

  it("CRLF inside a paste stays a single 'return' between printable runs", () => {
    const parsed = parseKeys("hello\r\nworld");
    expect(parsed.keys.map((key) => key.name ?? key.sequence)).toEqual(["hello", "return", "world"]);
  });

  it("lone trailing ESC → pending '\\x1b'; truncated CSI → the WHOLE tail is pending", () => {
    expect(parseKeys("abc\x1b").pending).toBe("\x1b");
    expect(parseKeys("\x1b[1;2").pending).toBe("\x1b[1;2");
    expect(parseKeys("x").pending).toBeUndefined();
  });

  it("alt-chords (ESC + char) are swallowed as meta, never inserted", () => {
    const parsed = parseKeys("\x1bx");
    expect(parsed.keys).toHaveLength(1);
    expect(parsed.keys[0]?.meta).toBe(true);
  });
});

describe("createKeyDecoder — the ESC grace + split-sequence reassembly", () => {
  it("a lone ESC emits 'escape' after the grace expires", async () => {
    const keys: EditorKey[] = [];
    const decoder = createKeyDecoder((key) => keys.push(key), 15);
    decoder.feed("\x1b");
    expect(keys).toHaveLength(0); // held
    await sleep(40);
    expect(keys.map((key) => key.name)).toEqual(["escape"]);
    decoder.dispose();
  });

  it("a CSI split across chunks reassembles into ONE arrow key (regression: tail preserved)", async () => {
    const keys: EditorKey[] = [];
    const decoder = createKeyDecoder((key) => keys.push(key), 15);
    decoder.feed("\x1b[");
    decoder.feed("A");
    expect(keys.map((key) => key.name)).toEqual(["up"]);
    decoder.feed("\x1b[1;2");
    decoder.feed("u"); // completes \x1b[1;2u — unknown CSI-u keycode, dropped silently
    decoder.feed("\x1b[13;2");
    decoder.feed("u"); // completes Shift+Enter
    expect(keys.map((key) => key.name)).toEqual(["up", "return"]);
    expect(keys[1]?.shift).toBe(true);
    decoder.dispose();
  });

  it("ESC followed quickly by a printable becomes a meta chord, not escape+char", async () => {
    const keys: EditorKey[] = [];
    const decoder = createKeyDecoder((key) => keys.push(key), 15);
    decoder.feed("\x1b");
    decoder.feed("f"); // within the grace → alt+f chord
    expect(keys).toHaveLength(1);
    expect(keys[0]?.meta).toBe(true);
    await sleep(40); // grace must NOT fire a stray escape afterwards
    expect(keys).toHaveLength(1);
    decoder.dispose();
  });

  it("a truncated CSI that never completes is dropped (no phantom escape)", async () => {
    const keys: EditorKey[] = [];
    const decoder = createKeyDecoder((key) => keys.push(key), 15);
    decoder.feed("\x1b[9;9");
    await sleep(40);
    expect(keys).toHaveLength(0);
    decoder.dispose();
  });
});
