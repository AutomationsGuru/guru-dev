import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { attachComposer, type ComposerDeps } from "../../src/guru.js";
import type { MenuItem } from "../../src/tui/menu.js";

/**
 * Keystroke-level verification of the COMPOSER (ADR 2026-07-05): REAL bytes
 * through the keypress parser — "\n" IS Ctrl+J, "\r" IS Enter, arrows are
 * escape sequences — the same path a Windows Terminal keypress takes, minus
 * the physical TTY. Absorbs every regression from the old menu-controller rig.
 */

const KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  altEnter: "\x1b\r",
  ctrlJ: "\n",
  esc: "\x1b",
  tab: "\t",
  ctrlC: "\x03",
  ctrlD: "\x04",
  backspace: "\x7f"
};

interface Rig {
  type(text: string): Promise<void>;
  frames: string[];
  composer: ReturnType<typeof attachComposer>;
  submissions: string[];
  interrupts: number;
  collect(): void;
}

function rig(options: {
  drills?: Record<string, MenuItem[]>;
  chromeRows?: () => string[];
  pickFiles?: (query: string) => readonly string[];
  completePath?: ComposerDeps["completePath"];
  busy?: () => boolean;
  allowBusySteer?: () => boolean;
  steers?: string[];
  followUps?: string[];
  columns?: number | (() => number);
  headerRows?: () => string[];
} = {}): Rig {
  const input = new PassThrough();
  const frames: string[] = [];
  const commands: MenuItem[] = [
    { id: "/help", label: "/help", hint: "help" },
    { id: "/status", label: "/status", hint: "status" },
    { id: "/model", label: "/model", hint: "models", drillable: true },
    { id: "/resume", label: "/resume", hint: "resume", drillable: true }
  ];
  const steers = options.steers ?? [];
  const followUps = options.followUps ?? [];
  const deps: ComposerDeps = {
    input,
    output: {
      write: (text: string) => {
        frames.push(text);
        return true;
      }
    },
    interactive: true,
    promptText: "> ",
    columns: () => (typeof options.columns === "function" ? options.columns() : (options.columns ?? 100)),
    isBusy: options.busy ?? (() => false),
    ...(options.allowBusySteer ? { allowBusySteer: options.allowBusySteer } : {}),
    onBusySteer: (text) => {
      steers.push(text);
    },
    onBusyFollowUp: (text) => {
      followUps.push(text);
    },
    commandItems: (buffer) => commands.filter((c) => c.id.startsWith(buffer.trim()) || buffer.trim() === "/"),
    drillItems: (parentId) => options.drills?.[parentId] ?? [],
    ...(options.headerRows ? { headerRows: options.headerRows } : {}),
    ...(options.chromeRows ? { chromeRows: options.chromeRows } : {}),
    ...(options.pickFiles ? { pickFiles: options.pickFiles } : {}),
    ...(options.completePath ? { completePath: options.completePath } : {})
  };
  const composer = attachComposer(deps);
  const result: Rig = {
    frames,
    composer,
    submissions: [],
    interrupts: 0,
    async type(text: string) {
      input.write(text);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      // A lone ESC is held ~30ms by the decoder's grace timer (real-terminal
      // disambiguation from CSI sequences) — wait it out so the key lands.
      if (text === "\x1b") {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    },
    collect() {
      void (async () => {
        // background reader: accumulate submissions as they resolve
        for (;;) {
          const line = await composer.readLine();
          if (line === null) return;
          result.submissions.push(line);
        }
      })();
    }
  };
  composer.onInterrupt(() => {
    result.interrupts += 1;
  });
  return result;
}

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, "");
const visible = (frames: readonly string[]): string => stripAnsi(frames.join(""));

