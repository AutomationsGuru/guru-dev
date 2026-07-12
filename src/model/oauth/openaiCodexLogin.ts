import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * guru-native "Sign in with ChatGPT / Codex plan" login (2026-07-06).
 *
 * OAuth 2.0 Authorization-Code + PKCE (S256) against auth.openai.com, exactly as
 * the open-source Codex CLI does it — but the operator signs in through GURU's own
 * loopback callback, so guru gets ITS OWN token and stores it in guru's encrypted
 * vault. It never shells out to `codex login` and never reads ~/.codex/auth.json.
 *
 * The public client_id + `originator` are OpenAI-controlled first-party values the
 * backend requires; guru must SEND them (a distinct originator is 403'd). This is
 * the same reuse every OSS harness does — an operator-accepted ToS gray area, kept
 * fully configurable (env overrides) so an OpenAI rotation is config, not a rebuild.
 */

export interface OpenaiCodexOAuthConfig {
  readonly clientId: string;
  readonly issuer: string; // e.g. https://auth.openai.com
  readonly redirectPort: number; // loopback callback port (1455 must match OpenAI's registration)
  readonly scope: string;
  readonly originator: string;
}

/** Defaults verified against openai/codex `main` (2026-07-06); every field is env-overridable. */
export function resolveOAuthConfig(env: NodeJS.ProcessEnv = process.env): OpenaiCodexOAuthConfig {
  return {
    clientId: env.CODEX_APP_SERVER_LOGIN_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann",
    issuer: (env.GURU_OPENAI_OAUTH_ISSUER ?? "https://auth.openai.com").replace(/\/+$/u, ""),
    redirectPort: Number(env.GURU_OPENAI_OAUTH_PORT ?? "1455") || 1455,
    scope: env.GURU_OPENAI_OAUTH_SCOPE ?? "openid profile email offline_access",
    originator: env.GURU_OPENAI_OAUTH_ORIGINATOR ?? "codex_cli_rs"
  };
}

/** guru's own stored ChatGPT-plan credential (serialized as JSON into the encrypted vault). */
export interface GuruOAuthToken {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string;
  readonly accountId?: string;
  readonly planType?: string;
  readonly isFedramp?: boolean;
  /** Absolute expiry in epoch ms (decoded from the access_token `exp`). */
  readonly expiresAt?: number;
  readonly authMode: "chatgpt" | "grok";
  /** When this record was last written (epoch ms). */
  readonly obtainedAt: number;
}

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
  readonly state: string;
}

const b64url = (buf: Buffer): string => buf.toString("base64").replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");

/** PKCE S256 (codex parity): 64-byte verifier, SHA-256 challenge, 32-byte state. */
export function generatePkce(rng: (n: number) => Buffer = randomBytes): Pkce {
  const verifier = b64url(rng(64));
  const challenge = b64url(createHash("sha256").update(verifier, "ascii").digest());
  const state = b64url(rng(32));
  return { verifier, challenge, state };
}

/** Decode a JWT payload WITHOUT signature verification (only reading claims we already trust). */
export function decodeJwtClaims(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) {
    return {};
  }
  const json = Buffer.from(part.replace(/-/gu, "+").replace(/_/gu, "/"), "base64").toString("utf8");
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Pull the ChatGPT account id + plan facts out of the id_token (claim `https://api.openai.com/auth`). */
export function extractAccountFacts(idToken: string): Pick<GuruOAuthToken, "accountId" | "planType" | "isFedramp"> {
  const claims = decodeJwtClaims(idToken);
  const auth = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const orgs = Array.isArray(claims.organizations) ? (claims.organizations as Array<Record<string, unknown>>) : [];
  const accountId =
    (auth.chatgpt_account_id as string | undefined) ??
    (claims.chatgpt_account_id as string | undefined) ??
    (orgs[0]?.id as string | undefined);
  return {
    ...(accountId ? { accountId } : {}),
    ...(typeof auth.chatgpt_plan_type === "string" ? { planType: auth.chatgpt_plan_type } : {}),
    ...(auth.chatgpt_account_is_fedramp === true ? { isFedramp: true } : {})
  };
}

/** Epoch-ms expiry from the access_token `exp` claim (seconds), if present. */
export function expiryFromAccessToken(accessToken: string): number | undefined {
  const exp = decodeJwtClaims(accessToken).exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

export interface AuthorizeUrlResult {
  readonly url: string;
  readonly redirectUri: string;
}

export function buildAuthorizeUrl(config: OpenaiCodexOAuthConfig, pkce: Pkce): AuthorizeUrlResult {
  const redirectUri = `http://localhost:${config.redirectPort}/auth/callback`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scope,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: pkce.state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: config.originator
  });
  return { url: `${config.issuer}/oauth/authorize?${params.toString()}`, redirectUri };
}

