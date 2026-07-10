import { describe, expect, it } from "vitest";

import {
  clampPointToBounds,
  isBlockedHotkey,
  isPointInFailsafeCorner,
  textLooksLikeSecret
} from "../../src/desktop/guardrails.js";

describe("desktop guardrails", () => {
  const bounds = { width: 100, height: 100 };

  it("detects failsafe corners", () => {
    expect(isPointInFailsafeCorner(0, 0, bounds)).toBe(true);
    expect(isPointInFailsafeCorner(99, 99, bounds)).toBe(true);
    expect(isPointInFailsafeCorner(50, 50, bounds)).toBe(false);
  });

  it("clamps out-of-bounds points", () => {
    expect(clampPointToBounds(-10, 200, bounds)).toEqual({ x: 0, y: 99, clamped: true });
    expect(clampPointToBounds(10, 20, bounds)).toEqual({ x: 10, y: 20, clamped: false });
  });

  it("blocks risky hotkeys regardless of order/case", () => {
    expect(isBlockedHotkey(["Alt", "F4"])).toBe(true);
    expect(isBlockedHotkey(["f4", "alt"])).toBe(true);
    expect(isBlockedHotkey(["ctrl", "c"])).toBe(false);
  });

  it("flags secret-shaped typing", () => {
    expect(textLooksLikeSecret("sk-abcdefghijklmnopqrstuvwxyz1234")).toBe(true);
    expect(textLooksLikeSecret("hello world")).toBe(false);
  });
});
