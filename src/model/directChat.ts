import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { sanitizeErrorMessage } from "../router/health.js";
import { registerSecretValue, scrubSecretValues } from "../safety/secretSafety.js";
import { resolveProviderWire } from "./providerWire.js";
import type { ProviderRouteDescriptor } from "../providers/schemas.js";

/**
 * Minimal direct-first chat client for interactive harness turns.
 *
 * Speaks three API families against a route's OWN baseUrl (direct-first — never the
 * LiteLLM router): openai-chat-completions, openai-responses, anthropic-messages,
 * plus ollama-openai-compatible (chat-completions shape, no credential).
 *
 * Credentials are resolved AT CALL TIME through the layered resolver (2026-07-04,
 * Foundation Wave): env auto-discovery → config template ($VAR / $(cmd) / op://)
 * → op credential-store auto-probe → read-only provider-ecosystem cache. Values live in
 * process memory for the session only — never written to disk, logged, or
 * included in errors (every resolved value is registered with the secret
 * scrubber; errors pass through sanitizeErrorMessage + scrubSecretValues).
 */

export interface ChatTurnMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface DirectChatResult {
  readonly text: string;
  readonly modelId: string;
  readonly routeId: string;
  readonly apiFamily: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    /**
     * Input tokens of the LAST provider request in the turn (agentic turns make
     * up to maxToolCalls requests; inputTokens is the cumulative SUM). This is
     * the true context-size signal — compaction triggers on it.
     */
    readonly lastRequestInputTokens?: number;
  };
}

export interface DirectChatOptions {
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxTokens?: number;
  /** Override the model id sent to the API (e.g. a real local ollama model name). */
  readonly modelIdOverride?: string;
  readonly timeoutMs?: number;
}

export class DirectChatError extends Error {
  constructor(
    message: string,
    readonly details: { readonly routeId: string; readonly status?: number }
  ) {
    super(scrubSecretValues(message));
    this.name = "DirectChatError";
  }
}

// ---------------------------------------------------------------------------
// Layered credential resolver (Foundation Wave PR 1, 2026-07-04)
//
// Resolution order, first hit wins — crush/catwalk-informed, nothing at rest:
//   1. env auto-discovery   — canonical env NAMES declared on the route
//   2. config template      — "$VAR" / "${VAR}" / "$(command)" / "op://V/I/f"
//   3. op auto-probe        — op read op://<GURU_OP_VAULT|AGENTS-OS>/<ENV_NAME>/credential
//   4. ecosystem cache      — READ-ONLY parse of the provider's own token cache,
//                             gated by oauthPolicy ("forbidden" blocks, e.g. anthropic)
// Every resolved value is registered with the secret scrubber and returned
// in-memory only. The resolver never writes anything, anywhere.
// ---------------------------------------------------------------------------

export interface ResolvedRouteCredential {
  readonly usable: boolean;
  readonly envName?: string;
  readonly reason: string;
  /** Resolution layer that produced the value (absent when unusable/none). */
  readonly source?: "none" | "env" | "vault" | "template" | "op-probe" | "ecosystem-cache";
  /**
   * The resolved credential value — in-memory only, registered with the scrubber,
   * and attached as a NON-ENUMERABLE property: `JSON.stringify(credential)` and
   * object spreads never carry it. Read it explicitly via `credential.value`.
   */
  readonly value?: string;
  /** Expiry hint when the ecosystem cache carries one (ISO string or epoch). */
  readonly expiresAt?: string;
}

/** Attaches the credential value non-enumerably (serialization-safe by construction). */
function withCredentialValue(result: ResolvedRouteCredential, value: string): ResolvedRouteCredential {
  registerSecretValue(value);
  Object.defineProperty(result, "value", { value, enumerable: false, writable: false, configurable: false });
  return result;
}

/**
 * The credential vault lookup (Credential Vault wave). Registered once at boot from
 * the encrypted vault so `resolveRouteCredential` can resolve an API key by its
 * env-var NAME without the value ever touching `process.env` (which would leak into
 * child processes / re-trigger the Claude-Max-vs-ANTHROPIC_API_KEY conflict and defeat
 * the whole point). Unregistered → the resolver behaves byte-identically to before.
 */
