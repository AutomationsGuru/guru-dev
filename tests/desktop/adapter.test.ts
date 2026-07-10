import { describe, expect, it } from "vitest";

import { createDesktopAdapter } from "../../src/desktop/adapter.js";
import { createDesktopTools } from "../../src/tools/builtins/desktopTools.js";

describe("desktop adapter", () => {
  const bounds = { width: 800, height: 600 };

  it("reports status without a backend", () => {
    const adapter = createDesktopAdapter({
      platform: "win32",
      displayAvailable: true,
      bounds,
      env: {}
    });
    const status = adapter.status();
    expect(status.displayAvailable).toBe(true);
    expect(status.liveActionsEnabled).toBe(false);
    expect(status.backend).toBe("native-probe");
  });

  it("screen size returns bounds in dry-run", async () => {
    const adapter = createDesktopAdapter({ displayAvailable: true, bounds, env: {} });
    const out = await adapter.screen({
      action: "size",
      dryRun: true,
      userApproved: false
    });
    expect(out.width).toBe(800);
    expect(out.height).toBe(600);
  });

  it("blocks mouse moves into failsafe corners", async () => {
    const adapter = createDesktopAdapter({ displayAvailable: true, bounds, env: {} });
    const out = await adapter.mouse({
      action: "move",
      x: 0,
      y: 0,
      button: "left",
      clicks: 1,
      scrollClicks: 0,
      dryRun: true,
      userApproved: false
    });
    expect(out.status).toBe("blocked");
    expect(out.summary).toMatch(/failsafe/i);
  });

  it("dry-runs a safe mouse click", async () => {
    const adapter = createDesktopAdapter({ displayAvailable: true, bounds, env: {} });
    const out = await adapter.mouse({
      action: "click",
      x: 100,
      y: 100,
      button: "left",
      clicks: 1,
      scrollClicks: 0,
      dryRun: true,
      userApproved: false
    });
    expect(out.status).toBe("dry-run");
    expect(out.x).toBe(100);
  });

  it("blocks secret typing and risky hotkeys", async () => {
    const adapter = createDesktopAdapter({ displayAvailable: true, bounds, env: {} });
    const secret = await adapter.keyboard({
      action: "type",
      text: "sk-abcdefghijklmnopqrstuvwxyz1234",
      dryRun: true,
      userApproved: true
    });
    expect(secret.status).toBe("blocked");
    const hotkey = await adapter.keyboard({
      action: "hotkey",
      keys: ["alt", "f4"],
      dryRun: true,
      userApproved: true
    });
    expect(hotkey.status).toBe("blocked");
  });

  it("live mouse requires backend + flag + approval", async () => {
    let moved = false;
    const adapter = createDesktopAdapter({
      displayAvailable: true,
      bounds,
      env: { GURU_DESKTOP_LIVE: "1" },
      backend: {
        moveTo: async () => {
          moved = true;
        }
      }
    });
    const blocked = await adapter.mouse({
      action: "move",
      x: 40,
      y: 40,
      button: "left",
      clicks: 1,
      scrollClicks: 0,
      dryRun: false,
      userApproved: false
    });
    expect(blocked.status).toBe("blocked");
    expect(moved).toBe(false);

    const ok = await adapter.mouse({
      action: "move",
      x: 40,
      y: 40,
      button: "left",
      clicks: 1,
      scrollClicks: 0,
      dryRun: false,
      userApproved: true
    });
    expect(ok.status).toBe("succeeded");
    expect(moved).toBe(true);
  });
});

describe("createDesktopTools", () => {
  it("registers the four pyautogui_* tools", () => {
    const ids = createDesktopTools().map((t) => t.id);
    expect(ids).toEqual([
      "pyautogui_status",
      "pyautogui_screen",
      "pyautogui_mouse",
      "pyautogui_keyboard"
    ]);
  });
});
