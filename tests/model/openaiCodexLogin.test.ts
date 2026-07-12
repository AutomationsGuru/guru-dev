import { createHash } from "node:crypto";

import { describe, expect, it, afterEach } from "vitest";

import { resolveRouteCredential } from "../../src/model/directChat.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  extractAccountFacts,
  fetchWithTimeout,
  generatePkce,
  isTokenNearExpiry,
  readCodexCacheToken,
  refreshOAuthToken,
  resolveOAuthConfig,
  sanitizeBrowserOpenUrl,
  type GuruOAuthToken
} from "../../src/model/oauth/openaiCodexLogin.js";
import { stripTrailingSlashes } from "../../src/model/agentTurn.js";
import { clearOAuthTokenAccessor, registerOAuthTokenAccessor } from "../../src/model/oauth/tokenRegistry.js";
import { resolveProviderWire } from "../../src/model/providerWire.js";
import { ProviderRouteDescriptorSchema } from "../../src/providers/schemas.js";

const b64url = (obj: object): string => Buffer.from(JSON.stringify(obj)).toString("base64url");
const jwt = (payload: object): string => `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
const EMPTY_ENV = {} as NodeJS.ProcessEnv;

afterEach(() => clearOAuthTokenAccessor());

describe("openai codex native OAuth — flow mechanics", () => {
  it("PKCE: S256 challenge = base64url(sha256(verifier)), no padding", () => {
    let n = 0;
    const pkce = generatePkce(() => Buffer.alloc(n++ === 0 ? 64 : 32, n));
    expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier, "ascii").digest().toString("base64url"));
    expect(pkce.verifier).not.toContain("=");
    expect(pkce.state.length).toBeGreaterThan(0);
  });

  it("authorize URL: codex client_id, S256, loopback redirect, whitelisted originator", () => {
    const { url, redirectUri } = buildAuthorizeUrl(resolveOAuthConfig(EMPTY_ENV), { verifier: "v", challenge: "chal", state: "st" });
    expect(redirectUri).toBe("http://localhost:1455/auth/callback");
    const u = new URL(url);
    expect(u.origin).toBe("https://auth.openai.com");
    expect(u.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe("chal");
    expect(u.searchParams.get("originator")).toBe("codex_cli_rs");
    expect(u.searchParams.get("scope")).toContain("offline_access");
  });

  it("config is fully env-overridable (rotation = config, not code)", () => {
    const cfg = resolveOAuthConfig({ CODEX_APP_SERVER_LOGIN_CLIENT_ID: "app_other", GURU_OPENAI_OAUTH_PORT: "1457" } as NodeJS.ProcessEnv);
    expect(cfg.clientId).toBe("app_other");
    expect(cfg.redirectPort).toBe(1457);
  });

  it("extractAccountFacts pulls chatgpt_account_id + plan from the id_token claim", () => {
    const facts = extractAccountFacts(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" } }));
    expect(facts.accountId).toBe("acct_123");
    expect(facts.planType).toBe("pro");
  });

  it("exchangeCode posts form-urlencoded and returns token with decoded account id + expiry", async () => {
    const idToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_9" } });
    const accessToken = jwt({ exp: 2_000_000_000 });
    let sentContentType = "";
    let sentBody = "";
    const fetchImpl = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      sentContentType = init.headers["content-type"] ?? "";
      sentBody = init.body;
      return { ok: true, json: async () => ({ access_token: accessToken, refresh_token: "r1", id_token: idToken }) };
    }) as unknown as typeof fetch;
    const token = await exchangeCode(resolveOAuthConfig(EMPTY_ENV), "CODE", "VER", "http://localhost:1455/auth/callback", fetchImpl, 1000);
    expect(sentContentType).toBe("application/x-www-form-urlencoded");
    expect(sentBody).toContain("grant_type=authorization_code");
    expect(sentBody).toContain("code_verifier=VER");
    expect(token.accessToken).toBe(accessToken);
    expect(token.accountId).toBe("acct_9");
    expect(token.expiresAt).toBe(2_000_000_000 * 1000);
  });

  it("refresh posts JSON and persists the ROTATED refresh_token + carries account id forward", async () => {
    const previous: GuruOAuthToken = { accessToken: "old", refreshToken: "r1", idToken: "", accountId: "acct_1", authMode: "chatgpt", obtainedAt: 0 };
    let sentContentType = "";
    const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
      sentContentType = init.headers["content-type"] ?? "";
      return { ok: true, json: async () => ({ access_token: "new", refresh_token: "r2" }) };
    }) as unknown as typeof fetch;
    const token = await refreshOAuthToken(resolveOAuthConfig(EMPTY_ENV), previous, fetchImpl, 5);
    expect(sentContentType).toBe("application/json");
    expect(token.accessToken).toBe("new");
    expect(token.refreshToken).toBe("r2");
    expect(token.accountId).toBe("acct_1");
  });

  it("isTokenNearExpiry respects the 5-minute margin", () => {
    const token: GuruOAuthToken = { accessToken: "a", refreshToken: "r", idToken: "", authMode: "chatgpt", obtainedAt: 0, expiresAt: 1_000_000 };
    expect(isTokenNearExpiry(token, 1_000_000 - 60_000)).toBe(true);
    expect(isTokenNearExpiry(token, 1_000_000 - 10 * 60_000)).toBe(false);
  });
});

describe("OAuth POSTs are timeout-bounded (a blackholed token endpoint must not hang /login or the pre-turn refresh)", () => {
  const hangingFetch = ((_url: unknown, init: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")));
    })) as typeof fetch;

  it("fetchWithTimeout aborts a hung request at timeoutMs", async () => {
    await expect(fetchWithTimeout(hangingFetch, "https://example.test/token", { method: "POST", timeoutMs: 10 })).rejects.toThrow(
      /aborted/
    );
  });

  it("exchangeCode and refreshOAuthToken pass an abort signal into fetch (the timeout is armed)", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const fetchImpl = (async (_url: unknown, init: { signal?: AbortSignal }) => {
      signals.push(init.signal);
      return new Response(JSON.stringify({ access_token: "", refresh_token: "r2" }), { status: 200 });
    }) as typeof fetch;
    await exchangeCode(resolveOAuthConfig(EMPTY_ENV), "CODE", "VER", "http://localhost:1455/auth/callback", fetchImpl, 1000);
    const previous: GuruOAuthToken = { accessToken: "", refreshToken: "r1", idToken: "", authMode: "chatgpt", obtainedAt: 0 };
    await refreshOAuthToken(resolveOAuthConfig(EMPTY_ENV), previous, fetchImpl, 5);
    expect(signals).toHaveLength(2);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });
});

describe("readCodexCacheToken — ~/.codex shortcut (opportunistic reuse, never required)", () => {
  const authJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "AT-codex", refresh_token: "RT-codex", id_token: "", account_id: "acct_codex_1" }
  });

  it("reuses ~/.codex/auth.json tokens.access_token + account_id when present", () => {
    const token = readCodexCacheToken("/home/op", (path) => (path.replace(/\\/gu, "/") === "/home/op/.codex/auth.json" ? authJson : null));
    expect(token?.accessToken).toBe("AT-codex");
    expect(token?.refreshToken).toBe("RT-codex");
    expect(token?.accountId).toBe("acct_codex_1");
    expect(token?.authMode).toBe("chatgpt");
  });

  it("returns null when the cache is absent (falls back to the native browser login)", () => {
    expect(readCodexCacheToken("/home/op", () => null)).toBeNull();
  });

  it("returns null for an expired token with no refresh_token (dead credential must not read as signed in)", () => {
    const past = Math.floor((Date.now() - 60_000) / 1000);
    const jwt = `x.${Buffer.from(JSON.stringify({ exp: past })).toString("base64url")}.y`;
    const expiredNoRefresh = JSON.stringify({ tokens: { access_token: jwt, refresh_token: "" } });
    expect(readCodexCacheToken("/home/op", (p) => (p.replace(/\\/gu, "/") === "/home/op/.codex/auth.json" ? expiredNoRefresh : null))).toBeNull();
  });
});

describe("guru-oauth lane resolves token + account id from the vault registry (never a cache)", () => {
  const route = ProviderRouteDescriptorSchema.parse({
    providerId: "openai-codex",
    modelId: "gpt-5.5",
    routeId: "openai-codex/gpt-5.5",
    routeType: "operator-provider-plan-auth",
    apiFamily: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    credentialSource: { type: "guru-oauth", envVarNames: [] },
    status: "active",
    directFirstRank: 2,
    allowedRouterFallback: false,
    wire: { headers: [{ header: "ChatGPT-Account-Id", oauthAccount: true }] }
  });

  it("resolveRouteCredential returns the vaulted access token; the wire header carries the account id", () => {
    registerOAuthTokenAccessor((providerId) => (providerId === "openai-codex" ? { accessToken: "AT-123", accountId: "acct_42" } : null));
    const credential = resolveRouteCredential(route, EMPTY_ENV);
    expect(credential.usable).toBe(true);
    expect(credential.source).toBe("guru-oauth");
    expect(credential.value).toBe("AT-123");
    expect(resolveProviderWire(route, EMPTY_ENV).extraHeaders["ChatGPT-Account-Id"]).toBe("acct_42");
  });

  it("with no token stored, the lane is not usable and points at /login (no cache fall-through)", () => {
    const credential = resolveRouteCredential(route, EMPTY_ENV);
    expect(credential.usable).toBe(false);
    expect(credential.reason).toContain("/login");
  });
});

describe("sanitizeBrowserOpenUrl — CodeQL command-injection hardening", () => {
  it("accepts known OAuth / loopback hosts and re-serializes", () => {
    expect(sanitizeBrowserOpenUrl("https://auth.openai.com/authorize?x=1")).toContain("auth.openai.com");
    expect(sanitizeBrowserOpenUrl("https://auth.x.ai/oauth")).toContain("auth.x.ai");
    expect(sanitizeBrowserOpenUrl("http://127.0.0.1:1455/auth/callback")).toContain("127.0.0.1");
  });

  it("rejects non-http(s), credentials, and unknown hosts", () => {
    expect(sanitizeBrowserOpenUrl("file:///etc/passwd")).toBeNull();
    expect(sanitizeBrowserOpenUrl("https://evil.example/phish")).toBeNull();
    expect(sanitizeBrowserOpenUrl("https://user:pass@auth.openai.com/x")).toBeNull();
    expect(sanitizeBrowserOpenUrl("not a url")).toBeNull();
  });
});

describe("stripTrailingSlashes — CodeQL ReDoS hardening", () => {
  it("strips trailing slashes without a trailing-slash regex", () => {
    expect(stripTrailingSlashes("https://api.example.com///")).toBe("https://api.example.com");
    expect(stripTrailingSlashes("https://api.example.com")).toBe("https://api.example.com");
    expect(stripTrailingSlashes("")).toBe("");
  });
});
