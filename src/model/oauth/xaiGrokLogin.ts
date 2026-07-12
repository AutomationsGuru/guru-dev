import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  decodeJwtClaims,
  defaultOpenBrowser,
  expiryFromAccessToken,
  generatePkce,
  OAuthRefreshError,
  safeReadFile,
  type GuruOAuthToken,
  type Pkce
} from "./openaiCodexLogin.js";

/**
 * guru-native "Sign in with SuperGrok / xAI" login (2026-07).
 *
 * OAuth 2.0 Authorization-Code + PKCE (S256) against auth.x.ai — the same public-client
 * flow the open-source Grok CLI uses — but the operator signs in through GURU's own
 * loopback callback, so guru gets ITS OWN token and stores it in guru's encrypted vault.
 * guru NEVER depends on the grok CLI being installed. If the CLI already logged in, its
 * ~/.grok/auth.json cache is an OPPORTUNISTIC SHORTCUT (readGrokCacheToken), never a
 * requirement — the standalone rule: only guru need be present.
 *
 * client_id + the plan/referrer params are xAI-controlled first-party values guru must
 * SEND. Every field is env-overridable (GURU_XAI_OAUTH_*) so a rotation is config, not code.
 */

export interface XaiOAuthConfig {
  readonly clientId: string;
  readonly issuer: string; // https://auth.x.ai
  readonly authorizePath: string; // /oauth2/authorize
  readonly tokenPath: string; // /oauth2/token
  readonly deviceCodePath: string; // /oauth2/device/code (RFC 8628 — the flow the real Grok CLI uses)
  readonly redirectPort: number; // loopback callback port (dynamic; xAI accepts a loopback port)
  readonly scope: string;
  readonly referrer: string;
  readonly plan: string;
}

/** Defaults from the open-source Grok CLI OAuth flow (2026-07); every field env-overridable. */
export function resolveXaiOAuthConfig(env: NodeJS.ProcessEnv = process.env): XaiOAuthConfig {
  return {
    // `|| default` (not `??`): a BLANK env override falls back to the default too — an
    // empty GURU_XAI_OAUTH_CLIENT_ID must NOT produce `client_id=` (xAI: "Missing or
    // invalid client_id"). The client_id is the canonical public Grok CLI value.
    clientId: env.GURU_XAI_OAUTH_CLIENT_ID?.trim() || "b1a00492-073a-47ea-816f-4c329264a828",
    issuer: (env.GURU_XAI_OAUTH_ISSUER?.trim() || "https://auth.x.ai").replace(/\/+$/u, ""),
    authorizePath: env.GURU_XAI_OAUTH_AUTHORIZE_PATH?.trim() || "/oauth2/authorize",
    tokenPath: env.GURU_XAI_OAUTH_TOKEN_PATH?.trim() || "/oauth2/token",
    deviceCodePath: env.GURU_XAI_OAUTH_DEVICE_PATH?.trim() || "/oauth2/device/code",
    redirectPort: Number(env.GURU_XAI_OAUTH_PORT ?? "56121") || 56121,
    // Grok plan scopes: grok-cli:access + api:access are REQUIRED — without them sign-in
    // completes but the token is rejected at inference (verified via xAI's consent screen +
    // OIDC discovery scopes_supported). Confirmed against warp/opencode/litellm/hermes.
    scope: env.GURU_XAI_OAUTH_SCOPE?.trim() || "openid profile email offline_access grok-cli:access api:access",
    referrer: env.GURU_XAI_OAUTH_REFERRER?.trim() || "hermes-agent",
    plan: env.GURU_XAI_OAUTH_PLAN?.trim() || "generic"
  };
}

type FetchImpl = typeof globalThis.fetch;

/**
 * Fetch with a hard per-request timeout (review 2026-07-08): a blackholed token
 * endpoint (flaky Wi-Fi, captive portal, transient DNS) used to hang /login
 * forever because the device-code expiry was only checked BETWEEN polls. This
 * bounds every OAuth fetch so a stalled connection aborts instead of freezing.
 */
