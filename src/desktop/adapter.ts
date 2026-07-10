import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  assertLiveAllowed,
  clampPointToBounds,
  isBlockedHotkey,
  isPointInFailsafeCorner,
  textLooksLikeSecret,
  type ScreenBounds
} from "./guardrails.js";
import {
  type DesktopKeyboardRequest,
  type DesktopKeyboardResult,
  type DesktopMouseRequest,
  type DesktopMouseResult,
  type DesktopScreenRequest,
  type DesktopScreenResult,
  type DesktopStatusReport
} from "./schemas.js";
import { getDesktopStatus, resolveScreenBounds } from "./status.js";

/**
 * Optional live backend — hosts inject OS-specific drivers (PyAutoGUI bridge, etc.).
 * Default tools never call OS input APIs without this + GURU_DESKTOP_LIVE + userApproved.
 */
export interface DesktopLiveBackend {
  readonly getScreenSize?: () => Promise<ScreenBounds> | ScreenBounds;
  readonly getMousePosition?: () => Promise<{ x: number; y: number }> | { x: number; y: number };
  readonly screenshot?: (sidecarPath: string) => Promise<void> | void;
  readonly locate?: (imagePath: string) => Promise<{ x: number; y: number } | null> | { x: number; y: number } | null;
  readonly moveTo?: (x: number, y: number) => Promise<void> | void;
  readonly click?: (x: number, y: number, button: string, clicks: number) => Promise<void> | void;
  readonly scroll?: (clicks: number) => Promise<void> | void;
  readonly typeText?: (text: string) => Promise<void> | void;
  readonly hotkey?: (keys: readonly string[]) => Promise<void> | void;
}

export interface DesktopAdapterOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly backend?: DesktopLiveBackend;
  readonly bounds?: ScreenBounds;
  readonly failsafeEnabled?: boolean;
  readonly displayAvailable?: boolean;
}

export interface DesktopAdapter {
  status(): DesktopStatusReport;
  screen(req: DesktopScreenRequest): Promise<DesktopScreenResult>;
  mouse(req: DesktopMouseRequest): Promise<DesktopMouseResult>;
  keyboard(req: DesktopKeyboardRequest): Promise<DesktopKeyboardResult>;
}

