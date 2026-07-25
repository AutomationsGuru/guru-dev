/**
 * Subagent Context Firewall (IDEA-F362-FIREWALL-01)
 *
 * A structural gate that ensures parent context only passes explicitly allowlisted
 * keys to a child agent. Secret-pattern keys are ALWAYS stripped — even when
 * accidentally allowlisted — so a prompt-level mistake can never leak a secret.
 *
 * This is the hard-limit enforcement (§3.3 no leaked secrets) in code, not prose.
 */

// ---------------------------------------------------------------------------
// Context type
// ---------------------------------------------------------------------------

/**
 * Loose context bag that a parent may attempt to forward to a child agent.
 * Keys are strings; values are any JSON-compatible shape. The firewall does
 * not inspect values for secrets — it prevents whole-key forwarding by name.
 */
export type SubagentContext = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Structurally enforced deny-set (prompt-rule drift prevention)
// ---------------------------------------------------------------------------

/**
 * Keys that are ALWAYS stripped, regardless of the allowlist. This is the
 * structural backstop: even if a caller (or a model-generated allowlist)
 * includes a secret-pattern key, the firewall rejects it in code — not prose.
 *
 * Frozen at module load so no runtime path can weaken it.
 */
export const ALWAYS_DENIED_KEYS: ReadonlySet<string> = Object.freeze(
  new Set([
    "apiKey",
    "api_key",
    "secret",
    "secrets",
    "password",
    "passwords",
    "token",
    "tokens",
    "credential",
    "credentials",
    "authorization",
    "accessKey",
    "access_key",
    "privateKey",
    "private_key"
  ])
);

// ---------------------------------------------------------------------------
// Firewall
// ---------------------------------------------------------------------------

/**
 * Filter a parent context bag to only the explicitly allowlisted keys.
 *
 * Deny logic resolves BEFORE allowlist matching: any key in
 * {@link ALWAYS_DENIED_KEYS} is stripped even if it appears in `allowKeys`.
 * This is the hard edge — YOLO can never lift it because it is enforced in
 * code, not in a prompt.
 *
 * @returns A shallow copy containing only allowlisted (and not hard-denied) keys.
 *          Does not mutate the original context.
 */
export function filterContext<T extends SubagentContext>(
  ctx: T,
  allowKeys: readonly string[]
): Partial<T> {
  const allowed = new Set(allowKeys);
  const result: Partial<T> = {};

  for (const key of Object.keys(ctx)) {
    // Structural deny gate — resolves FIRST, always.
    if (ALWAYS_DENIED_KEYS.has(key)) {
      continue;
    }
    if (allowed.has(key)) {
      result[key as keyof T] = ctx[key] as T[keyof T];
    }
  }

  return result;
}
