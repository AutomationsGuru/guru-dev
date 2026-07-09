import { visibleWidth } from "./components.js";
import type { Painter } from "./theme.js";

/**
 * The composer editor (P1 wave, ADR 2026-07-05-composer-editor): a pure
 * multi-line buffer + key reducer. No I/O here — the controller in guru.ts owns
 * raw keypresses and rendering; every key behavior is unit-testable in isolation.
 *
 * Key contract: Ctrl+J ALWAYS inserts a newline (the guaranteed multi-line path);
 * Shift+Enter does too where the terminal reports a distinct sequence; Enter
 * submits the whole buffer. ↑/↓ recall history only at the buffer's edges, so
 * single-line editing behaves exactly like readline did.
 */

export interface EditorState {
  readonly lines: readonly string[];
  readonly row: number;
  readonly col: number;
  readonly history: readonly string[];
  /** null = editing a fresh draft; otherwise index into history being viewed. */
  readonly historyIndex: number | null;
  /** The in-progress draft preserved while browsing history. */
  readonly draft: readonly string[] | null;
}

/** Parsed keypress (the shape Node's emitKeypressEvents produces). */
export interface EditorKey {
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  readonly sequence?: string;
}

export type EditorEffect =
  | { readonly kind: "none" }
  | { readonly kind: "render" }
  | { readonly kind: "submit"; readonly text: string }
  | { readonly kind: "interrupt" }
  | { readonly kind: "eof" };

export interface EditorStep {
  readonly state: EditorState;
  readonly effect: EditorEffect;
}

export function createEditorState(history: readonly string[] = []): EditorState {
  return { lines: [""], row: 0, col: 0, history, historyIndex: null, draft: null };
}

export function editorText(state: EditorState): string {
  return state.lines.join("\n");
}

export function isMultiline(state: EditorState): boolean {
  return state.lines.length > 1;
}

/** Replace the whole buffer (menu accept, history recall, @ insert). */
export function withBufferText(state: EditorState, text: string): EditorState {
  const lines = text.split("\n");
  const row = lines.length - 1;
  return { ...state, lines, row, col: lines[row]?.length ?? 0, historyIndex: state.historyIndex, draft: state.draft };
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

// ---------------------------------------------------------------------------
// Code-point + display-width helpers (adversarial review 2026-07-05): editing
// steps whole code points (never splits a surrogate pair), and wrapping counts
// DISPLAY columns (CJK/emoji are 2 cells) so the relative-move row accounting
// matches what the terminal actually draws.
// ---------------------------------------------------------------------------

/** Length in UTF-16 units of the code point ENDING at `col` (for backspace/←). */
function prevCharLength(line: string, col: number): number {
  if (col >= 2) {
    const high = line.charCodeAt(col - 2);
    const low = line.charCodeAt(col - 1);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
      return 2;
    }
  }
  return col > 0 ? 1 : 0;
}

/** Length in UTF-16 units of the code point STARTING at `col` (for delete/→). */
function nextCharLength(line: string, col: number): number {
  const code = line.charCodeAt(col);
  if (code >= 0xd800 && code <= 0xdbff && col + 1 < line.length) {
    const low = line.charCodeAt(col + 1);
    if (low >= 0xdc00 && low <= 0xdfff) {
      return 2;
    }
  }
  return col < line.length ? 1 : 0;
}

/** Display width of one code point: 0 for combining/zero-width, 2 for wide (CJK/emoji), else 1. */
export function charDisplayWidth(codePoint: number): number {
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) || // combining diacritics
    (codePoint >= 0x200b && codePoint <= 0x200f) || // zero-width space/joiners/marks
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || // variation selectors
    codePoint === 0xfeff // zero-width no-break space (BOM)
  ) {
    return 0; // composed text measures as its base char (CodeRabbit round 2)
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) || // CJK radicals … Yi
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compat ideographs
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK compat forms
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // fullwidth forms
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) || // emoji blocks
    (codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK ext B+
  ) {
    return 2;
  }
  return 1;
}

/** Total display width of a plain (unstyled) string. */
export function stringDisplayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += charDisplayWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

function currentLine(state: EditorState): string {
  return state.lines[state.row] ?? "";
}

function replaceLine(lines: readonly string[], row: number, text: string): string[] {
  const next = [...lines];
  next[row] = text;
  return next;
}

