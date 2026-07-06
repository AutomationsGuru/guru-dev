import type { EditorKey } from "./editor.js";

/**
 * Hand-rolled key decoder (P1 composer wave). Node's standalone
 * emitKeypressEvents buffers a lone ESC indefinitely (the escape timeout lives
 * in readline's Interface, which the composer replaced) — a real Esc press
 * would hang until the next key. This decoder parses raw byte chunks directly:
 * deterministic, paste-friendly (printable runs become ONE key), and it
 * understands the CSI-u / modifyOtherKeys encodings some terminals use for
 * Shift+Enter — the "where the terminal reports it" path of the ADR contract.
 */

export interface ParsedChunk {
  readonly keys: readonly EditorKey[];
  /**
   * Unconsumed trailing bytes (a lone ESC, or a CSI truncated at the chunk
   * edge, e.g. "\x1b[1;2") — the caller holds THE WHOLE TAIL and re-prefixes
   * it to the next chunk so split sequences decode correctly (CodeRabbit
   * 2026-07-05: re-prefixing only "\x1b" dropped the params).
   */
  readonly pending?: string;
}

const CTRL_NAMES: Readonly<Record<number, string>> = {
  0x01: "a",
  0x02: "b",
  0x03: "c",
  0x04: "d",
  0x05: "e",
  0x06: "f",
  0x0b: "k",
  0x0c: "l",
  0x0e: "n",
  0x10: "p",
  0x12: "r",
  0x14: "t",
  0x15: "u",
  0x17: "w",
  0x19: "y",
  0x1a: "z"
};

const CSI_FINAL: Readonly<Record<string, string>> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "tab" // \x1b[Z = shift-tab
};

const CSI_TILDE: Readonly<Record<string, string>> = {
  "1": "home",
  "3": "delete",
  "4": "end",
  "7": "home",
  "8": "end"
};

/** Parse one raw chunk into editor keys. Pure — the ESC grace timer lives in the caller. */
export function parseKeys(chunk: string): ParsedChunk {
  const keys: EditorKey[] = [];
  let at = 0;
  let printable = "";
  const flushPrintable = (): void => {
    if (printable.length > 0) {
      keys.push(printable.length === 1 ? { sequence: printable, name: printable.toLowerCase() } : { sequence: printable });
      printable = "";
    }
  };

  while (at < chunk.length) {
    const char = chunk[at] as string;
    const code = chunk.charCodeAt(at);

    if (char === "\x1b") {
      flushPrintable();
      const next = chunk[at + 1];
      if (next === undefined) {
        return { keys, pending: "\x1b" }; // lone trailing ESC — caller holds it
      }
      if (next === "[" || next === "O") {
        // CSI / SS3 sequence: params then a final byte. ':' joins subparams
        // (kitty keycode:alternates, modifiers:event-type) — stopping at it
        // would split the sequence and type the tail as text (CodeRabbit
        // round 2).
        let end = at + 2;
        while (end < chunk.length && /[\d;:]/u.test(chunk[end] as string)) {
          end += 1;
        }
        const final = chunk[end];
        const params = chunk.slice(at + 2, end);
        if (final === undefined) {
          // Truncated sequence at the chunk edge — hold the WHOLE tail (rare;
          // real terminals send sequences whole).
          return { keys, pending: chunk.slice(at) };
        }
        const sequence = chunk.slice(at, end + 1);
        if (final === "~") {
          const [head = "", mod = ""] = params.split(";");
          // modifyOtherKeys: ESC [ 27 ; <mod> ; 13 ~  → Enter with modifiers.
          const parts = params.split(";");
          if (head === "27" && parts[2] === "13") {
            keys.push({ name: "return", shift: mod === "2" || mod === "4", sequence });
          } else {
            const name = CSI_TILDE[head];
            if (name) {
              keys.push({ name, sequence });
            }
          }
        } else if (final === "u") {
          // CSI-u (kitty): ESC [ 13 ; <mod> u → Enter with modifiers. Sub-
          // params after ':' (alternate keys, event types) are ignored.
          const [head = "", mod = ""] = params.split(";");
          const keycode = head.split(":")[0];
          const modifier = mod.split(":")[0];
          if (keycode === "13") {
            keys.push({ name: "return", shift: modifier === "2" || modifier === "4", sequence });
          } else if (keycode === "10") {
            keys.push({ name: "enter", sequence }); // LF keycode
          }
        } else {
          const name = CSI_FINAL[final];
          if (name) {
            keys.push({ name, shift: final === "Z" || params.endsWith(";2"), sequence });
          }
        }
        at = end + 1;
        continue;
      }
      if (next === "\x1b") {
        keys.push({ name: "escape", sequence: "\x1b" });
        at += 2;
        continue;
      }
      // ESC + ordinary char = meta chord (alt+x): swallow, no editor meaning yet.
      keys.push({ name: next, meta: true, sequence: chunk.slice(at, at + 2) });
      at += 2;
      continue;
    }

    if (char === "\r") {
      flushPrintable();
      keys.push({ name: "return", sequence: "\r" });
      if (chunk[at + 1] === "\n") {
        at += 1; // CRLF pairs coalesce into ONE return (Windows-origin pastes)
      }
    } else if (char === "\n") {
      flushPrintable();
      keys.push({ name: "enter", sequence: "\n" }); // LF IS Ctrl+J
    } else if (char === "\t") {
      flushPrintable();
      keys.push({ name: "tab", sequence: "\t" });
    } else if (code === 0x7f || code === 0x08) {
      flushPrintable();
      keys.push({ name: "backspace", sequence: char });
    } else if (code === 0x0a) {
      flushPrintable();
      keys.push({ name: "enter", sequence: "\n" });
    } else if (code === 0x0d) {
      flushPrintable();
      keys.push({ name: "return", sequence: "\r" });
    } else if (code < 0x20) {
      flushPrintable();
      const name = CTRL_NAMES[code];
      if (name) {
        keys.push({ name, ctrl: true, sequence: char });
      }
    } else {
      printable += char;
    }
    at += 1;
  }

  flushPrintable();
  return { keys };
}

export interface KeyDecoder {
  /** Feed a raw chunk; emits parsed keys via the handler (ESC grace handled). */
  feed(chunk: string): void;
  /** Cancel the pending-ESC timer (on close). */
  dispose(): void;
}

/**
 * Stateful wrapper: holds a lone ESC for `escGraceMs` in case its CSI
 * continuation arrives in the next chunk; emits a real `escape` key when the
 * grace expires. Real terminals send complete sequences in one read, so the
 * grace only ever fires for an actual Esc press.
 */
export function createKeyDecoder(onKey: (key: EditorKey) => void, escGraceMs = 30): KeyDecoder {
  let held = "";
  let timer: NodeJS.Timeout | undefined;

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const feed = (chunk: string): void => {
    clearTimer();
    const effective = `${held}${chunk}`;
    held = "";
    const parsed = parseKeys(effective);
    for (const key of parsed.keys) {
      onKey(key);
    }
    if (parsed.pending !== undefined) {
      held = parsed.pending;
      timer = setTimeout(() => {
        const wasLoneEsc = held === "\x1b";
        held = "";
        if (wasLoneEsc) {
          onKey({ name: "escape", sequence: "\x1b" });
        }
        // A truncated CSI that never completed is dropped — there is no honest
        // key to synthesize from half a sequence.
      }, escGraceMs);
    }
  };

  return { feed, dispose: clearTimer };
}
