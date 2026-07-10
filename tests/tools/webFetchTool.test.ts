import { describe, expect, it } from "vitest";

import {
  createWebFetchTools,
  fetchUrlText,
  htmlToReadableText,
  type WebFetchOutput
} from "../../src/tools/builtins/webFetchTool.js";

function mockFetch(handlers: Record<string, { status: number; body: string; headers?: Record<string, string>; location?: string }>): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // Honour abort
    if (init?.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const hit = handlers[url];
    if (!hit) {
      return new Response("missing", { status: 404 });
    }
    if (hit.location) {
      return new Response(null, { status: hit.status, headers: { location: hit.location, ...(hit.headers ?? {}) } });
    }
    return new Response(hit.body, { status: hit.status, headers: { "content-type": "text/plain", ...(hit.headers ?? {}) } });
  };
}

describe("web_fetch — bounded HTTP GET", () => {
  it("returns text for a successful fetch via the real helper", async () => {
    const result = await fetchUrlText(
      { url: "https://example.com/doc", maxBytes: 10_000, timeoutMs: 5_000 },
      { fetchImpl: mockFetch({ "https://example.com/doc": { status: 200, body: "hello guru" } }) }
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.text).toBe("hello guru");
    expect(result.summary).toContain("Fetched");
  });

  it("rejects non-http schemes and credentials", async () => {
    await expect(
      fetchUrlText({ url: "file:///etc/passwd", maxBytes: 100, timeoutMs: 1000 }, { fetchImpl: mockFetch({}) })
    ).rejects.toThrow(/http/i);
    await expect(
      fetchUrlText(
        { url: "https://user:pass@example.com/x", maxBytes: 100, timeoutMs: 1000 },
        { fetchImpl: mockFetch({}) }
      )
    ).rejects.toThrow(/credentials/i);
  });

  it("truncates oversized bodies", async () => {
    const body = "x".repeat(500);
    const result = await fetchUrlText(
      { url: "https://example.com/big", maxBytes: 50, timeoutMs: 5000 },
      { fetchImpl: mockFetch({ "https://example.com/big": { status: 200, body } }) }
    );
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(50);
    expect(result.text.length).toBe(50);
  });

  it("follows a single redirect and re-validates the hop", async () => {
    const result = await fetchUrlText(
      { url: "https://example.com/old", maxBytes: 1000, timeoutMs: 5000 },
      {
        fetchImpl: mockFetch({
          "https://example.com/old": { status: 302, body: "", location: "https://example.com/new" },
          "https://example.com/new": { status: 200, body: "landed" }
        })
      }
    );
    expect(result.ok).toBe(true);
    expect(result.finalUrl).toBe("https://example.com/new");
    expect(result.text).toBe("landed");
  });

  it("createWebFetchTools execute path returns a failed summary instead of throwing", async () => {
    const [tool] = createWebFetchTools({
      fetchImpl: async () => {
        throw new Error("network down");
      }
    });
    const out = (await tool!.execute(
      { url: "https://example.com", maxBytes: 100, timeoutMs: 1000 },
      {}
    )) as WebFetchOutput;
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("network down");
  });

  it("converts HTML bodies to readable text", async () => {
    const html = `<!doctype html><html><head><style>body{}</style><script>alert(1)</script></head>
      <body><h1>Title</h1><p>Hello <a href="https://ex.com">world</a>.</p><ul><li>one</li><li>two</li></ul></body></html>`;
    const result = await fetchUrlText(
      { url: "https://example.com/page", maxBytes: 50_000, timeoutMs: 5_000 },
      {
        fetchImpl: mockFetch({
          "https://example.com/page": {
            status: 200,
            body: html,
            headers: { "content-type": "text/html; charset=utf-8" }
          }
        })
      }
    );
    expect(result.ok).toBe(true);
    expect(result.convertedFromHtml).toBe(true);
    expect(result.text).toContain("Title");
    expect(result.text).toContain("[world](https://ex.com)");
    expect(result.text).toContain("- one");
    expect(result.text).not.toContain("alert(1)");
    expect(result.summary).toMatch(/HTML→text/);
  });
});

describe("htmlToReadableText", () => {
  it("strips scripts and keeps link labels", () => {
    const text = htmlToReadableText(`<p>See <a href="/x">docs</a></p><script>x</script>`);
    expect(text).toContain("[docs](/x)");
    expect(text).not.toContain("script");
  });
});