const render = (state: EditorState): EditorStep => ({ state, effect: { kind: "render" } });
const none = (state: EditorState): EditorStep => ({ state, effect: { kind: "none" } });

function insertText(state: EditorState, text: string): EditorState {
  const line = currentLine(state);
  const inserted = line.slice(0, state.col) + text + line.slice(state.col);
  return { ...state, lines: replaceLine(state.lines, state.row, inserted), col: state.col + text.length };
}

function insertNewline(state: EditorState): EditorState {
  const line = currentLine(state);
  const before = line.slice(0, state.col);
  const after = line.slice(state.col);
  const lines = [...state.lines];
  lines.splice(state.row, 1, before, after);
  return { ...state, lines, row: state.row + 1, col: 0 };
}

/**
 * Insert a pasted block at the cursor, LITERALLY — embedded newlines become
 * real buffer lines instead of each submitting (bracketed paste, ESC[200~…201~).
 * CR/CRLF are normalized to LF so a Windows-origin paste doesn't leave stray \r.
 */
function insertPaste(state: EditorState, text: string): EditorState {
  const normalized = text.replace(/\r\n?/gu, "\n");
  if (!normalized.includes("\n")) {
    return insertText(state, normalized);
  }
  // Drop a SINGLE trailing newline (review 2026-07-08): selecting a whole line
  // in most editors copies its trailing \n, so pasting "abc\n" produced an extra
  // blank buffer line and left the cursor on it. Only one is stripped — two+
  // trailing newlines are intentional (a pasted code block's spacing) and stay.
  const trimmed = normalized.endsWith("\n") && !normalized.endsWith("\n\n") ? normalized.slice(0, -1) : normalized;
  const segments = trimmed.split("\n");
  // After stripping one trailing newline, a "line copy" is a single segment — merge
  // inline (the multi-line splice would duplicate it into first+last rows).
  if (segments.length === 1) {
    return insertText(state, segments[0] ?? "");
  }
  const line = currentLine(state);
  const before = line.slice(0, state.col);
  const after = line.slice(state.col);
  const lastSegment = segments[segments.length - 1] ?? "";
  const merged = [before + (segments[0] ?? ""), ...segments.slice(1, -1), lastSegment + after];
  const lines = [...state.lines];
  lines.splice(state.row, 1, ...merged);
  return { ...state, lines, row: state.row + segments.length - 1, col: lastSegment.length };
}

function backspace(state: EditorState): EditorState {
  if (state.col > 0) {
    const line = currentLine(state);
    const step = prevCharLength(line, state.col); // whole code point, never half a surrogate
    const next = line.slice(0, state.col - step) + line.slice(state.col);
    return { ...state, lines: replaceLine(state.lines, state.row, next), col: state.col - step };
  }
  if (state.row > 0) {
    // Join with the previous line.
    const previous = state.lines[state.row - 1] ?? "";
    const lines = [...state.lines];
    lines.splice(state.row - 1, 2, previous + currentLine(state));
    return { ...state, lines, row: state.row - 1, col: previous.length };
  }
  return state;
}

function forwardDelete(state: EditorState): EditorState {
  const line = currentLine(state);
  if (state.col < line.length) {
    const step = nextCharLength(line, state.col);
    return { ...state, lines: replaceLine(state.lines, state.row, line.slice(0, state.col) + line.slice(state.col + step)) };
  }
  if (state.row < state.lines.length - 1) {
    const lines = [...state.lines];
    lines.splice(state.row, 2, line + (state.lines[state.row + 1] ?? ""));
    return { ...state, lines };
  }
  return state;
}

function moveLeft(state: EditorState): EditorState {
  if (state.col > 0) {
    return { ...state, col: state.col - prevCharLength(currentLine(state), state.col) };
  }
  if (state.row > 0) {
    return { ...state, row: state.row - 1, col: (state.lines[state.row - 1] ?? "").length };
  }
  return state;
}

function moveRight(state: EditorState): EditorState {
  const line = currentLine(state);
  if (state.col < line.length) {
    return { ...state, col: state.col + nextCharLength(line, state.col) };
  }
  if (state.row < state.lines.length - 1) {
    return { ...state, row: state.row + 1, col: 0 };
  }
  return state;
}

