import { describe, expect, it, vi } from "vitest";

import {
  createWebSearchTools,
  parseDuckDuckGoHtml,
  searchWeb,
  unwrapDuckDuckGoHref
} from "../../src/tools/builtins/webSearchTool.js";

const SAMPLE_HTML = `
<html><body>
  <div class="result">
    <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example <b>Docs</b></a>
    <a class="result__snippet" href="#">Official documentation for the example API.</a>
  </div>
  <div class="result">
    <a class="result__a" href="https://github.com/example/repo">example/repo</a>
    <a class="result__snippet" href="#">Source repository on GitHub.</a>
  </div>
</body></html>
`;

describe("parseDuckDuckGoHtml", () => {
  it("extracts title, unwrapped url, and snippet", () => {
    const hits = parseDuckDuckGoHtml(SAMPLE_HTML, 5);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      title: "Example Docs",
      url: "https://example.com/docs",
      snippet: "Official documentation for the example API."
    });
    expect(hits[1]?.url).toBe("https://github.com/example/repo");
  });

  it("respects maxResults", () => {
    expect(parseDuckDuckGoHtml(SAMPLE_HTML, 1)).toHaveLength(1);
  });
});

describe("unwrapDuckDuckGoHref", () => {
  it("decodes uddg redirect wrappers", () => {
    expect(unwrapDuckDuckGoHref("https://duckduckgo.com/l/?uddg=https%3A%2F%2Ffoo.bar%2Fx")).toBe("https://foo.bar/x");
  });
});

describe("searchWeb + tool", () => {
  it("uses the injected fetch and returns structured hits", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(SAMPLE_HTML, { status: 200, headers: { "content-type": "text/html" } })
    ) as unknown as typeof fetch;

    const out = await searchWeb({ query: "example docs", maxResults: 5, timeoutMs: 5_000 }, { fetchImpl });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.url).toBe("https://example.com/docs");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const calledUrl = String(vi.mocked(fetchImpl).mock.calls[0]?.[0] ?? "");
    expect(calledUrl).toContain("duckduckgo.com");
    expect(calledUrl).toContain("example");
  });

  it("reports non-ok HTTP without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const out = await searchWeb({ query: "x", maxResults: 3, timeoutMs: 5_000 }, { fetchImpl });
    expect(out.ok).toBe(false);
    expect(out.results).toEqual([]);
    expect(out.summary).toContain("503");
  });

  it("registers web_search tool id", async () => {
    const tools = createWebSearchTools({
      fetchImpl: (async () => new Response(SAMPLE_HTML, { status: 200 })) as typeof fetch
    });
    expect(tools[0]?.id).toBe("web_search");
    const result = (await tools[0]!.execute({ query: "q", maxResults: 2, timeoutMs: 5_000 }, {})) as {
      results: unknown[];
    };
    expect(result.results.length).toBeGreaterThan(0);
  });
});