type FetchImpl = typeof globalThis.fetch;

function tokenFromResponse(json: Record<string, unknown>, previous?: GuruOAuthToken, now = Date.now()): GuruOAuthToken {
  const accessToken = (json.access_token as string | undefined) ?? previous?.accessToken ?? "";
  const idToken = (json.id_token as string | undefined) ?? previous?.idToken ?? "";
  const refreshToken = (json.refresh_token as string | undefined) ?? previous?.refreshToken ?? "";
  const facts = idToken ? extractAccountFacts(idToken) : { accountId: previous?.accountId, planType: previous?.planType, isFedramp: previous?.isFedramp };
  const expiresAt = expiryFromAccessToken(accessToken) ?? previous?.expiresAt;
  return {
    accessToken,
    refreshToken,
    idToken,
    ...(facts.accountId ? { accountId: facts.accountId } : {}),
    ...(facts.planType ? { planType: facts.planType } : {}),
    ...(facts.isFedramp ? { isFedramp: true } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    authMode: "chatgpt",
    obtainedAt: now
  };
}

/**
 * Fetch with a hard per-request timeout (review 2026-07-08, generalized from the
 * xAI login 2026-07-12): a blackholed token endpoint (flaky Wi-Fi, captive
 * portal, transient DNS) hangs /login and the pre-turn refresh forever without
 * one. Bounds every OAuth POST so a stalled connection aborts instead of freezing.
 */
export async function fetchWithTimeout(
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit & { readonly timeoutMs?: number }
): Promise<Response> {
  const { timeoutMs = 15_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Exchange the authorization code (form-urlencoded) for the token set. */
export async function exchangeCode(
  config: OpenaiCodexOAuthConfig,
  code: string,
  verifier: string,
  redirectUri: string,
  fetchImpl: FetchImpl = globalThis.fetch,
  now = Date.now()
): Promise<GuruOAuthToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    code_verifier: verifier
  });
  const res = await fetchWithTimeout(fetchImpl, `${config.issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!res.ok) {
    throw new Error(`token exchange failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return tokenFromResponse((await res.json()) as Record<string, unknown>, undefined, now);
}

export class OAuthRefreshError extends Error {
  constructor(
    message: string,
    /** `refresh_token_expired` | `refresh_token_reused` | `refresh_token_invalidated` — permanent → re-login. */
    readonly code?: string,
    readonly permanent = false
  ) {
    super(message);
    this.name = "OAuthRefreshError";
  }
}

/** Refresh (application/json). The refresh_token ROTATES — the returned record MUST be persisted. */
export async function refreshOAuthToken(
  config: OpenaiCodexOAuthConfig,
  previous: GuruOAuthToken,
  fetchImpl: FetchImpl = globalThis.fetch,
  now = Date.now()
): Promise<GuruOAuthToken> {
  const res = await fetchWithTimeout(fetchImpl, `${config.issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: config.clientId, grant_type: "refresh_token", refresh_token: previous.refreshToken })
  });
  if (!res.ok) {
    let code: string | undefined;
    try {
      code = ((await res.clone().json()) as Record<string, unknown>).error as string | undefined;
    } catch {
      /* body not JSON */
    }
    const permanent = code === "refresh_token_expired" || code === "refresh_token_reused" || code === "refresh_token_invalidated";
    throw new OAuthRefreshError(`token refresh failed (HTTP ${res.status})${code ? `: ${code}` : ""}`, code, permanent);
  }
  return tokenFromResponse((await res.json()) as Record<string, unknown>, previous, now);
}

/** Is the token within `marginMs` of expiry (or already expired)? Default margin 5 min (codex parity). */
export function isTokenNearExpiry(token: GuruOAuthToken, now = Date.now(), marginMs = 5 * 60 * 1000): boolean {
  return token.expiresAt !== undefined && now >= token.expiresAt - marginMs;
}

/**
 * SHORTCUT (never required): if the codex CLI already signed in, reuse its
 * ~/.codex/auth.json token so a machine that happens to have the CLI doesn't re-prompt
 * a browser flow. The standalone rule (guru needs only itself): this is an OPPORTUNISTIC
 * reuse, and `loginViaLoopback` is always the fallback when the cache is absent.
 * Shape: { tokens: { access_token, refresh_token, id_token, account_id } }.
 */
export function readCodexCacheToken(home: string = homedir(), fileRead: (path: string) => string | null = safeReadFile): GuruOAuthToken | null {
  const text = fileRead(join(home, ".codex", "auth.json"));
  if (!text) {
    return null;
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const tokens = (raw.tokens ?? raw) as Record<string, unknown>;
    const accessToken = tokens.access_token as string | undefined;
    if (!accessToken) {
      return null;
    }
    const idToken = (tokens.id_token as string | undefined) ?? "";
    const facts = idToken ? extractAccountFacts(idToken) : {};
    const accountId = (tokens.account_id as string | undefined) ?? facts.accountId;
    const refreshToken = (tokens.refresh_token as string | undefined) ?? "";
    const expiresAt = expiryFromAccessToken(accessToken);
    // A dead credential must NOT read as "signed in": if the access token is expired and
    // there's no refresh token to renew it, fall through to the native login instead.
    if (expiresAt !== undefined && expiresAt <= Date.now() && !refreshToken) {
      return null;
    }
    return {
      accessToken,
      refreshToken,
      idToken,
      ...(accountId ? { accountId } : {}),
      ...(facts.planType ? { planType: facts.planType } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      authMode: "chatgpt",
      obtainedAt: Date.now()
    };
  } catch {
    return null;
  }
}

export function safeReadFile(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * Parse + allowlist an http(s) URL for browser open. Rejects non-http(s), credentials,
 * and hosts outside the OAuth / loopback set so a remote verification_uri cannot become
 * command-line injection (CodeQL js/command-line-injection).
 */
export function sanitizeBrowserOpenUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const allowed =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host === "auth.openai.com" ||
    host === "chatgpt.com" ||
    host.endsWith(".openai.com") ||
    host === "auth.x.ai" ||
    host.endsWith(".x.ai") ||
    host === "twitter.com" ||
    host === "x.com" ||
    host.endsWith(".twitter.com");
  if (!allowed) {
    return null;
  }
  // Re-serialize so raw input metacharacters cannot survive into argv.
  return parsed.toString();
}

/**
 * Best-effort system-browser open (never an embedded webview). Fixed executable +
 * argv array (shell:false) and a sanitized http(s) URL only — never a shell string.
 */
export function defaultOpenBrowser(url: string): void {
  const safeUrl = sanitizeBrowserOpenUrl(url);
  if (safeUrl === null) {
    return;
  }
  const platform = process.platform;
  const [cmd, args]: [string, string[]] =
    platform === "win32"
      ? ["cmd.exe", ["/c", "start", "", safeUrl]]
      : platform === "darwin"
        ? ["open", [safeUrl]]
        : ["xdg-open", [safeUrl]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: false, windowsHide: true });
    child.unref();
  } catch {
    /* headless / no opener — the caller prints the URL for manual paste */
  }
}

export interface LoopbackLoginDeps {
  readonly config?: OpenaiCodexOAuthConfig;
  readonly fetchImpl?: FetchImpl;
  readonly openBrowser?: (url: string) => void;
  readonly createServerImpl?: typeof createServer;
  readonly onUrl?: (url: string) => void; // print the URL so the operator can paste if the browser didn't open
  readonly timeoutMs?: number;
  readonly rng?: (n: number) => Buffer;
  readonly now?: () => number;
}

const SUCCESS_HTML =
  "<!doctype html><meta charset=utf-8><title>guru</title><body style=\"font-family:system-ui;background:#12091F;color:#E9DEF8;display:grid;place-items:center;height:100vh;margin:0\"><div style=\"text-align:center\"><h2>✓ Signed in to guru</h2><p>You can close this tab and return to the terminal.</p></div>";

/**
 * Run the full interactive loopback login: bind 127.0.0.1:port, open the browser,
 * catch the callback, validate `state`, exchange the code. Resolves to guru's own token.
 */
export function loginViaLoopback(deps: LoopbackLoginDeps = {}): Promise<GuruOAuthToken> {
  const config = deps.config ?? resolveOAuthConfig();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const createServerImpl = deps.createServerImpl ?? createServer;
  const now = deps.now ?? Date.now;
  const pkce = generatePkce(deps.rng ?? randomBytes);
  const { url, redirectUri } = buildAuthorizeUrl(config, pkce);

  return new Promise<GuruOAuthToken>((resolve, reject) => {
    let server: Server | undefined;
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`login timed out after ${Math.round((deps.timeoutMs ?? 120000) / 1000)}s — no callback received`)), deps.timeoutMs ?? 120000);

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
      const requestUrl = new URL(req.url ?? "/", `http://localhost:${config.redirectPort}`);
      if (requestUrl.pathname !== "/auth/callback") {
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
      exchangeCode(config, code, pkce.verifier, redirectUri, fetchImpl, now()).then(
        (token) => finish(null, token),
        (exchangeError: unknown) => finish(exchangeError instanceof Error ? exchangeError : new Error(String(exchangeError)))
      );
    };

    server = createServerImpl(handler);
    server.on("error", (serverError) => finish(new Error(`could not bind 127.0.0.1:${config.redirectPort} — ${serverError.message}. Another process may hold the port; a device-code fallback is planned.`)));
    server.listen(config.redirectPort, "127.0.0.1", () => {
      deps.onUrl?.(url);
      (deps.openBrowser ?? defaultOpenBrowser)(url);
    });
  });
}
