import { describe, expect, it } from "vitest";

import { createEditorState, editorReduce, editorText, type EditorKey } from "../../src/tui/editor.js";
import { createKeyDecoder, parseKeys } from "../../src/tui/keys.js";

describe("bracketed paste — multi-line pastes insert literally, never per-line submit", () => {
  it("parseKeys captures ESC[200~…ESC[201~ as ONE paste key (no stray return keys)", () => {
    const { keys } = parseKeys("\x1b[200~line one\r\nline two\x1b[201~");
    expect(keys).toEqual([{ name: "paste", sequence: "line one\r\nline two" }]);
    expect(keys.some((key) => key.name === "return" || key.name === "enter")).toBe(false);
  });

  it("a paste split across reads reassembles into one paste key (terminator arrives late)", () => {
    const seen: EditorKey[] = [];
    const decoder = createKeyDecoder((key) => seen.push(key));
    decoder.feed("\x1b[200~first\r"); // chunk ends mid-paste — must NOT submit the CR
    decoder.feed("second\x1b[201~"); // terminator arrives in the next read
    decoder.dispose();
    expect(seen).toEqual([{ name: "paste", sequence: "first\rsecond" }]);
  });

  it("editorReduce inserts a paste as literal buffer lines (CRLF normalized), NOT a submit", () => {
    const step = editorReduce(createEditorState(), { name: "paste", sequence: "alpha\r\nbeta\ngamma" });
    expect(step.effect.kind).toBe("render"); // the whole point: not "submit"
    expect(step.state.lines).toEqual(["alpha", "beta", "gamma"]);
    expect(editorText(step.state)).toBe("alpha\nbeta\ngamma");
  });

  it("a paste at the cursor preserves the text before and after it", () => {
    let state = createEditorState();
    state = editorReduce(state, { sequence: "XY" }).state; // type XY
    state = editorReduce(state, { name: "left" }).state; // cursor between X and Y
    const step = editorReduce(state, { name: "paste", sequence: "1\n2" });
    expect(step.state.lines).toEqual(["X1", "2Y"]);
  });

  it("a single-line paste is just an inline insert", () => {
    const step = editorReduce(createEditorState(), { name: "paste", sequence: "hello world" });
    expect(step.state.lines).toEqual(["hello world"]);
  });
});
