import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { resolveOAuthTokenFor } from "./oauth/tokenRegistry.js";
import type { ProviderRouteDescriptor } from "../providers/schemas.js";

/**
 * Per-lane request wiring (Phase B, 2026-07-04): the auth header STYLE and any
 * resolved metadata headers a lane needs, driven by data on the route (`wire`).
 *
 * This centralizes what used to be scattered `providerId ===` conditionals across
 * agentTurn / directChat / capabilityProbe, and adds data-driven support for the
 * plan lanes proven upstream:
 *   - zai-coding-cn: anthropic-messages family but Bearer auth (authHeaderStyle).
 *   - grok: openai-responses + x-grok-client-version (from ~/.grok/version.json).
 *   - codex-direct: Responses + ChatGPT-Account-Id (from ~/.codex/auth.json) +
 *     OpenAI-Beta + originator headers.
 *
 * Header VALUES resolved here are non-secret metadata (versions, account ids).
 * The auth TOKEN itself never flows through here — it stays in the credential
 * resolver and is applied as the auth header by the caller.
 */

export type WireHeaderStyle = "bearer" | "api-key" | "x-api-key";

export interface ProviderWire {
  readonly headerStyle: WireHeaderStyle;
  readonly extraHeaders: Record<string, string>;
}

export interface ProviderWireOptions {
  /** File reader override (tests). Defaults to read-only fs. */
  readonly readFile?: (path: string) => string;
}

function expandHome(path: string): string {
  return path.startsWith("~/") || path === "~" ? `${homedir()}${path.slice(1)}` : path;
}

function extractJsonPath(parsed: unknown, jsonPath: string): string | undefined {
  let node: unknown = parsed;
  for (const segment of jsonPath.split(".")) {
    if (node === null || typeof node !== "object") {
      return undefined;
    }
    const record = node as Record<string, unknown>;
    node = segment === "*" ? Object.values(record)[0] : record[segment];
  }
  return typeof node === "string" && node.length > 0 ? node : typeof node === "number" ? String(node) : undefined;
}

/** Family-default auth header style, before any per-lane `wire.authHeaderStyle` override. */
export function defaultHeaderStyle(route: ProviderRouteDescriptor): WireHeaderStyle {
  if (route.providerId.startsWith("azure")) {
    return "api-key";
  }
  if (route.apiFamily === "anthropic-messages" || route.providerId === "aws-bedrock" || route.providerId === "aws-bedrock-anthropic") {
    return "x-api-key";
  }
  return "bearer";
}

export function resolveProviderWire(
  route: ProviderRouteDescriptor,
  env: NodeJS.ProcessEnv = process.env,
  options: ProviderWireOptions = {}
): ProviderWire {
  const headerStyle = route.wire?.authHeaderStyle ?? defaultHeaderStyle(route);
  const extraHeaders: Record<string, string> = {};

  // Legacy static header preserved as data would be, until the lane declares wire.
  if (route.providerId === "aws-bedrock-oai" && !route.wire) {
    extraHeaders["OpenAI-Project"] = "default";
  }

  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  for (const spec of route.wire?.headers ?? []) {
    let value: string | undefined = spec.literal;
    if (value === undefined && spec.envVar) {
      const fromEnv = env[spec.envVar];
      if (typeof fromEnv === "string" && fromEnv.length > 0) {
        value = fromEnv;
      }
    }
    if (value === undefined && spec.filePath && spec.jsonPath) {
      try {
        value = extractJsonPath(JSON.parse(readFile(expandHome(spec.filePath))) as unknown, spec.jsonPath);
      } catch {
        value = undefined;
      }
    }
    if (value === undefined && spec.oauthAccount) {
      value = resolveOAuthTokenFor(route.providerId)?.accountId; // guru's OWN vaulted token, never a cache
    }
    if (value === undefined) {
      value = spec.fallback;
    }
    if (value !== undefined) {
      extraHeaders[spec.header] = value;
    }
  }

  return { headerStyle, extraHeaders };
}
