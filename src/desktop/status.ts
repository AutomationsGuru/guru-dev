import { execFileSync } from "node:child_process";

import {
  DesktopStatusReportSchema,
  type DesktopStatusReport
} from "./schemas.js";
import { DEFAULT_SCREEN_BOUNDS, type ScreenBounds } from "./guardrails.js";

export interface DesktopStatusOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** True when an injectable live backend is wired. */
  readonly backendInjected?: boolean;
  readonly failsafeEnabled?: boolean;
  /** Override display detection (tests). */
  readonly displayAvailable?: boolean;
}

function envLiveEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.GURU_DESKTOP_LIVE ?? env.GURU_DESKTOP_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function detectDisplayAvailable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (platform === "linux") {
    return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  }
  if (platform === "darwin") {
    // GUI session assumed for interactive Mac agents; CI often headless.
    return env.CI !== "true" && env.GITHUB_ACTIONS !== "true";
  }
  if (platform === "win32") {
    // SessionName Console/RDP is present on interactive Windows; empty in some services.
    return env.SESSIONNAME !== undefined || env.USERNAME !== undefined;
  }
  return false;
}

/**
 * Best-effort screen size probe without PyAutoGUI.
 * Returns undefined when the probe is unavailable (CI / headless).
 */
export function probeScreenSize(
  platform: NodeJS.Platform = process.platform
): ScreenBounds | undefined {
  try {
    if (platform === "win32") {
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;",
        "Write-Output \"$($s.Width)x$($s.Height)\""
      ].join(" ");
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      const match = /^(\d+)x(\d+)$/u.exec(out);
      if (match) {
        return { width: Number(match[1]), height: Number(match[2]) };
      }
    }
  } catch {
    // Probe is optional.
  }
  return undefined;
}

export function getDesktopStatus(options: DesktopStatusOptions = {}): DesktopStatusReport {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const displayAvailable = options.displayAvailable ?? detectDisplayAvailable(platform, env);
  const backendInjected = options.backendInjected ?? false;
  const failsafeEnabled = options.failsafeEnabled ?? true;
  const liveFlag = envLiveEnabled(env);
  const liveActionsEnabled = liveFlag && backendInjected && displayAvailable;

  let status: DesktopStatusReport["status"];
  let summary: string;
  let backend: DesktopStatusReport["backend"];

  if (!displayAvailable) {
    status = "missing-display";
    backend = backendInjected ? "injected" : "none";
    summary = "No interactive display session detected; desktop tools remain dry-run only.";
  } else if (backendInjected) {
    status = liveActionsEnabled ? "ready" : "disabled";
    backend = "injected";
    summary = liveActionsEnabled
      ? "Desktop backend injected and live actions enabled (GURU_DESKTOP_LIVE)."
      : "Desktop backend injected; live actions still require GURU_DESKTOP_LIVE=1.";
  } else {
    // Native probe path: status/screen-size only — no live mouse/keyboard backend.
    status = "ready";
    backend = "native-probe";
    summary =
      "Desktop status/screen probes available; mouse/keyboard live runs need an injected backend + GURU_DESKTOP_LIVE=1.";
  }

  return DesktopStatusReportSchema.parse({
    status,
    platform,
    displayAvailable,
    backend,
    failsafeEnabled,
    liveActionsEnabled,
    summary
  });
}

export function resolveScreenBounds(options: {
  readonly platform?: NodeJS.Platform;
  readonly injectedBounds?: ScreenBounds;
}): ScreenBounds {
  if (options.injectedBounds) {
    return options.injectedBounds;
  }
  return probeScreenSize(options.platform ?? process.platform) ?? DEFAULT_SCREEN_BOUNDS;
}
