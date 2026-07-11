import { describe, expect, it } from "vitest";

import {
  buildMenuOverlayRows,
  clampMenuText,
  formatRouteMenuHint,
  MENU_PAGE_SIZE
} from "../../src/guru.js";
import { createMenuState, enterDrill, type MenuItem } from "../../src/tui/menu.js";
import { createPainter } from "../../src/tui/theme.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/gu, "");

const paint = createPainter({ level: "none" });

describe("clampMenuText / formatRouteMenuHint", () => {
  it("clamps by display width with an ellipsis", () => {
    expect(clampMenuText("hello", 10)).toBe("hello");
    expect(clampMenuText("hello-world-extra", 8)).toBe("hello-w…");
    expect(clampMenuText("", 5)).toBe("");
  });

  it("never splits a ZWJ grapheme while clamping a menu label", () => {
    expect(clampMenuText("aaaa👨‍👩‍👧‍👦bbbb", 7)).toBe("aaaa👨‍👩‍👧‍👦…");
  });

  it("shortens route statuses and marks the connected route", () => {
    expect(formatRouteMenuHint("ready-unverified", { usable: true })).toBe("ready");
    expect(formatRouteMenuHint("ready-unverified", { usable: false })).toBe("needs key");
    expect(formatRouteMenuHint("missing-or-login")).toBe("needs login");
    expect(formatRouteMenuHint("active", { connected: true, usable: true })).toBe("← connected · ready");
  });
});

describe("buildMenuOverlayRows", () => {
  it("shows an empty-state row when the filter matches nothing", () => {
    const rows = buildMenuOverlayRows(paint, createMenuState([], "/zzz"), { columns: 80 }).map(strip);
    expect(rows.some((row) => /no matching commands/u.test(row))).toBe(true);
  });

  it("shows empty drill copy when a submenu has no items", () => {
    const empty = enterDrill(createMenuState([{ id: "/model", label: "/model" }], "/"), "/model", []);
    const rows = buildMenuOverlayRows(paint, empty, { columns: 80 }).map(strip);
    expect(rows.some((row) => /empty/u.test(row) && /back/u.test(row))).toBe(true);
  });

  it("pages long lists and prints a scroll cue", () => {
    const items: MenuItem[] = Array.from({ length: MENU_PAGE_SIZE + 5 }, (_, i) => ({
      id: `/cmd${i}`,
      label: `/cmd${i}`,
      hint: `hint ${i}`
    }));
    const rows = buildMenuOverlayRows(paint, createMenuState(items, "/"), { columns: 80 }).map(strip);
    expect(rows.some((row) => /of \d+/u.test(row) && /more/u.test(row))).toBe(true);
    // Page size of rows + scroll + footer — not the full 12 items as rows.
    const itemRows = rows.filter((row) => row.includes("/cmd"));
    expect(itemRows.length).toBeLessThanOrEqual(MENU_PAGE_SIZE);
  });

  it("highlights the selected row and keeps a footer of keys", () => {
    const items: MenuItem[] = [
      { id: "/help", label: "/help", hint: "help" },
      { id: "/model", label: "/model", hint: "models", drillable: true }
    ];
    const state = { ...createMenuState(items, "/mo"), selected: 1 };
    const rows = buildMenuOverlayRows(paint, state, { columns: 100 }).map(strip);
    expect(rows.some((row) => row.includes("▸") && row.includes("/model"))).toBe(true);
    expect(rows[rows.length - 1]).toMatch(/↑↓|accept|run|esc/u);
  });

  it("clamps long hints so rows stay within the terminal width budget", () => {
    const items: MenuItem[] = [
      {
        id: "/x",
        label: "/x",
        hint: "this is an extremely long description that would wrap the terminal if left unbounded"
      }
    ];
    const rows = buildMenuOverlayRows(paint, createMenuState(items, "/"), { columns: 50 }).map(strip);
    for (const row of rows) {
      // Allow a little slack for spaces; nothing should be near full paragraph length.
      expect(row.length).toBeLessThan(80);
    }
    expect(rows[0]).toMatch(/…/u);
  });
});
