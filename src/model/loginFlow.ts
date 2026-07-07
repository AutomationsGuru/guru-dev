import { resolveRouteCredential } from "./directChat.js";
import type { ProviderRouteDescriptor } from "../providers/schemas.js";

/**
 * Login flow router (Phase B, 2026-07-04) — dispatches on credentialSource +
 * oauthPolicy to describe HOW to authenticate a lane, under the no-at-rest rule:
 * tokens land in an env var, the encrypted guru vault, or the provider ecosystem's own
 * cache — never a guru-owned plaintext file. Presence-over-value: this NEVER reads or prints a value.
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
  /** The layer a present credential resolves from (env / vault / ecosystem-cache). */
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
        ...(primary ? [`Or set ${primary} in your environment or the encrypted guru vault (/login ${route.providerId} <key>) as an override.`] : [])
      ]
    };
  }

  // API-key lane: an env var OR the encrypted guru vault. Nothing at rest in a guru
  // file, and guru reads no external credential store.
  if (primary) {
    return {
      ...base,
      kind: "api-key",
      steps: [
        `Set ${primary} by NAME (the value never touches a guru file):`,
        `  • env var:  export ${primary}=<key>`,
        `  • vault:    /login ${route.providerId} <key>   (saved to the encrypted guru vault — or:  guru keys set ${primary})`,
        `Then reconnect with /model ${route.routeId}.`
      ]
    };
  }

  // Delegate / native-CLI lanes (codex, grok, zai …): authenticate through the
  // provider's OWN CLI login. guru detects the token by file presence and never
  // reads or copies it — no guru file, no external credential store.
  const cli = ECOSYSTEM_LOGIN[route.providerId];
  if (cli) {
    return {
      ...base,
      kind: "ecosystem-oauth",
      steps: [
        source.filePath
          ? `${route.providerId} authenticates through its own CLI login (token lands in ${source.filePath}, owned by the provider — never a guru file).`
          : `${route.providerId} authenticates through its own CLI login — the token stays in the provider's cache, never a guru file.`,
        `Run its login, then reconnect:  ! ${cli}`,
        `Then reconnect with /model ${route.routeId}.`
      ]
    };
  }

  return { ...base, kind: "unknown", steps: [`No known login flow for credential type '${source.type}'.`] };
}

/** Ecosystem login commands (interim attach; presence-detected, never auto-run). */
const ECOSYSTEM_LOGIN: Readonly<Record<string, string>> = {
  // openai-codex is a guru-native OAuth lane (guru's own /login loopback), NOT an
  // ecosystem CLI login. Grok will join it as guru-oauth in the xAI wave.
  "grok-cli": "grok auth"
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