function deleteWordBack(state: EditorState): EditorState {
  const line = currentLine(state);
  if (state.col === 0) {
    return backspace(state); // join lines, readline-compatible enough
  }
  // Step back whole code points (never split a surrogate pair — adversarial
  // review 2026-07-08 found the old `cut -= 1` corrupted emoji/CJK mid-word).
  let cut = state.col;
  while (cut > 0) {
    const step = prevCharLength(line, cut);
    if (!/\s/u.test(line.slice(cut - step, cut) ?? "")) break;
    cut -= step;
  }
  while (cut > 0) {
    const step = prevCharLength(line, cut);
    if (/\s/u.test(line.slice(cut - step, cut) ?? "")) break;
    cut -= step;
  }
  return { ...state, lines: replaceLine(state.lines, state.row, line.slice(0, cut) + line.slice(state.col)), col: cut };
}

function recallHistory(state: EditorState, direction: -1 | 1): EditorState {
  if (state.history.length === 0) {
    return state;
  }
  if (direction === -1) {
    const index = state.historyIndex === null ? state.history.length - 1 : clamp(state.historyIndex - 1, 0, state.history.length - 1);
    if (state.historyIndex === 0) {
      return state; // already at the oldest entry
    }
    const draft = state.historyIndex === null ? state.lines : state.draft;
    const entry = state.history[index] ?? "";
    const lines = entry.split("\n");
    return { ...state, lines, row: lines.length - 1, col: lines[lines.length - 1]?.length ?? 0, historyIndex: index, draft };
  }
  // direction === 1: toward the draft
  if (state.historyIndex === null) {
    return state;
  }
  if (state.historyIndex >= state.history.length - 1) {
    const lines = state.draft && state.draft.length > 0 ? [...state.draft] : [""];
    return { ...state, lines, row: lines.length - 1, col: lines[lines.length - 1]?.length ?? 0, historyIndex: null, draft: null };
  }
  const index = state.historyIndex + 1;
  const entry = state.history[index] ?? "";
  const lines = entry.split("\n");
  return { ...state, lines, row: lines.length - 1, col: lines[lines.length - 1]?.length ?? 0, historyIndex: index };
}

/**
 * The reducer. Every behavior in the ADR key-map table lives here; the
 * controller only routes keys and renders.
 */
export function editorReduce(state: EditorState, key: EditorKey): EditorStep {
  const name = key.name ?? "";
  const sequence = key.sequence ?? "";

  // --- submission & newline (the contract) ---
  // Node's keypress model: "\n" parses as name "enter" — that IS Ctrl+J (LF),
  // distinct from Enter which sends "\r" (name "return"). So: enter/ctrl+j/
  // shift+return → newline; plain return → submit.
  if (name === "enter" || (key.ctrl === true && name === "j") || (name === "return" && key.shift === true)) {
    return render(insertNewline(state));
  }
  if (name === "return") {
    const text = editorText(state);
    const history = text.trim().length > 0 && state.history[state.history.length - 1] !== text ? [...state.history, text] : state.history;
    return {
      state: { ...createEditorState(history) },
      effect: { kind: "submit", text }
    };
  }

  // --- process control ---
  if (key.ctrl === true && name === "c") {
    return { state, effect: { kind: "interrupt" } };
  }
  if (key.ctrl === true && name === "d") {
    if (editorText(state).length === 0) {
      return { state, effect: { kind: "eof" } };
    }
    return render(forwardDelete(state));
  }

  // --- kill / word ops ---
  if (key.ctrl === true && name === "u") {
    const line = currentLine(state);
    return render({ ...state, lines: replaceLine(state.lines, state.row, line.slice(state.col)), col: 0 });
  }
  if (key.ctrl === true && name === "k") {
    const line = currentLine(state);
    return render({ ...state, lines: replaceLine(state.lines, state.row, line.slice(0, state.col)) });
  }
  if (key.ctrl === true && name === "w") {
    return render(deleteWordBack(state));
  }
  if (key.ctrl === true && name === "a") {
    return render({ ...state, col: 0 });
  }
  if (key.ctrl === true && name === "e") {
    return render({ ...state, col: currentLine(state).length });
  }

  // --- movement ---
  if (name === "left") {
    return render(moveLeft(state));
  }
  if (name === "right") {
    return render(moveRight(state));
  }
  if (name === "home") {
    return render({ ...state, col: 0 });
  }
  if (name === "end") {
    return render({ ...state, col: currentLine(state).length });
  }
  if (name === "up") {
    if (state.row > 0) {
      const row = state.row - 1;
      return render({ ...state, row, col: clamp(state.col, 0, (state.lines[row] ?? "").length) });
    }
    return render(recallHistory(state, -1)); // first row → history, readline-style
  }
  if (name === "down") {
    if (state.row < state.lines.length - 1) {
      const row = state.row + 1;
      return render({ ...state, row, col: clamp(state.col, 0, (state.lines[row] ?? "").length) });
    }
    return render(recallHistory(state, 1)); // last row → toward the draft
  }

  // --- deletion ---
  if (name === "backspace") {
    return render(backspace(state));
  }
  if (name === "delete") {
    return render(forwardDelete(state));
  }

  // --- bracketed paste: one literal insert, newlines and all (never per-line submit) ---
  if (name === "paste") {
    return render(insertPaste(state, sequence));
  }

  // --- printable ---
  if (sequence.length > 0 && !key.ctrl && !key.meta && !/^[\x00-\x1f\x7f]/u.test(sequence)) {
    return render(insertText(state, sequence));
  }

  return none(state);
}

