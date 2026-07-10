/**
 * Desktop safety gates — bounds, failsafe corners, risky hotkeys, secret-shaped typing.
 */

export interface ScreenBounds {
  readonly width: number;
  readonly height: number;
}

/** Default virtual bounds when no display probe is available (dry-run planning). */
export const DEFAULT_SCREEN_BOUNDS: ScreenBounds = { width: 1920, height: 1080 };

/** Failsafe margin: moving into any corner of this size is treated as abort. */
export const FAILSAFE_CORNER_PX = 8;

/**
 * Hotkey chords that must never fire without hard-edge approval (and are blocked
 * entirely in the default adapter — they can close apps / power off / switch user).
 */
export const BLOCKED_HOTKEY_CHORDS: readonly (readonly string[])[] = [
  ["alt", "f4"],
  ["ctrl", "alt", "delete"],
  ["ctrl", "alt", "del"],
  ["meta", "l"],
  ["win", "l"],
  ["cmd", "q"],
  ["alt", "tab"], // focus stealing — blocked by default
  ["ctrl", "shift", "escape"]
];

const SECRET_TYPED_PATTERN =
  /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)\b/u;

export function normalizeKeyToken(key: string): string {
  return key.trim().toLowerCase().replace(/^key\.?/u, "");
}

export function isPointInFailsafeCorner(x: number, y: number, bounds: ScreenBounds): boolean {
  const m = FAILSAFE_CORNER_PX;
  const nearLeft = x <= m;
  const nearRight = x >= bounds.width - 1 - m;
  const nearTop = y <= m;
  const nearBottom = y >= bounds.height - 1 - m;
  return (nearLeft || nearRight) && (nearTop || nearBottom);
}

export function clampPointToBounds(
  x: number,
  y: number,
  bounds: ScreenBounds
): { x: number; y: number; clamped: boolean } {
  const nx = Math.max(0, Math.min(bounds.width - 1, x));
  const ny = Math.max(0, Math.min(bounds.height - 1, y));
  return { x: nx, y: ny, clamped: nx !== x || ny !== y };
}

export function isBlockedHotkey(keys: readonly string[]): boolean {
  const normalized = keys.map(normalizeKeyToken).sort();
  return BLOCKED_HOTKEY_CHORDS.some((chord) => {
    const c = [...chord].map(normalizeKeyToken).sort();
    return c.length === normalized.length && c.every((k, i) => k === normalized[i]);
  });
}

export function textLooksLikeSecret(text: string): boolean {
  if (SECRET_TYPED_PATTERN.test(text)) {
    return true;
  }
  // Long high-entropy single tokens look like keys.
  if (/^[A-Za-z0-9_+\/=-]{40,}$/u.test(text.trim())) {
    return true;
  }
  return false;
}

export function assertLiveAllowed(input: {
  dryRun: boolean;
  userApproved: boolean;
  liveActionsEnabled: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (input.dryRun) {
    return { ok: true };
  }
  if (!input.liveActionsEnabled) {
    return {
      ok: false,
      reason: "Live desktop actions are disabled (set GURU_DESKTOP_LIVE=1 and inject a backend, or keep dryRun=true)."
    };
  }
  if (!input.userApproved) {
    return { ok: false, reason: "Live desktop action requires userApproved=true (and dryRun=false)." };
  }
  return { ok: true };
}
