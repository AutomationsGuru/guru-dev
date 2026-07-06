import { resolveRouteCredential } from "./directChat.js";
import type { ProviderRouteDescriptor } from "../providers/schemas.js";

/**
 * Login flow router (Phase B, 2026-07-04) — dispatches on credentialSource +
 * oauthPolicy to describe HOW to authenticate a lane, under the no-at-rest rule:
 * tokens land in env / the op credential store / the provider ecosystem's own cache, never a
 * guru-owned secrets file. Presence-over-value: this NEVER reads or prints a value.
 *
 * v1 describes the flow (safe, non-blocking); guru-native device-code OAuth is
 * the deferred finished state (planning/THERE.md §5 + build plan Phase B).
 */

export type LoginKind = "already-connected" | "ecosystem-oauth" | "api-key" | "none-needed" | "unknown";

export interface LoginFlow {
  readonly routeId: string;
  readonly providerId: string;
  readonly kind: LoginKind;
  /** Presence only — never a value. */
  readonly present: boolean;
  /** The layer a present credential resolves from (env / op-probe / ecosystem-cache). */
  readonly source?: string;
  /** Expiry hint (ISO/epoch string) when the ecosystem cache carries one. */
  readonly expiresAt?: string;
  /** Ordered human steps to authenticate this lane. */
  readonly steps: readonly string[];
}

/** Env var NAME(s) a lane declares (never values). */
function envNames(route: ProviderRouteDescriptor): readonly string[] {
  const source = route.credentialSource;
  return [...(source.envVarName ? [source.envVarName] : []), ...source.envVarNames];
}

export function describeLoginFlow(route: ProviderRouteDescriptor, env: NodeJS.ProcessEnv = process.env): LoginFlow {
  const credential = resolveRouteCredential(route, env);
  const source = route.credentialSource;
  const names = envNames(route);
  const primary = names[0];
  const base = {
    routeId: route.routeId,
    providerId: route.providerId,
    present: credential.usable,
    ...(credential.source ? { source: credential.source } : {}),
    ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {})
  };

  if (source.type === "none") {
    return { ...base, kind: "none-needed", steps: ["This lane needs no credential."] };
  }

  if (credential.usable) {
    return {
      ...base,
      kind: "already-connected",
      steps: [`Connected via ${credential.source ?? "resolved credential"}. /accounts for presence + expiry; /logout ${route.providerId} to disconnect.`]
    };
  }

  // Ecosystem OAuth: the provider owns the token cache — log in through its own
  // flow (interim attach; guru-native device-code is the deferred finished state).
  if (source.filePath && source.oauthPolicy === "ecosystem-ok" && source.cacheTokenPath) {
    const cli = ECOSYSTEM_LOGIN[route.providerId];
    return {
      ...base,
      kind: "ecosystem-oauth",
      steps: [
        `${route.providerId} authenticates through its own login flow (token lands in ${source.filePath}, owned by the provider — never a guru file).`,
        cli ? `Run the provider's login, then reconnect:  ! ${cli}` : "Complete the provider's own CLI login, then reconnect.",
        ...(primary ? [`Or set ${primary} in your environment / op credential store as an override.`] : [])
      ]
    };
  }

  // API-key lane: env or the op credential store, nothing at rest.
  if (primary) {
    return {
      ...base,
      kind: "api-key",
      steps: [
        `Set the key by NAME (value never touches a guru file):`,
        `  • env:        export ${primary}=<key>   (or add it to the op credential store)`,
        `  • op store:   op item create --title ${primary} --vault \${GURU_OP_VAULT:-AGENTS-OS} credential=<key>`,
        `                guru auto-probes op://\${GURU_OP_VAULT:-AGENTS-OS}/${primary}/credential`,
        `  • wrapper:    op run --env-file=guru.env -- guru`,
        `Then reconnect with /model ${route.routeId}.`
      ]
    };
  }

  return { ...base, kind: "unknown", steps: [`No known login flow for credential type '${source.type}'.`] };
}

/** Ecosystem login commands (interim attach; presence-detected, never auto-run). */
const ECOSYSTEM_LOGIN: Readonly<Record<string, string>> = {
  "openai-codex-direct": "codex login",
  "openai-codex": "codex login",
  "grok-cli": "grok auth",
  "zai-coding-cn": "zai auth login"
};

/** Human expiry countdown from an ISO/epoch string (presence-safe). */
export function formatExpiry(expiresAt: string | undefined, now: number): string {
  if (!expiresAt) {
    return "no expiry";
  }
  const asNumber = Number(expiresAt);
  const ms = Number.isFinite(asNumber) ? (asNumber > 1e12 ? asNumber : asNumber * 1000) : Date.parse(expiresAt);
  if (!Number.isFinite(ms)) {
    return "expiry: unknown";
  }
  const deltaMin = Math.round((ms - now) / 60000);
  if (deltaMin < 0) {
    return `expired ${Math.abs(deltaMin)}m ago`;
  }
  if (deltaMin < 90) {
    return `expires in ${deltaMin}m`;
  }
  return `expires in ${Math.round(deltaMin / 60)}h`;
}