export function createDesktopAdapter(options: DesktopAdapterOptions = {}): DesktopAdapter {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const failsafeEnabled = options.failsafeEnabled ?? true;
  const backend = options.backend;

  const statusOpts = {
    env,
    platform,
    backendInjected: Boolean(backend),
    failsafeEnabled,
    ...(options.displayAvailable !== undefined ? { displayAvailable: options.displayAvailable } : {})
  };

  const bounds = (): ScreenBounds =>
    resolveScreenBounds({
      platform,
      ...(options.bounds ? { injectedBounds: options.bounds } : {})
    });

  return {
    status() {
      return getDesktopStatus(statusOpts);
    },

    async screen(req): Promise<DesktopScreenResult> {
      const b = bounds();
      if (req.action === "size") {
        if (backend?.getScreenSize && !req.dryRun) {
          const live = assertLiveAllowed({
            dryRun: req.dryRun,
            userApproved: req.userApproved,
            liveActionsEnabled: getDesktopStatus(statusOpts).liveActionsEnabled
          });
          if (!live.ok) {
            return { action: "size", status: "blocked", summary: live.reason };
          }
          const size = await backend.getScreenSize();
          return {
            action: "size",
            status: "succeeded",
            width: size.width,
            height: size.height,
            summary: `Screen size ${size.width}×${size.height}.`
          };
        }
        // size is a probe — always allowed (read-only), uses native/default bounds.
        return {
          action: "size",
          status: req.dryRun ? "dry-run" : "succeeded",
          width: b.width,
          height: b.height,
          summary: `Screen size ${b.width}×${b.height}${req.dryRun ? " (probe/dry-run)" : ""}.`
        };
      }

      if (req.action === "position") {
        if (backend?.getMousePosition && !req.dryRun) {
          const live = assertLiveAllowed({
            dryRun: false,
            userApproved: req.userApproved,
            liveActionsEnabled: getDesktopStatus(statusOpts).liveActionsEnabled
          });
          if (!live.ok) {
            return { action: "position", status: "blocked", summary: live.reason };
          }
          const pos = await backend.getMousePosition();
          return {
            action: "position",
            status: "succeeded",
            x: pos.x,
            y: pos.y,
            summary: `Pointer at (${pos.x}, ${pos.y}).`
          };
        }
        return {
          action: "position",
          status: "dry-run",
          x: Math.floor(b.width / 2),
          y: Math.floor(b.height / 2),
          summary: "Pointer position probe (dry-run center estimate; inject backend for live)."
        };
      }

      if (req.action === "screenshot") {
        const sidecar =
          req.sidecarPath ??
          join(tmpdir(), `guruharness-shot-${Date.now()}.png`);
        if (req.dryRun || !backend?.screenshot) {
          return {
            action: "screenshot",
            status: "dry-run",
            sidecarPath: sidecar,
            summary: `Would write screenshot to ${sidecar}${backend?.screenshot ? "" : " (no backend)"}.`
          };
        }
        const live = assertLiveAllowed({
          dryRun: false,
          userApproved: req.userApproved,
          liveActionsEnabled: getDesktopStatus(statusOpts).liveActionsEnabled
        });
        if (!live.ok) {
          return { action: "screenshot", status: "blocked", summary: live.reason };
        }
        await backend.screenshot(sidecar);
        return {
          action: "screenshot",
          status: "succeeded",
          sidecarPath: sidecar,
          summary: `Screenshot written to ${sidecar}.`
        };
      }

      // locate
      if (req.dryRun || !backend?.locate) {
        return {
          action: "locate",
          status: "dry-run",
          summary: `Would locate image ${req.imagePath ?? "(missing)"}${backend?.locate ? "" : " (no backend)"}.`
        };
      }
      const live = assertLiveAllowed({
        dryRun: false,
        userApproved: req.userApproved,
        liveActionsEnabled: getDesktopStatus(statusOpts).liveActionsEnabled
      });
      if (!live.ok) {
        return { action: "locate", status: "blocked", summary: live.reason };
      }
      const found = await backend.locate(req.imagePath!);
      if (!found) {
        return { action: "locate", status: "failed", summary: `Image not found: ${req.imagePath}.` };
      }
      return {
        action: "locate",
        status: "succeeded",
        x: found.x,
        y: found.y,
        summary: `Located at (${found.x}, ${found.y}).`
      };
    },

    async mouse(req): Promise<DesktopMouseResult> {
      const b = bounds();
      if (req.action === "position") {
        return {
          action: "position",
          status: "dry-run",
          x: Math.floor(b.width / 2),
          y: Math.floor(b.height / 2),
          summary: "Mouse position (dry-run center estimate)."
        };
      }

      const rawX = req.x ?? 0;
      const rawY = req.y ?? 0;
      const { x, y, clamped } = clampPointToBounds(rawX, rawY, b);
      if (failsafeEnabled && isPointInFailsafeCorner(x, y, b)) {
        return {
          action: req.action,
          status: "blocked",
          x,
          y,
          summary: `Blocked: point (${x}, ${y}) is in a failsafe corner.`
        };
      }

      if (req.dryRun || !backend) {
        return {
          action: req.action,
          status: "dry-run",
          x,
          y,
          summary: `Would ${req.action} at (${x}, ${y})${clamped ? " [clamped]" : ""}${backend ? "" : " (no backend)"}.`
        };
      }

      const live = assertLiveAllowed({
        dryRun: false,
        userApproved: req.userApproved,
        liveActionsEnabled: getDesktopStatus(statusOpts).liveActionsEnabled
      });
      if (!live.ok) {
        return { action: req.action, status: "blocked", x, y, summary: live.reason };
      }

      try {
        if (req.action === "move") {
          if (!backend.moveTo) throw new Error("Backend lacks moveTo.");
          await backend.moveTo(x, y);
        } else if (req.action === "click") {
          if (!backend.click) throw new Error("Backend lacks click.");
          await backend.click(x, y, req.button, req.clicks);
        } else if (req.action === "scroll") {
          if (!backend.scroll) throw new Error("Backend lacks scroll.");
          await backend.scroll(req.scrollClicks);
        }
        return {
          action: req.action,
          status: "succeeded",
          x,
          y,
          summary: `${req.action} at (${x}, ${y}) completed.`
        };
      } catch (error) {
        return {
          action: req.action,
          status: "failed",
          x,
          y,
          summary: error instanceof Error ? error.message : String(error)
        };
      }
    },

    async keyboard(req): Promise<DesktopKeyboardResult> {
      if (req.action === "type" && req.text && textLooksLikeSecret(req.text)) {
        return {
          action: "type",
          status: "blocked",
          summary: "Blocked: text looks like a secret/token — refuse to type credentials."
        };
      }
      if ((req.action === "hotkey" || req.action === "press") && req.keys && isBlockedHotkey(req.keys)) {
        return {
          action: req.action,
          status: "blocked",
          summary: `Blocked risky hotkey: ${req.keys.join("+")}.`
        };
      }

      if (req.dryRun || !backend) {
        const detail =
          req.action === "type"
            ? `type ${JSON.stringify((req.text ?? "").slice(0, 40))}`
            : `${req.action} ${req.keys?.join("+") ?? ""}`;
        return {
          action: req.action,
          status: "dry-run",
          summary: `Would ${detail}${backend ? "" : " (no backend)"}.`
        };
      }

      const live = assertLiveAllowed({
        dryRun: false,
        userApproved: req.userApproved,
        liveActionsEnabled: getDesktopStatus(statusOpts).liveActionsEnabled
      });
      if (!live.ok) {
        return { action: req.action, status: "blocked", summary: live.reason };
      }

      try {
        if (req.action === "type") {
          if (!backend.typeText) throw new Error("Backend lacks typeText.");
          await backend.typeText(req.text!);
        } else {
          if (!backend.hotkey) throw new Error("Backend lacks hotkey.");
          await backend.hotkey(req.keys!);
        }
        return { action: req.action, status: "succeeded", summary: `${req.action} completed.` };
      } catch (error) {
        return {
          action: req.action,
          status: "failed",
          summary: error instanceof Error ? error.message : String(error)
        };
      }
    }
  };
}
