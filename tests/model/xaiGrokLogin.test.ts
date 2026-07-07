import { describe, expect, it } from "vitest";

import { generatePkce } from "../../src/model/oauth/openaiCodexLogin.js";
import {
  buildXaiAuthorizeUrl,
  exchangeXaiCode,
  loginViaXaiDeviceCode,
  loginViaXaiLoopback,
  readGrokCacheToken,
  refreshXaiToken,
  resolveXaiOAuthConfig
} from "../../src/model/oauth/xaiGrokLogin.js";

const fakeFetch = (body: Record<string, unknown>, ok = true, status = 200): typeof globalThis.fetch =>
  (async () => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) })) as unknown as typeof globalThis.fetch;

describe("xaiGrokLogin — guru-native SuperGrok OAuth (loopback PKCE, no CLI required)", () => {
  it("resolves the xAI OAuth config with auth.x.ai defaults, env-overridable", () => {
    const cfg = resolveXaiOAuthConfig({});
    expect(cfg.issuer).toBe("https://auth.x.ai");
    expect(cfg.authorizePath).toBe("/oauth2/authorize");
    expect(cfg.tokenPath).toBe("/oauth2/token");
    expect(cfg.clientId).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(cfg.redirectPort).toBe(56121);
    // Scope MUST include the Grok plan scopes or the token 403s at inference.
    expect(cfg.scope).toContain("grok-cli:access");
    expect(cfg.scope).toContain("api:access");
    expect(cfg.deviceCodePath).toBe("/oauth2/device/code");
    const overridden = resolveXaiOAuthConfig({ GURU_XAI_OAUTH_ISSUER: "https://auth.test", GURU_XAI_OAUTH_CLIENT_ID: "cid" });
    expect(overridden.issuer).toBe("https://auth.test");
    expect(overridden.clientId).toBe("cid");
  });

  it("a BLANK client_id env override falls back to the default (never an empty client_id → xAI 'Missing or invalid client_id')", () => {
    const cfg = resolveXaiOAuthConfig({ GURU_XAI_OAUTH_CLIENT_ID: "", GURU_XAI_OAUTH_SCOPE: "   " });
    expect(cfg.clientId).toBe("b1a00492-073a-47ea-816f-4c329264a828"); // NOT ""
    expect(cfg.scope).toContain("grok-cli:access"); // whitespace-only → default
  });

  it("device-code flow: requests a code, opens the browser, polls past 'authorization_pending', returns the token", async () => {
    const calls: string[] = [];
    let opened = "";
    const fetchImpl = (async (url: string, init?: { body?: string }) => {
      calls.push(url);
      if (url.endsWith("/oauth2/device/code")) {
        return {
          ok: true,
          json: async () => ({
            device_code: "DC-1",
            user_code: "ABCD-EFGH",
            verification_uri: "https://accounts.x.ai/device",
            verification_uri_complete: "https://accounts.x.ai/device?user_code=ABCD-EFGH",
            interval: 1,
            expires_in: 900
          })
        };
      }
      // token endpoint: pending on the first poll, success on the second
      const pollCount = calls.filter((c) => c.endsWith("/oauth2/token")).length;
      if (pollCount === 1) {
        return { ok: false, status: 400, clone: () => ({ json: async () => ({ error: "authorization_pending" }) }) };
      }
      return { ok: true, json: async () => ({ access_token: "AT-grok", refresh_token: "RT-grok", expires_in: 3600 }) };
    }) as unknown as typeof globalThis.fetch;

    let prompted: string | undefined;
    const token = await loginViaXaiDeviceCode({
      fetchImpl,
      openBrowser: (u) => {
        opened = u;
      },
      onPrompt: (g) => {
        prompted = g.userCode;
      },
      sleep: async () => {},
      now: () => 1_000
    });

    expect(prompted).toBe("ABCD-EFGH");
    expect(opened).toBe("https://accounts.x.ai/device?user_code=ABCD-EFGH"); // opens the pre-filled URL
    expect(token.accessToken).toBe("AT-grok");
    expect(token.refreshToken).toBe("RT-grok");
    expect(token.authMode).toBe("grok");
    expect(calls.filter((c) => c.endsWith("/oauth2/token")).length).toBe(2); // pending, then success
  });

  it("builds a PKCE authorize URL against auth.x.ai/oauth2/authorize with the loopback redirect + plan/referrer", () => {
    const cfg = resolveXaiOAuthConfig({});
    const pkce = generatePkce();
    const { url, redirectUri } = buildXaiAuthorizeUrl(cfg, pkce, "nonce123");
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe("https://auth.x.ai/oauth2/authorize");
    expect(parsed.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("client_id")).toBe(cfg.clientId);
    expect(parsed.searchParams.get("plan")).toBe("generic");
    expect(parsed.searchParams.get("referrer")).toBe("hermes-agent");
    expect(parsed.searchParams.get("nonce")).toBe("nonce123");
    expect(redirectUri).toBe("http://127.0.0.1:56121/callback");
    expect(parsed.searchParams.get("redirect_uri")).toBe(redirectUri);
  });

  it("exchanges an auth code for a grok-mode token (verifier + challenge both echoed)", async () => {
    const cfg = resolveXaiOAuthConfig({});
    const pkce = generatePkce();
    const token = await exchangeXaiCode(
      cfg,
      "the-code",
      pkce,
      "http://127.0.0.1:56121/callback",
      fakeFetch({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }),
      1_000
    );
    expect(token.accessToken).toBe("AT");
    expect(token.refreshToken).toBe("RT");
    expect(token.authMode).toBe("grok");
    expect(token.expiresAt).toBe(1_000 + 3600 * 1000);
  });

  it("refreshes a rotating token and persists the NEW refresh_token", async () => {
    const cfg = resolveXaiOAuthConfig({});
    const prev = { accessToken: "old", refreshToken: "R1", idToken: "", authMode: "grok" as const, obtainedAt: 0 };
    const next = await refreshXaiToken(cfg, prev, fakeFetch({ access_token: "new", refresh_token: "R2" }), 2_000);
    expect(next.accessToken).toBe("new");
    expect(next.refreshToken).toBe("R2"); // rotated — the caller MUST persist it
  });

  it("falls back to an OS-assigned port when the preferred port is reserved (Windows winnat EACCES)", async () => {
    // Fake HTTP server: the preferred port (non-zero) fails with EACCES (like a Windows
    // excluded range); the OS-assigned port (0) binds and reports the real port 54321.
    const makeFakeServer = () => {
      let errHandler: ((e: NodeJS.ErrnoException) => void) | undefined;
      return {
        on(event: string, handler: (e: NodeJS.ErrnoException) => void) {
          if (event === "error") errHandler = handler;
          return this;
        },
        listen(port: number, _host: string, cb: () => void) {
          if (port !== 0) {
            setTimeout(() => errHandler?.(Object.assign(new Error("permission denied"), { code: "EACCES" })), 0);
          } else {
            setTimeout(() => cb(), 0);
          }
          return this;
        },
        address() {
          return { port: 54321 };
        },
        close() {}
      };
    };

    let capturedUrl = "";
    const p = loginViaXaiLoopback({
      createServerImpl: (() => makeFakeServer()) as never,
      openBrowser: () => {},
      onUrl: (url) => {
        capturedUrl = url;
      },
      timeoutMs: 150
    });
    p.catch(() => {}); // it will time out (no callback) — we only assert the fallback URL

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(capturedUrl).not.toBe(""); // browser opened despite the reserved preferred port
    const parsed = new URL(capturedUrl);
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:54321/callback");
    await expect(p).rejects.toThrow(/timed out/u);
  });

  it("readGrokCacheToken reuses ~/.grok/auth.json when present (shortcut), null when absent", () => {
    const authJson = JSON.stringify({ "https://auth.x.ai::cid": { access_token: "cached-AT", refresh_token: "cached-RT" } });
    const token = readGrokCacheToken("/home/op", (path) => (path.replace(/\\/gu, "/") === "/home/op/.grok/auth.json" ? authJson : null));
    expect(token?.accessToken).toBe("cached-AT");
    expect(token?.refreshToken).toBe("cached-RT");
    expect(token?.authMode).toBe("grok");
    expect(readGrokCacheToken("/home/op", () => null)).toBeNull();
  });
});
