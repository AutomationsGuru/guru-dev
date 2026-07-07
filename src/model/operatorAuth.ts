import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ProviderRouteDescriptor } from "../providers/schemas.js";

/**
 * Operator plan-auth presence resolver.
 *
 * For `operator-provider-plan-auth` / `native-cli` routes, detects whether the
 * operator's local credential cache EXISTS — presence by path only. Token values are
 * NEVER read, stored, or printed. When present and the provider has a delegate CLI,
 * turns run by delegating to that CLI (which holds its own auth); this honors the
 * binding policy that operator plan/native auth never routes through LiteLLM.
 */

export interface OperatorAuthSpec {
  readonly providerId: string;
  /** Credential cache paths relative to the user's home dir — checked for PRESENCE only. */
  readonly cacheRelPaths: readonly string[];
  /** Exact command the operator runs to (re)login. */
  readonly loginCommand: string;
}

export const OPERATOR_AUTH_SPECS: readonly OperatorAuthSpec[] = [
  // The openai-codex CLI-DELEGATE spec was removed 2026-07: the ChatGPT plan runs
  // natively through openai-codex (guru's own loopback OAuth → vaulted token),
  // so the harness no longer delegates any turn to a provider CLI.
  {
    providerId: "minimax-oauth",
    cacheRelPaths: [".mavis/auth.json", ".minimax/auth.json"],
    loginCommand: "mavis login"
  },
  {
    // The DIRECT ChatGPT-plan lane shares the codex CLI login (same ~/.codex/auth.json
    // as openai-codex). Without this entry, presence-only surfaces reported it
    // logged-out while it was connecting fine. No delegate — it runs direct.
    providerId: "openai-codex",
    cacheRelPaths: [".codex/auth.json"],
    loginCommand: "codex login"
  },
  {
    providerId: "grok",
    cacheRelPaths: [".grok/auth.json"],
    loginCommand: "grok auth"
  },
  {
    providerId: "google-cloud-gemini",
    cacheRelPaths: [".config/gcloud/application_default_credentials.json"],
    loginCommand: "gcloud auth application-default login"
  }
];

export interface OperatorAuthPresence {
  readonly providerId: string;
  readonly supported: boolean;
  readonly present: boolean;
  /** Paths that were checked (relative, safe to print). */
  readonly checkedPaths: readonly string[];
  /** The path that was found present (relative), if any. */
  readonly presentPath?: string;
  readonly loginCommand?: string;
  readonly summary: string;
}

export interface OperatorAuthOptions {
  readonly home?: string;
  readonly filesExist?: (absolutePath: string) => boolean;
}

export function isOperatorAuthRoute(route: ProviderRouteDescriptor): boolean {
  return (
    route.routeType === "operator-provider-plan-auth" ||
    route.routeType === "native-cli" ||
    route.credentialSource.type === "native-cli-token" ||
    route.credentialSource.type === "oauth-cache" ||
    route.credentialSource.type === "adc"
  );
}

export function resolveOperatorAuthPresence(route: ProviderRouteDescriptor, options: OperatorAuthOptions = {}): OperatorAuthPresence {
  const home = options.home ?? homedir();
  const filesExist = options.filesExist ?? existsSync;
  const spec = OPERATOR_AUTH_SPECS.find((candidate) => candidate.providerId === route.providerId);

  if (!spec) {
    return {
      providerId: route.providerId,
      supported: false,
      present: false,
      checkedPaths: [],
      summary: `No operator-auth mapping for ${route.providerId} yet; complete the provider's own login flow.`
    };
  }

  const presentRel = spec.cacheRelPaths.find((rel) => filesExist(join(home, rel)));

  return {
    providerId: route.providerId,
    supported: true,
    present: presentRel !== undefined,
    checkedPaths: spec.cacheRelPaths,
    ...(presentRel !== undefined ? { presentPath: presentRel } : {}),
    loginCommand: spec.loginCommand,
    summary:
      presentRel !== undefined
        ? `Operator credential cache present (~/${presentRel}); value never read.`
        : `Operator credential cache not found (checked: ${spec.cacheRelPaths.map((rel) => `~/${rel}`).join(", ")}). Run: ${spec.loginCommand}`
  };
}

export function getOperatorAuthSpec(providerId: string): OperatorAuthSpec | undefined {
  return OPERATOR_AUTH_SPECS.find((candidate) => candidate.providerId === providerId);
}