let credentialVaultLookup: ((name: string) => string | undefined) | null = null;

export function registerCredentialVault(lookup: (name: string) => string | undefined): void {
  credentialVaultLookup = lookup;
}

export function clearCredentialVault(): void {
  credentialVaultLookup = null;
}

export interface ResolveCredentialOptions {
  /** Command runner for $(cmd) templates and op reads — injectable for tests. */
  readonly execCommand?: (command: string, timeoutMs: number) => string;
  /** op CLI runner — injectable for tests; default shells `op read <ref>`. */
  readonly readOpReference?: (reference: string) => string;
  /** File reader for ecosystem caches — injectable for tests. */
  readonly readFile?: (path: string) => string;
  /** Skip the op auto-probe layer entirely (used by tests / fast paths). */
  readonly disableOpProbe?: boolean;
}

const OP_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_OP_VAULT = "AGENTS-OS";

/** Cached per-process answer to "is the op CLI available?" (never re-probed). */
let opBinaryAvailable: boolean | undefined;

function defaultExecCommand(command: string, timeoutMs: number): string {
  return execSync(command, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function defaultReadOpReference(reference: string): string {
  return execFileSync("op", ["read", reference, "--no-newline"], {
    encoding: "utf8",
    timeout: OP_TIMEOUT_MS,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function isOpAvailable(): boolean {
  if (opBinaryAvailable === undefined) {
    try {
      execFileSync("op", ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      opBinaryAvailable = true;
    } catch {
      opBinaryAvailable = false;
    }
  }
  return opBinaryAvailable;
}

/** Test-only: reset the cached op-availability probe. */
export function resetOpAvailabilityForTests(value?: boolean): void {
  opBinaryAvailable = value;
}

function expandHome(path: string): string {
  return path.startsWith("~/") || path === "~" ? `${homedir()}${path.slice(1)}` : path;
}

/**
 * Walks a dot-path through parsed JSON. A "*" segment matches the FIRST object
 * value (for caches keyed by dynamic ids, e.g. ~/.grok/auth.json). Returns the
 * string value plus an `expires_at` hint from the terminal object, if present.
 */
function extractCacheToken(parsed: unknown, tokenPath: string): { value?: string; expiresAt?: string } {
  let node: unknown = parsed;
  let parent: unknown;
  for (const segment of tokenPath.split(".")) {
    if (node === null || typeof node !== "object") {
      return {};
    }
    parent = node;
    const record = node as Record<string, unknown>;
    node = segment === "*" ? Object.values(record)[0] : record[segment];
  }
  if (typeof node !== "string" || node.length === 0) {
    return {};
  }
  const expires = parent !== null && typeof parent === "object" ? (parent as Record<string, unknown>)["expires_at"] : undefined;
  return {
    value: node,
    ...(typeof expires === "string" || typeof expires === "number" ? { expiresAt: String(expires) } : {})
  };
}

function resolveTemplate(
  template: string,
  env: NodeJS.ProcessEnv,
  options: ResolveCredentialOptions
): { value?: string; detail: string } {
  if (template.startsWith("op://")) {
    if (!(options.readOpReference || isOpAvailable())) {
      return { detail: "op:// template set but the op CLI is not available" };
    }
    try {
      const value = (options.readOpReference ?? defaultReadOpReference)(template);
      return value.length > 0 ? { value, detail: "op:// reference" } : { detail: "op:// reference resolved empty" };
    } catch {
      return { detail: "op:// reference failed to resolve" };
    }
  }

  const command = /^\$\((.+)\)$/su.exec(template);
  if (command?.[1]) {
    try {
      const value = (options.execCommand ?? defaultExecCommand)(command[1], COMMAND_TIMEOUT_MS);
      return value.length > 0 ? { value, detail: "$(command) template" } : { detail: "$(command) template produced no output" };
    } catch {
      return { detail: "$(command) template failed" };
    }
  }

  const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?\}$/u.exec(template);
  const bare = /^\$([A-Za-z_][A-Za-z0-9_]*)$/u.exec(template);
  const varName = braced?.[1] ?? bare?.[1];
  if (varName) {
    const value = env[varName];
    if (typeof value === "string" && value.length > 0) {
      return { value, detail: `$${varName} template` };
    }
    const fallback = braced?.[2];
    return fallback !== undefined && fallback.length > 0
      ? { value: fallback, detail: `$${varName} template default` }
      : { detail: `template env var ${varName} not set` };
  }

  return { detail: "unrecognized credential template shape" };
}

export function resolveRouteCredential(
  route: ProviderRouteDescriptor,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveCredentialOptions = {}
): ResolvedRouteCredential {
  const source = route.credentialSource;

  if (source.type === "none") {
    return { usable: true, source: "none", reason: "No credential required." };
  }

  const attempted: string[] = [];
  const envNames = [...(source.envVarName ? [source.envVarName] : []), ...source.envVarNames];
  const primaryEnvName = envNames[0];

  // Layer 1 — env auto-discovery (canonical names, crush/catwalk-style).
  for (const envName of envNames) {
    const value = env[envName];
    if (typeof value === "string" && value.length > 0) {
      return withCredentialValue({ usable: true, envName, source: "env", reason: `Credential present by name (${envName}).` }, value);
    }
  }
  if (envNames.length > 0) {
    attempted.push(`env (${envNames.join(", ")})`);
  }

  // Layer 1b — the guru credential VAULT, by the same env-var name. An explicit,
  // operator-owned alternative to env (for keys that can't live in the shell env).
  // Resolved WITHOUT touching process.env, so it never leaks into child processes.
  if (credentialVaultLookup) {
    for (const envName of envNames) {
      const value = credentialVaultLookup(envName);
      if (typeof value === "string" && value.length > 0) {
        return withCredentialValue({ usable: true, envName, source: "vault", reason: `Credential present in the guru vault (${envName}).` }, value);
      }
    }
    if (envNames.length > 0) {
      attempted.push("vault");
    }
  }

  // Layer 2 — config template ($VAR / ${VAR} / $(command) / op://).
  if (source.template) {
    const resolved = resolveTemplate(source.template, env, options);
    if (resolved.value) {
      return withCredentialValue(
        {
          usable: true,
          ...(primaryEnvName ? { envName: primaryEnvName } : {}),
          source: "template",
          reason: `Credential resolved via ${resolved.detail}.`
        },
        resolved.value
      );
    }
    attempted.push(`template (${resolved.detail})`);
  }

  // Layer 3 — op credential-store auto-probe by convention: op://<vault>/<ENV_NAME>/credential.
  // OFF BY DEFAULT (operator directive 2026-07-06): guru never touches `op` unless the
  // operator explicitly opts in via GURU_OP_PROBE=1. env-var + the guru vault are the
  // credential sources. Tests inject readOpReference (which stays honored). Only engages
  // against the REAL process environment (a fixture env asks for a hermetic resolution).
  const opProbeOptIn = options.readOpReference !== undefined || env["GURU_OP_PROBE"] === "1";
  const opProbeEligible =
    opProbeOptIn && !options.disableOpProbe && primaryEnvName && (options.readOpReference || (env === process.env && isOpAvailable()));
  if (opProbeEligible) {
    const vault = env["GURU_OP_VAULT"] ?? DEFAULT_OP_VAULT;
    const reference = `op://${vault}/${primaryEnvName}/credential`;
    try {
      const value = (options.readOpReference ?? defaultReadOpReference)(reference);
      if (value.length > 0) {
        return withCredentialValue(
          { usable: true, envName: primaryEnvName, source: "op-probe", reason: `Credential resolved from the op credential store (${vault}/${primaryEnvName}).` },
          value
        );
      }
    } catch {
      // Item absent or op not signed in — silent fall-through by design.
    }
    attempted.push(`op-probe (${vault}/${primaryEnvName})`);
  }

  // Layer 4 — read-only provider-ecosystem cache, gated by oauthPolicy.
  if (source.filePath && source.cacheTokenPath) {
    if (source.oauthPolicy === "forbidden") {
      attempted.push("ecosystem-cache (blocked: oauthPolicy=forbidden)");
    } else {
      try {
        const raw = (options.readFile ?? ((path: string) => readFileSync(path, "utf8")))(expandHome(source.filePath));
        const extracted = extractCacheToken(JSON.parse(raw) as unknown, source.cacheTokenPath);
        if (extracted.value) {
          return withCredentialValue(
            {
              usable: true,
              ...(primaryEnvName ? { envName: primaryEnvName } : {}),
              source: "ecosystem-cache",
              ...(extracted.expiresAt ? { expiresAt: extracted.expiresAt } : {}),
              reason: `Credential read from the provider's own cache (${source.filePath}).`
            },
            extracted.value
          );
        }
        attempted.push("ecosystem-cache (token not found in cache)");
      } catch {
        attempted.push("ecosystem-cache (cache missing or unreadable)");
      }
    }
  }

  if (attempted.length === 0) {
    return {
      usable: false,
      reason: `Credential type '${source.type}' requires a login/delegation flow not wired into direct chat yet.`
    };
  }

  // Single-env routes keep the classic message (shown in picker/status UX).
  const onlyEnvAttempted = attempted.length === 1 && envNames.length > 0 && attempted[0]?.startsWith("env");
  if (onlyEnvAttempted) {
    return {
      usable: false,
      ...(primaryEnvName ? { envName: primaryEnvName } : {}),
      reason: envNames.length === 1 ? `Missing env var: ${envNames[0]}.` : `Missing env vars: ${envNames.join(", ")}.`
    };
  }

  return {
    usable: false,
    ...(primaryEnvName ? { envName: primaryEnvName } : {}),
    reason: `No credential found. Tried: ${attempted.join(" → ")}.`
  };
}

/** True when directChat can speak this route's API family. */
export function isChatCapableFamily(apiFamily: string | undefined): boolean {
  return (
    apiFamily === "openai-chat-completions" ||
    apiFamily === "openai-responses" ||
    apiFamily === "anthropic-messages" ||
    apiFamily === "ollama-openai-compatible"
  );
}

export async function directChat(
  route: ProviderRouteDescriptor,
  messages: readonly ChatTurnMessage[],
  options: DirectChatOptions = {}
): Promise<DirectChatResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const env = options.env ?? process.env;
  const apiFamily = route.apiFamily ?? "openai-chat-completions";
  const modelId = options.modelIdOverride ?? route.modelId;
  const maxTokens = options.maxTokens ?? 1024;

  if (!fetchImpl) {
    throw new DirectChatError("fetch is not available in this runtime.", { routeId: route.routeId });
  }
  if (!isChatCapableFamily(apiFamily)) {
    throw new DirectChatError(`API family '${apiFamily}' is not chat-capable in this slice.`, { routeId: route.routeId });
  }
  if (!route.baseUrl || route.baseUrl.startsWith("os.environ/")) {
    const baseEnvName = route.baseUrl?.replace("os.environ/", "");
    const resolvedBase = baseEnvName ? env[baseEnvName] : undefined;
    if (!resolvedBase) {
      throw new DirectChatError(`Route has no usable baseUrl${baseEnvName ? ` (env ${baseEnvName} not set)` : ""}.`, {
        routeId: route.routeId
      });
    }
  }

  const credential = resolveRouteCredential(route, env);
  if (!credential.usable) {
    throw new DirectChatError(credential.reason, { routeId: route.routeId });
  }

  const baseUrl = (route.baseUrl?.startsWith("os.environ/") ? env[route.baseUrl.replace("os.environ/", "")] : route.baseUrl) ?? "";
  const normalizedBase = baseUrl.replace(/\/+$/u, "");
  const secretValue = credential.value ?? (credential.envName ? env[credential.envName] : undefined);
  const wire = resolveProviderWire(route, env);
  const authHeaders = (): Record<string, string> => {
    if (!secretValue) {
      return { ...wire.extraHeaders };
    }
    const auth =
      wire.headerStyle === "api-key"
        ? { "api-key": secretValue }
        : wire.headerStyle === "x-api-key"
          ? { "x-api-key": secretValue }
          : { authorization: `Bearer ${secretValue}` };
    return { ...auth, ...wire.extraHeaders };
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120000);

  try {
    if (apiFamily === "anthropic-messages") {
      const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
      const body = {
        model: modelId,
        max_tokens: maxTokens,
        ...(system.length > 0 ? { system } : {}),
        messages: messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role, content: message.content }))
      };
      const response = await postJson(fetchImpl, `${normalizedBase}/v1/messages`, body, {
        ...authHeaders(),
        "anthropic-version": "2023-06-01"
      }, controller.signal, route.routeId);
      const parsed = response as { content?: Array<{ type?: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
      const text = (parsed.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
      return {
        text,
        modelId,
        routeId: route.routeId,
        apiFamily,
        ...buildUsage(parsed.usage?.input_tokens, parsed.usage?.output_tokens)
      };
    }

    if (apiFamily === "openai-responses") {
      const body = {
        model: modelId,
        input: messages.map((message) => ({ role: message.role, content: message.content })),
        max_output_tokens: maxTokens
      };
      const response = await postJson(fetchImpl, `${normalizedBase}/responses`, body, authHeaders(), controller.signal, route.routeId);
      const parsed = response as {
        output_text?: string;
        output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text =
        parsed.output_text ??
        (parsed.output ?? [])
          .flatMap((item) => item.content ?? [])
          .filter((block) => block.type === "output_text" || block.type === "text")
          .map((block) => block.text ?? "")
          .join("");
      return {
        text,
        modelId,
        routeId: route.routeId,
        apiFamily,
        ...buildUsage(parsed.usage?.input_tokens, parsed.usage?.output_tokens)
      };
    }

    // openai-chat-completions + ollama-openai-compatible
    const body = {
      model: modelId,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      max_tokens: maxTokens
    };
    const response = await postJson(fetchImpl, `${normalizedBase}/chat/completions`, body, authHeaders(), controller.signal, route.routeId);
    const parsed = response as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = parsed.choices?.[0]?.message?.content ?? "";
    return {
      text,
      modelId,
      routeId: route.routeId,
      apiFamily,
      ...buildUsage(parsed.usage?.prompt_tokens, parsed.usage?.completion_tokens)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildUsage(inputTokens: number | undefined, outputTokens: number | undefined): { usage?: { inputTokens?: number; outputTokens?: number } } {
  if (inputTokens === undefined && outputTokens === undefined) {
    return {};
  }
  return {
    usage: {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {})
    }
  };
}

function authHeader(secretValue: string | undefined): Record<string, string> {
  return secretValue ? { authorization: `Bearer ${secretValue}` } : {};
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
  routeId: string
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal
    });
  } catch (error) {
    throw new DirectChatError(`Chat request failed: ${sanitizeErrorMessage(error)}`, { routeId });
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    throw new DirectChatError(`Chat request failed with HTTP ${response.status}: ${sanitizeErrorMessage(extractErrorMessage(parsed))}`, {
      routeId,
      status: response.status
    });
  }

  return parsed;
}

function extractErrorMessage(body: unknown): string {
  if (typeof body === "string") {
    return body.slice(0, 300);
  }
  if (typeof body === "object" && body !== null) {
    const candidate = body as { error?: { message?: string } | string; message?: string };
    if (typeof candidate.error === "string") {
      return candidate.error;
    }
    if (typeof candidate.error === "object" && candidate.error !== null && typeof candidate.error.message === "string") {
      return candidate.error.message;
    }
    if (typeof candidate.message === "string") {
      return candidate.message;
    }
  }
  return "unknown error";
}