async function fetchWithTimeout(fetchImpl: FetchImpl, url: string, init: RequestInit & { readonly timeoutMs?: number }): Promise<Response> {
  const { timeoutMs = 15_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// expiryFromAccessToken, safeReadFile, defaultOpenBrowser are shared with the ChatGPT
// login and imported from openaiCodexLogin.ts (single source of truth).

function tokenFromResponse(json: Record<string, unknown>, previous: GuruOAuthToken | undefined, now: number): GuruOAuthToken {
  const accessToken = (json.access_token as string | undefined) ?? previous?.accessToken ?? "";
  const refreshToken = (json.refresh_token as string | undefined) ?? previous?.refreshToken ?? "";
  const idToken = (json.id_token as string | undefined) ?? previous?.idToken ?? "";
  const expiresInMs = typeof json.expires_in === "number" ? now + json.expires_in * 1000 : undefined;
  const expiresAt = expiryFromAccessToken(accessToken) ?? expiresInMs ?? previous?.expiresAt;
  return {
    accessToken,
    refreshToken,
    idToken,
    ...(expiresAt ? { expiresAt } : {}),
    authMode: "grok",
    obtainedAt: now
  };
}

export interface XaiAuthorizeUrlResult {
  readonly url: string;
  readonly redirectUri: string;
  readonly nonce: string;
}

export function buildXaiAuthorizeUrl(config: XaiOAuthConfig, pkce: Pkce, nonce: string): XaiAuthorizeUrlResult {
  const redirectUri = `http://127.0.0.1:${config.redirectPort}/callback`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scope,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: pkce.state,
    nonce,
    plan: config.plan,
    referrer: config.referrer
  });
  return { url: `${config.issuer}${config.authorizePath}?${params.toString()}`, redirectUri, nonce };
}

/** Exchange the authorization code (form-urlencoded). xAI wants both verifier AND challenge echoed. */
export async function exchangeXaiCode(
  config: XaiOAuthConfig,
  code: string,
  pkce: Pkce,
  redirectUri: string,
  fetchImpl: FetchImpl = globalThis.fetch,
  now = Date.now()
): Promise<GuruOAuthToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    code_verifier: pkce.verifier,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256"
  });
  const res = await fetchImpl(`${config.issuer}${config.tokenPath}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!res.ok) {
    throw new Error(`xAI token exchange failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return tokenFromResponse((await res.json()) as Record<string, unknown>, undefined, now);
}

