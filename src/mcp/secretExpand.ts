import { registerSecretValue } from "../safety/secretSafety.js";
import type { McpServerConfig } from "./schemas.js";

/**
 * Config secret expansion for MCP attach (IDEA-D3, R-CR-MCP-SECRET).
 *
 * Project config (`guruharness.config.json`) is untrusted input, so expansion
 * is deliberately narrow — **environment variables only**:
 *
 *   $VAR                → env VAR (error by NAME when unset/empty)
 *   ${VAR}              → same, braced form
 *   ${VAR:?message}     → env VAR, or error "VAR: message" (never a value)
 *
 * There is **no `$(...)` command substitution and no backtick evaluation** —
 * shell expansion in untrusted project config would be arbitrary command
 * execution at attach time (plan exclusion + §3.4). Those forms pass through
 * as inert literals.
 *
 * Secret constitution (§3.3), enforced structurally:
 * - error strings name the VARIABLE NAME and the config FIELD PATH only;
 *   env values are never read into any message, log, or status;
 * - every materialized value is registered with the value scrubber at this
 *   choke point, so any later printable path (errors, transcripts, statuses)
 *   redacts it even if a caller fumbles the expanded config.
 *
 * Expansion is a pure, single-pass view: injected values are never re-scanned
 * for further references, and the input config is never mutated.
 */

export type SecretExpansionResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

export type ConfigExpansionResult =
  | { readonly ok: true; readonly config: McpServerConfig; readonly expandedNames: readonly string[] }
  | SecretExpansionError;

export interface SecretExpansionError {
  readonly ok: false;
  readonly error: string;
}

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
// One combined pattern, one left-to-right pass over the ORIGINAL string:
//   alt 1: ${VAR} / ${VAR:?message}   (valid braced ref)
//   alt 2: ${...anything-else...}     (malformed ref — fail loudly, never
//                                      silently pass a typo through to a server)
//   alt 3: $VAR                       (bare ref)
// Name/message bodies are bounded so a pathological config string stays
// linear to scan. Resolved values are appended verbatim — never re-scanned —
// so a value containing "$..." cannot trigger recursive expansion.
const REF_PATTERN =
  /\$\{([A-Za-z_][A-Za-z0-9_]{0,127})(?::\?([^}]{0,256}))?\}|\$\{([^}]{0,256})\}|\$([A-Z][A-Z0-9_]{0,127})/gu;

/** Expand env references in one string. Values never appear in error text. */
export function expandSecretRefs(text: string, env: NodeJS.ProcessEnv = process.env): SecretExpansionResult {
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(REF_PATTERN)) {
    if (match[3] !== undefined) {
      return {
        ok: false,
        error: `\${${match[3]}} is not a valid environment variable name for secret expansion (use \${VAR} or \${VAR:?message} with an UPPER_SNAKE name)`
      };
    }
    const name = match[1] ?? match[4];
    if (name === undefined) {
      continue;
    }
    if (!ENV_NAME_PATTERN.test(name)) {
      return { ok: false, error: `${name} is not a valid environment variable name for secret expansion` };
    }
    const value = env[name];
    if (value === undefined || value.length === 0) {
      const requiredMessage = match[2];
      return {
        ok: false,
        error: requiredMessage !== undefined ? `${name}: ${requiredMessage}` : `${name} is not set (referenced by secret expansion)`
      };
    }
    output += text.slice(cursor, match.index) + value;
    cursor = match.index + match[0].length;
  }
  return { ok: true, text: output + text.slice(cursor) };
}

/**
 * Return a copy of `config` with env references expanded in `url` and `args`,
 * or a value-free error naming the field path and the env NAME. Every env
 * value materialized this way is registered with the secret scrubber — the
 * ONLY moment it crosses from env into harness state (structural §3.3 choke).
 */
export function expandMcpServerConfigSecrets(
  config: McpServerConfig,
  env: NodeJS.ProcessEnv = process.env
): ConfigExpansionResult {
  const expandedNames = new Set<string>();

  const expandField = (text: string, label: string): SecretExpansionResult => {
    const names = referencedEnvNames(text);
    const result = expandSecretRefs(text, env);
    if (!result.ok) {
      return { ok: false, error: `${label}: ${result.error}` };
    }
    if (result.text !== text) {
      for (const name of names) {
        expandedNames.add(name);
        // Register the bare env VALUE (never interpolated into any string
        // here) so every later printable path redacts it.
        registerSecretValue(env[name]);
      }
    }
    return result;
  };

  let url = config.url;
  if (url !== undefined) {
    const expanded = expandField(url, "url");
    if (!expanded.ok) {
      return expanded;
    }
    url = expanded.text;
  }

  const args: string[] = [];
  for (let index = 0; index < config.args.length; index += 1) {
    const arg = config.args[index];
    if (arg === undefined) {
      continue;
    }
    const expanded = expandField(arg, `args[${index}]`);
    if (!expanded.ok) {
      return expanded;
    }
    args.push(expanded.text);
  }

  return {
    ok: true,
    config: { ...config, ...(url !== undefined ? { url } : {}), args },
    expandedNames: [...expandedNames].sort()
  };
}

/** Names referenced by `$VAR` / `${VAR...}` forms in one config string. */
export function referencedEnvNames(text: string): readonly string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(REF_PATTERN)) {
    const name = match[1] ?? match[4];
    if (name !== undefined && ENV_NAME_PATTERN.test(name)) {
      names.add(name);
    }
  }
  return [...names].sort();
}