// ---------------------------------------------------------------------------
// Rendering: wrap-aware rows + cursor math (pure; the controller writes them)
// ---------------------------------------------------------------------------

export interface EditorFrame {
  readonly rows: readonly string[];
  /** Visual position of the cursor within `rows` (0-based row, 1-based column). */
  readonly cursorRow: number;
  readonly cursorCol: number;
}

/**
 * Wrap the logical lines into visual rows at the terminal width. The first row
 * carries the prompt; logical lines after the first get a continuation pad of
 * the same width, so the text block aligns. Returns styled rows plus the
 * cursor's visual position for relative-move repositioning.
 */
export function renderEditorFrame(
  painter: Painter,
  state: EditorState,
  prompt: { readonly text: string; readonly width: number },
  columns: number
): EditorFrame {
  const width = Math.max(8, columns);
  const contentWidth = Math.max(1, width - prompt.width);
  const continuation = " ".repeat(prompt.width);
  const rows: string[] = [];
  let cursorRow = 0;
  let cursorCol = 1;

  state.lines.forEach((line, index) => {
    // Split into DISPLAY-width chunks, stepping whole code points: CJK/emoji
    // occupy 2 terminal cells, and slicing UTF-16 units would let the terminal
    // hard-wrap rows the renderer doesn't know about, breaking the relative-move
    // accounting (adversarial review 2026-07-05).
    const chunks: string[] = [];
    /** For the cursor: (chunkIndex, displayCol) for every UTF-16 offset boundary. */
    let cursorChunk = 0;
    let cursorDisplayCol = 0;
    let cursorPlaced = false;
    let current = "";
    let currentWidth = 0;
    let offset = 0;
    const placeCursorIfHere = (): void => {
      if (index === state.row && !cursorPlaced && offset === state.col) {
        cursorChunk = chunks.length;
        cursorDisplayCol = currentWidth;
        cursorPlaced = true;
      }
    };
    placeCursorIfHere();
    for (const char of line) {
      const width = charDisplayWidth(char.codePointAt(0) ?? 0);
      if (currentWidth + width > contentWidth && current.length > 0) {
        chunks.push(current);
        current = "";
        currentWidth = 0;
        placeCursorIfHere(); // exact-boundary cursor lands on the NEW row
      }
      current += char;
      currentWidth += width;
      offset += char.length;
      placeCursorIfHere();
    }
    chunks.push(current);
    if (index === state.row && !cursorPlaced) {
      cursorChunk = chunks.length - 1;
      cursorDisplayCol = currentWidth;
    }
    // Exact wrap boundary: a line filling its last chunk needs a trailing empty
    // row so the cursor after the final char lands on the NEXT visual row.
    if (index === state.row && state.col === line.length && currentWidth >= contentWidth && line.length > 0) {
      chunks.push("");
      cursorChunk = chunks.length - 1;
      cursorDisplayCol = 0;
    }
    chunks.forEach((chunk, chunkIndex) => {
      const lead = index === 0 && chunkIndex === 0 ? prompt.text : painter.fg("fgFaint", continuation);
      rows.push(`${lead}${chunk}`);
    });
    if (index === state.row) {
      cursorRow = rows.length - chunks.length + cursorChunk;
      cursorCol = prompt.width + cursorDisplayCol + 1;
    }
  });

  return { rows, cursorRow, cursorCol };
}

/** Width of the visible prompt text (strip styling before measuring). */
export function promptWidth(promptText: string): number {
  return visibleWidth(promptText);
}
