/**
 * Local shell isolation recommend policy helper.
 *
 * Recommends/warns/blocks local shell execution unless a sandbox profile
 * is active or an explicit operator override is provided.
 *
 * This keeps the harness lightweight and isolation-aware without
 * inheriting external agent-framework ceilings.
 */

export interface LocalShellIsolationRecommendation {
  readonly allowed: boolean;
  readonly reason: string;
  readonly warn: boolean;
}

/**
 * Decide if local shell may run under the given profile/override.
 */
export function mayRunLocalShell(
  profile?: string,
  override?: boolean
): LocalShellIsolationRecommendation {
  if (override === true) {
    return {
      allowed: true,
      reason: "Explicit override granted",
      warn: false,
    };
  }

  const isSandboxProfile = typeof profile === "string" && /sandbox/i.test(profile);
  if (isSandboxProfile) {
    return {
      allowed: true,
      reason: "Sandbox profile active",
      warn: false,
    };
  }

  return {
    allowed: false,
    reason:
      "Bare host without sandbox profile or override — local shell blocked for isolation",
    warn: true,
  };
}