describe("composer — multi-line authoring (ACCEPTANCE)", () => {
  it("'line one' Ctrl+J 'line two' Enter → ONE submission containing the newline", async () => {
    const r = rig();
    r.collect();
    await r.type("line one");
    await r.type(KEYS.ctrlJ);
    await r.type("line two");
    expect(r.composer.bufferText()).toBe("line one\nline two");
    await r.type(KEYS.enter);
    expect(r.submissions).toEqual(["line one\nline two"]);
  });

  it("↑ recalls history when single-line; ↑ moves the cursor when multi-line and not on the first row", async () => {
    const r = rig();
    r.collect();
    await r.type(`first entry${KEYS.enter}`);
    expect(r.submissions).toEqual(["first entry"]);
    // Single-line: ↑ = history.
    await r.type(KEYS.up);
    expect(r.composer.bufferText()).toBe("first entry");
    await r.type("\x15"); // ctrl+u clears the recalled line
    // Multi-line: ↑ from the second row NAVIGATES, buffer intact.
    await r.type("aaa");
    await r.type(KEYS.ctrlJ);
    await r.type("bbb");
    await r.type(KEYS.up);
    expect(r.composer.bufferText()).toBe("aaa\nbbb"); // unchanged — no history swap
  });
});

describe("composer — @ file references (ACCEPTANCE)", () => {
  const files = ["src/compaction/cutPoint.ts", "src/compaction/engine.ts", "src/guru.ts"];
  const pickFiles = (query: string): readonly string[] =>
    files.filter((file) => {
      let at = -1;
      for (const char of query.toLowerCase()) {
        at = file.toLowerCase().indexOf(char, at + 1);
        if (at === -1) return false;
      }
      return true;
    });

  it("'@' opens the picker; typing filters; ⏎ replaces the @query with the path", async () => {
    const r = rig({ pickFiles });
    await r.type("look at @");
    expect(r.composer.isPickerOpen()).toBe(true);
    await r.type("cutP");
    expect(visible(r.frames)).toContain("src/compaction/cutPoint.ts");
    await r.type(KEYS.enter);
    expect(r.composer.isPickerOpen()).toBe(false);
    expect(r.composer.bufferText()).toBe("look at src/compaction/cutPoint.ts");
  });

  it("esc leaves the typed text as-is; deleting the @ closes the picker", async () => {
    const r = rig({ pickFiles });
    await r.type("@eng");
    expect(r.composer.isPickerOpen()).toBe(true);
    await r.type(KEYS.esc);
    expect(r.composer.isPickerOpen()).toBe(false);
    expect(r.composer.bufferText()).toBe("@eng");

    const r2 = rig({ pickFiles });
    await r2.type("@");
    expect(r2.composer.isPickerOpen()).toBe(true);
    await r2.type(KEYS.backspace);
    expect(r2.composer.isPickerOpen()).toBe(false);
  });
});

describe("composer — Tab path completion (ACCEPTANCE)", () => {
  it("completes the token at the cursor via the injected completer", async () => {
    const r = rig({
      completePath: (token) => (token === "src/comp" ? { completed: "src/compaction/", candidates: [] } : { completed: token, candidates: [] })
    });
    await r.type("read src/comp");
    await r.type(KEYS.tab);
    expect(r.composer.bufferText()).toBe("read src/compaction/");
  });
});