/** Refresh (form-urlencoded, PUBLIC client — no secret). The refresh_token ROTATES; persist the returned record. */
export async function refreshXaiToken(
  config: XaiOAuthConfig,
  previous: GuruOAuthToken,
  fetchImpl: FetchImpl = globalThis.fetch,
  now = Date.now()
): Promise<GuruOAuthToken> {
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: config.clientId, refresh_token: previous.refreshToken });
  const res = await fetchWithTimeout(fetchImpl, `${config.issuer}${config.tokenPath}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!res.ok) {
    // Surface a PERMANENT failure (expired/revoked refresh token) as OAuthRefreshError so
    // the controller shows the "run /login grok" prompt — matching the ChatGPT refresh path.
    let code: string | undefined;
    try {
      code = ((await res.clone().json()) as Record<string, unknown>).error as string | undefined;
    } catch {
      /* body not JSON */
    }
    const permanent = res.status === 400 || res.status === 401 || code === "invalid_grant" || code === "expired_token";
    throw new OAuthRefreshError(`xAI token refresh failed (HTTP ${res.status})${code ? `: ${code}` : ""}`, code, permanent);
  }
  return tokenFromResponse((await res.json()) as Record<string, unknown>, previous, now);
}

// ── Device-code flow (RFC 8628) — the flow the real Grok CLI uses ────────────────────
// No loopback, no port binding (immune to Windows reserved-port ranges), works headless/
// over SSH. POST client_id+scope to /oauth2/device/code → show the user_code + URL → poll
// /oauth2/token until the user approves in the browser.

export interface DeviceCodeGrant {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  /** verification_uri with the code pre-filled, if the server provides it. */
  readonly verificationUriComplete?: string;
  readonly intervalMs: number;
  readonly expiresAt: number;
}

/** Kick off the device grant: returns the user code + URL to show the operator. */
export async function requestXaiDeviceCode(
  config: XaiOAuthConfig,
  fetchImpl: FetchImpl = globalThis.fetch,
  now = Date.now()
): Promise<DeviceCodeGrant> {
  const body = new URLSearchParams({ client_id: config.clientId, scope: config.scope });
  const res = await fetchWithTimeout(fetchImpl, `${config.issuer}${config.deviceCodePath}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!res.ok) {
    throw new Error(`xAI device-code request failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  const deviceCode = json.device_code as string | undefined;
  const userCode = json.user_code as string | undefined;
  const verificationUri = (json.verification_uri as string | undefined) ?? (json.verification_url as string | undefined);
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error("xAI device-code response missing device_code / user_code / verification_uri");
  }
  const intervalSec = typeof json.interval === "number" ? json.interval : 5;
  const expiresInSec = typeof json.expires_in === "number" ? json.expires_in : 900;
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof json.verification_uri_complete === "string" ? { verificationUriComplete: json.verification_uri_complete } : {}),
    intervalMs: Math.max(1, intervalSec) * 1000,
    expiresAt: now + expiresInSec * 1000
  };
}

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface XaiDeviceLoginDeps {
  readonly config?: XaiOAuthConfig;
  readonly fetchImpl?: FetchImpl;
  readonly openBrowser?: (url: string) => void;
  /** Show the operator the code + URL (the terminal prompt). */
  readonly onPrompt?: (grant: DeviceCodeGrant) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * Full device-code login: request a code, show it + open the browser, then poll the token
 * endpoint until the operator approves. Resolves to guru's own vaulted-shape token.
 */
export async function loginViaXaiDeviceCode(deps: XaiDeviceLoginDeps = {}): Promise<GuruOAuthToken> {
  const config = deps.config ?? resolveXaiOAuthConfig();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const grant = await requestXaiDeviceCode(config, fetchImpl, now());
  deps.onPrompt?.(grant);
  (deps.openBrowser ?? defaultOpenBrowser)(grant.verificationUriComplete ?? grant.verificationUri);

  let intervalMs = grant.intervalMs;
  for (;;) {
    if (now() >= grant.expiresAt) {
      throw new Error("device sign-in timed out — the code expired before approval");
    }
    await sleep(intervalMs);
    const body = new URLSearchParams({ grant_type: DEVICE_CODE_GRANT_TYPE, device_code: grant.deviceCode, client_id: config.clientId });
    // Per-poll timeout (review 2026-07-08): a stalled token endpoint used to hang
    // the poll forever — the device-code expiry was only checked BETWEEN fetches.
    let res: Response;
    try {
      res = await fetchWithTimeout(fetchImpl, `${config.issuer}${config.tokenPath}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString()
      });
    } catch (error) {
      // A transient network failure (incl. the per-poll timeout abort) isn't fatal —
      // re-check the device-code deadline and keep polling while the grant is valid.
      if (now() < grant.expiresAt) {
        continue;
      }
      throw new Error(`device sign-in poll failed (network): ${error instanceof Error ? error.message : String(error)}`);
    }
    if (res.ok) {
      return tokenFromResponse((await res.json()) as Record<string, unknown>, undefined, now());
    }
    let error: string | undefined;
    try {
      error = ((await res.clone().json()) as Record<string, unknown>).error as string | undefined;
    } catch {
      /* non-JSON body */
    }
    if (error === "authorization_pending") {
      continue; // operator hasn't approved yet — keep polling
    }
    if (error === "slow_down") {
      intervalMs += 5000; // RFC 8628: back off by 5s
      continue;
    }
    throw new Error(`device sign-in failed: ${error ?? `HTTP ${res.status}`}`);
  }
}

/**
 * SHORTCUT (never required): if the grok CLI already signed in, reuse its ~/.grok/auth.json
 * token so a machine that happens to have the CLI doesn't re-prompt. auth.json is keyed by
 * "https://auth.x.ai::{client_id}"; the token is the record's `access_token` (or `key`).
 */
export function readGrokCacheToken(home: string = homedir(), fileRead: (path: string) => string | null = safeReadFile): GuruOAuthToken | null {
  const path = join(home, ".grok", "auth.json");
  const text = fileRead(path);
  if (!text) {
    return null;
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const records = Object.values(raw).filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null);
    const record = records[0] ?? raw;
    const accessToken =
      (record.access_token as string | undefined) ??
      (record.key as string | undefined) ??
      (raw.access_token as string | undefined) ??
      (raw.key as string | undefined);
    if (!accessToken) {
      return null;
    }
    const refreshToken = (record.refresh_token as string | undefined) ?? (raw.refresh_token as string | undefined) ?? "";
    const idToken = (record.id_token as string | undefined) ?? "";
    const expiresAt = expiryFromAccessToken(accessToken);
    // Don't report a dead credential as signed in: expired with no refresh → fall through.
    if (expiresAt !== undefined && expiresAt <= Date.now() && !refreshToken) {
      return null;
    }
    return { accessToken, refreshToken, idToken, ...(expiresAt ? { expiresAt } : {}), authMode: "grok", obtainedAt: Date.now() };
  } catch {
    return null;
  }
}