describe("composer — slash menu (regressions from the menu-controller rig)", () => {
  it("opens on '/', arrows move the selection, Enter runs the highlighted item", async () => {
    const r = rig();
    r.collect();
    await r.type("/");
    expect(r.composer.isMenuOpen()).toBe(true);
    expect(visible(r.frames)).toContain("/help");
    await r.type(KEYS.down);
    await r.type(KEYS.down); // selection: /model
    expect(visible(r.frames)).toContain("▸ /model");
    await r.type(KEYS.enter);
    expect(r.composer.takePendingSelection()).toBe("/model");
    expect(r.submissions.at(-1)).toBe("/"); // raw buffer submits; selection carries intent
  });

  it("up-arrow wraps the selection instead of triggering history", async () => {
    const r = rig();
    await r.type("/");
    await r.type(KEYS.up); // wraps to the last item
    expect(visible(r.frames)).toContain("▸ /resume");
    expect(r.composer.isMenuOpen()).toBe(true);
    expect(r.composer.bufferText()).toBe("/"); // buffer untouched
  });

  it("right-arrow drills /model; Enter picks a route with args", async () => {
    const r = rig({
      drills: { "/model": [{ id: "/model 1", label: "zai/glm-5-turbo", hint: "ready" }, { id: "/model 2", label: "sakana/fugu-ultra", hint: "ready" }] }
    });
    r.collect();
    await r.type("/");
    await r.type(KEYS.down);
    await r.type(KEYS.down); // /model
    await r.type(KEYS.right); // drill
    expect(visible(r.frames)).toContain("zai/glm-5-turbo");
    expect(visible(r.frames)).toContain("/model › ");
    await r.type(KEYS.down);
    expect(visible(r.frames)).toContain("▸ sakana/fugu-ultra");
    await r.type(KEYS.enter);
    expect(r.composer.takePendingSelection()).toBe("/model 2");
  });

  it("left-arrow returns from a drill to the command list", async () => {
    const r = rig({ drills: { "/model": [{ id: "/model 1", label: "route-a", hint: "" }] } });
    await r.type("/");
    await r.type(KEYS.down);
    await r.type(KEYS.down);
    await r.type(KEYS.right);
    expect(visible(r.frames)).toContain("route-a");
    await r.type(KEYS.left);
    expect(visible(r.frames)).toContain("/help");
  });

  it("typing filters; deleting the slash closes the menu", async () => {
    const r = rig();
    await r.type("/");
    await r.type("m");
    expect(visible(r.frames)).toContain("/model");
    await r.type(KEYS.backspace);
    await r.type(KEYS.backspace);
    expect(r.composer.isMenuOpen()).toBe(false);
  });

  it("plain chat text never opens the menu and Enter yields no pending selection", async () => {
    const r = rig();
    r.collect();
    await r.type("hello");
    expect(r.composer.isMenuOpen()).toBe(false);
    await r.type(KEYS.enter);
    expect(r.composer.takePendingSelection()).toBeNull();
    expect(r.submissions.at(-1)).toBe("hello");
  });
});