const SUCCESS_HTML =
  "<!doctype html><meta charset=utf-8><title>guru</title><body style=\"font-family:system-ui;background:#12091F;color:#E9DEF8;display:grid;place-items:center;height:100vh;margin:0\"><div style=\"text-align:center\"><h2>✓ Signed in to guru (xAI)</h2><p>You can close this tab and return to the terminal.</p></div>";

export interface XaiLoopbackLoginDeps {
  readonly config?: XaiOAuthConfig;
  readonly fetchImpl?: FetchImpl;
  readonly openBrowser?: (url: string) => void;
  readonly createServerImpl?: typeof createServer;
  readonly onUrl?: (url: string) => void;
  readonly timeoutMs?: number;
  readonly rng?: (n: number) => Buffer;
  readonly now?: () => number;
}

/**
 * Run the full interactive loopback login: bind 127.0.0.1:port, open the browser, catch
 * the callback, validate `state`, exchange the code. Resolves to guru's own xAI token.
 */
export function loginViaXaiLoopback(deps: XaiLoopbackLoginDeps = {}): Promise<GuruOAuthToken> {
  const config = deps.config ?? resolveXaiOAuthConfig();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const createServerImpl = deps.createServerImpl ?? createServer;
  const now = deps.now ?? Date.now;
  const rng = deps.rng ?? randomBytes;
  const pkce = generatePkce(rng);
  const nonce = rng(24).toString("hex");

  return new Promise<GuruOAuthToken>((resolve, reject) => {
    let server: Server | undefined;
    let settled = false;
    let redirectUri = ""; // set once the server is actually bound (the real port)
    const timer = setTimeout(
      () => finish(new Error(`login timed out after ${Math.round((deps.timeoutMs ?? 120000) / 1000)}s — no callback received`)),
      deps.timeoutMs ?? 120000
    );

    const finish = (error: Error | null, token?: GuruOAuthToken): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      server?.close();
      if (error) {
        reject(error);
      } else if (token) {
        resolve(token);
      }
    };

    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      // Only the pathname + query matter; the base host/port is irrelevant for parsing.
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const error = requestUrl.searchParams.get("error");
      const code = requestUrl.searchParams.get("code");
      const state = requestUrl.searchParams.get("state");
      if (error) {
        res.writeHead(400, { "content-type": "text/html" }).end(`<p>Sign-in failed: ${error}. Return to the terminal.</p>`);
        finish(new Error(`sign-in returned error: ${error}`));
        return;
      }
      if (!code || state !== pkce.state) {
        res.writeHead(400, { "content-type": "text/html" }).end("<p>Invalid callback (state mismatch). Return to the terminal.</p>");
        finish(new Error("callback failed state validation"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(SUCCESS_HTML);
      exchangeXaiCode(config, code, pkce, redirectUri, fetchImpl, now()).then(
        (token) => finish(null, token),
        (exchangeError: unknown) => finish(exchangeError instanceof Error ? exchangeError : new Error(String(exchangeError)))
      );
    };

    // xAI allows ANY loopback port (RFC 8252). Try the preferred port, but if it's
    // unavailable — held by another process (EADDRINUSE) or inside a Windows reserved
    // range like winnat/Hyper-V (EACCES) — fall back to an OS-assigned free port, which
    // the OS never draws from a reserved range. The redirect_uri is built from the REAL
    // bound port, so the callback always matches.
    const bind = (port: number, isRetry: boolean): void => {
      server = createServerImpl(handler);
      server.on("error", (serverError: NodeJS.ErrnoException) => {
        if (!isRetry && (serverError.code === "EACCES" || serverError.code === "EADDRINUSE")) {
          try {
            server?.close();
          } catch {
            /* already closed */
          }
          bind(0, true); // OS picks a guaranteed-bindable ephemeral port
          return;
        }
        finish(new Error(`could not bind 127.0.0.1:${port || "(auto)"} — ${serverError.message}. A device-code fallback is planned.`));
      });
      server.listen(port, "127.0.0.1", () => {
        const address = server?.address();
        const actualPort = typeof address === "object" && address ? address.port : port;
        const built = buildXaiAuthorizeUrl({ ...config, redirectPort: actualPort }, pkce, nonce);
        redirectUri = built.redirectUri;
        deps.onUrl?.(built.url);
        (deps.openBrowser ?? defaultOpenBrowser)(built.url);
      });
    };

    bind(config.redirectPort, false);
  });
}