describe("composer — adversarial-review regressions (2026-07-05)", () => {
  it("CRITICAL: a multi-line paste with several Enters loses NOTHING (submissions queue)", async () => {
    const r = rig();
    // No readLine armed yet — all three land in one chunk (a real paste).
    await r.type("first\rsecond\rthird\r");
    expect(await r.composer.readLine()).toBe("first");
    expect(await r.composer.readLine()).toBe("second");
    expect(await r.composer.readLine()).toBe("third");
  });

  it("concurrent readLine() calls queue FIFO — the first reader is never overwritten (CodeRabbit round 2)", async () => {
    const r = rig();
    const first = r.composer.readLine();
    const second = r.composer.readLine();
    await r.type("one\rtwo\r");
    expect(await first).toBe("one");
    expect(await second).toBe("two");
    // close() resolves any still-pending readers with null (no hang)
    const third = r.composer.readLine();
    r.composer.close();
    expect(await third).toBeNull();
  });

  it("CRLF paste submits ONCE per line — no stray leading newline in the next buffer", async () => {
    const r = rig();
    await r.type("alpha\r\nbeta");
    expect(await r.composer.readLine()).toBe("alpha");
    expect(r.composer.bufferText()).toBe("beta"); // no leading \n
  });

  it("'@' mid-word (emails, handles) does NOT open the picker; word-boundary '@' does", async () => {
    const r = rig({ pickFiles: () => ["a.ts"] });
    await r.type("mail me at matt@example.com");
    expect(r.composer.isPickerOpen()).toBe(false);
    await r.type(" @a");
    expect(r.composer.isPickerOpen()).toBe(true);
  });

  it("a space in the @query closes the picker (prose, not a file reference)", async () => {
    const r = rig({ pickFiles: () => [] });
    await r.type("@and then");
    expect(r.composer.isPickerOpen()).toBe(false);
  });

  it("Enter with a ZERO-match picker submits the buffer instead of being eaten", async () => {
    const r = rig({ pickFiles: () => [] });
    r.collect();
    await r.type("@nomatch");
    await r.type(KEYS.enter);
    expect(r.submissions).toEqual(["@nomatch"]);
    expect(r.composer.isPickerOpen()).toBe(false);
  });

  it("accepting a selection replaces the WHOLE @token even with the cursor mid-query", async () => {
    const r = rig({ pickFiles: () => ["src/pick.ts"] });
    await r.type("@pickX");
    await r.type(KEYS.left); // cursor before the X, inside the query
    await r.type(KEYS.enter);
    expect(r.composer.bufferText()).toBe("src/pick.ts"); // no leftover 'X' glued on
  });

  it("split UTF-8 bytes across chunks decode correctly (StringDecoder)", async () => {
    const input = new PassThrough();
    const composer = attachComposer({
      input,
      output: { write: () => true },
      interactive: true,
      promptText: "> ",
      columns: () => 80,
      isBusy: () => false,
      commandItems: () => [],
      drillItems: () => []
    });
    const bytes = Buffer.from("héllo", "utf8"); // é = 2 bytes, split inside it
    input.write(bytes.subarray(0, 2));
    await new Promise((resolve) => setImmediate(resolve));
    input.write(bytes.subarray(2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(composer.bufferText()).toBe("héllo");
    composer.close();
  });

  it("close() restores raw mode and pauses stdin (no post-exit hang)", async () => {
    const calls: string[] = [];
    const input = new PassThrough() as PassThrough & { setRawMode?: (mode: boolean) => void; pause?: () => void };
    input.setRawMode = (mode: boolean) => {
      calls.push(`raw:${mode}`);
    };
    const originalPause = input.pause.bind(input);
    input.pause = () => {
      calls.push("pause");
      return originalPause();
    };
    const composer = attachComposer({
      input,
      output: { write: () => true },
      interactive: true,
      promptText: "> ",
      columns: () => 80,
      isBusy: () => false,
      commandItems: () => [],
      drillItems: () => []
    });
    composer.close();
    expect(calls).toContain("raw:true");
    expect(calls).toContain("raw:false");
    expect(calls).toContain("pause");
  });

  it("resize reflow: forceRefresh() clears from the reflowed block top at the new width", async () => {
    let width = 100;
    const r = rig({ columns: () => width, chromeRows: () => ["CHROME"] });
    r.composer.beginPrompt();
    await r.type("x".repeat(120));

    r.frames.length = 0;
    width = 40;
    r.composer.forceRefresh();

    // The old 99-cell first editor row reflows into three 40-column rows.
    // Repaint must move above all three before clearing or stale prompt rows stack.
    expect(r.frames[0]).toBe("\x1b[3A");
    expect(r.frames[1]).toBe("\x1b[1G\x1b[0J");
  });

  it("resize reflow: forceRefresh() redraws header chrome with the managed block", async () => {
    let width = 100;
    const r = rig({
      columns: () => width,
      headerRows: () => ["R".repeat(width - 1)],
      chromeRows: () => ["CHROME"]
    });
    r.composer.beginPrompt();
    await r.type("x".repeat(120));

    r.frames.length = 0;
    width = 40;
    r.composer.forceRefresh();

    // Both the old 99-cell header and first editor row reflow to three rows.
    expect(r.frames[0]).toBe("\x1b[6A");
    expect(stripAnsi(r.frames.join(""))).toContain("R".repeat(39));
  });
});

describe("composer — chrome + rendering invariants", () => {
  it("pins the chrome below a MULTI-LINE buffer (status bar + hint reflow under 3 rows)", async () => {
    const r = rig({ chromeRows: () => ["STATUS-BAR-mark", "HINT-mark"] });
    r.composer.beginPrompt();
    await r.type("one");
    await r.type(KEYS.ctrlJ);
    await r.type("two");
    await r.type(KEYS.ctrlJ);
    await r.type("three");
    const all = visible(r.frames);
    expect(all).toContain("STATUS-BAR-mark");
    expect(all).toContain("HINT-mark");
    expect(r.composer.bufferText()).toBe("one\ntwo\nthree");
    // The last frame must contain all three buffer rows AND the chrome below them.
    const lastFrame = stripAnsi(r.frames.slice(-8).join(""));
    expect(lastFrame).toContain("three");
    expect(lastFrame).toContain("STATUS-BAR-mark");
  });

  it("REGRESSION (field bug): relative cursor moves only — DECSC/DECRC stay banned", async () => {
    const r = rig({ chromeRows: () => ["chrome"] });
    r.composer.beginPrompt();
    await r.type("/");
    await r.type(KEYS.down);
    await r.type("x".repeat(120)); // force a wrapped row too
    const all = r.frames.join("");
    expect(all).not.toContain("\x1b7"); // DECSC banned
    expect(all).not.toContain("\x1b8"); // DECRC banned
    expect(all).toContain("\x1b[0J"); // relative clear-below
    expect(/\x1b\[\d+A/u.test(all)).toBe(true); // relative cursor-up
  });

  it("REGRESSION (field bug): full-width chrome never fills terminal columns (xenl)", async () => {
    // A full-width status bar soft-wraps on Windows Terminal / xterm (xenl): the
    // cursor drops a phantom row, relative CUU undercounts, and every keystroke
    // stacks a dead `▸ …` line. Paint must reserve one trailing cell.
    const cols = 40;
    const r = rig({
      columns: cols,
      chromeRows: () => ["S".repeat(cols), "H".repeat(cols)]
    });
    r.composer.beginPrompt();
    await r.type("abc");
    const all = r.frames.join("");
    // Full-width input must be clamped away — the raw cols-wide strings never paint.
    expect(all).not.toContain("S".repeat(cols));
    expect(all).not.toContain("H".repeat(cols));
    // And the clamped forms DO paint (one cell reserved).
    expect(all).toContain("S".repeat(cols - 1));
    expect(all).toContain("H".repeat(cols - 1));
    // At least beginPrompt + one keystroke repaint clear in place.
    expect((all.match(/\x1b\[0J/gu) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("REGRESSION (field bug): successive keystrokes with chrome re-clear in place", async () => {
    const r = rig({ chromeRows: () => ["STATUS-BAR", "HINT"] });
    r.composer.beginPrompt();
    r.frames.length = 0;
    await r.type("x");
    await r.type("y");
    await r.type("z");
    const all = r.frames.join("");
    // Three separate keystrokes → three clear-below rewrites of the buffer.
    expect((all.match(/\x1b\[0J/gu) ?? []).length).toBe(3);
    // Chrome is below the cursor → each paint ends with CUU from the chrome.
    expect((all.match(/\x1b\[\d+A/gu) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(stripAnsi(all)).toContain("xyz");
    expect(r.composer.bufferText()).toBe("xyz");
  });

  it("ctrl+c raises interrupt; ctrl+d on an empty buffer closes (EOF → readLine null)", async () => {
    const r = rig();
    const pending = r.composer.readLine();
    await r.type(KEYS.ctrlC);
    expect(r.interrupts).toBe(1);
    await r.type(KEYS.ctrlD);
    expect(await pending).toBeNull();
  });

  it("busy turns: Esc/Ctrl+C interrupt; type+Enter steers; no full composer repaint", async () => {
    let busy = true;
    const steers: string[] = [];
    const r = rig({ busy: () => busy, steers });
    const before = r.frames.length;
    // Mid-turn draft accumulates + writes feedback lines (not a full composer frame).
    await r.type("focus the parser");
    expect(r.frames.length).toBeGreaterThan(before); // busy feedback lines
    expect(r.frames.join("")).toMatch(/steering…/u);
    expect(r.composer.bufferText()).toBe(""); // main buffer untouched mid-turn
    await r.type(KEYS.enter);
    expect(steers).toEqual(["focus the parser"]);
    // Esc aborts the running turn (same handler as ctrl+c).
    await r.type(KEYS.esc);
    expect(r.interrupts).toBe(1);
    await r.type(KEYS.ctrlC);
    expect(r.interrupts).toBe(2);
    // Approval gate: steer accumulation suppressed.
    const steers2: string[] = [];
    const r2 = rig({ busy: () => true, allowBusySteer: () => false, steers: steers2 });
    await r2.type("y");
    await r2.type(KEYS.enter);
    expect(steers2).toEqual([]);
    busy = false;
    await r.type("live");
    expect(r.composer.bufferText()).toBe("live");
  });

  it("busy turns: Alt+Enter queues a follow-up instead of steering", async () => {
    const steers: string[] = [];
    const followUps: string[] = [];
    const r = rig({ busy: () => true, steers, followUps });
    await r.type("then run tests");
    await r.type(KEYS.altEnter);
    expect(steers).toEqual([]);
    expect(followUps).toEqual(["then run tests"]);
    expect(r.frames.join("")).toMatch(/follow-up queued/u);
  });
});
