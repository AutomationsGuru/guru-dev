import { describe, expect, it } from "vitest";

import { defaultFetchUrlContent, defaultWebSearch, htmlToReadableText } from "../../src/tools/builtins/httpFetch.js";
import { createReadUrlTool } from "../../src/tools/builtins/readUrlTool.js";
import { createSearchWebTool } from "../../src/tools/builtins/searchWebTool.js";

describe("htmlToReadableText", () => {
  it("strips scripts/styles/tags and keeps readable body text", () => {
    const html = `<html><head><style>body{}</style><script>alert(1)</script></head>
      <body><h1>Title</h1><p>Hello <b>world</b></p></body></html>`;
    const text = htmlToReadableText(html);
    expect(text).toContain("Title");
    expect(text).toContain("Hello world");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("<");
  });
});

describe("read_url_content — default provider", () => {
  it("uses injected fetchImpl and returns readable content", async () => {
    const fetchImpl = (async () =>
      new Response("<html><body><p>Sentinel page body</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      })) as typeof fetch;
    const content = await defaultFetchUrlContent("https://example.test/doc", fetchImpl);
    expect(content).toContain("Sentinel page body");

    const tool = createReadUrlTool({ fetchImpl });
    const out = await tool.execute({ url: "https://example.test/doc" }, {});
    expect(out.content).toContain("Sentinel page body");
  });

  it("rejects non-http schemes", async () => {
    await expect(defaultFetchUrlContent("file:///etc/passwd")).rejects.toThrow(/http/i);
  });
});

describe("search_web — default provider", () => {
  it("parses DuckDuckGo Instant Answer JSON via fetchImpl", async () => {
    const payload = {
      Heading: "TypeScript",
      AbstractText: "TypeScript is a typed superset of JavaScript.",
      AbstractURL: "https://www.typescriptlang.org/",
      RelatedTopics: [{ Text: "Handbook - TypeScript", FirstURL: "https://www.typescriptlang.org/docs/" }]
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as typeof fetch;
    const hits = await defaultWebSearch("typescript", undefined, fetchImpl);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.url).toContain("typescriptlang.org");

    const tool = createSearchWebTool({ fetchImpl });
    const out = await tool.execute({ query: "typescript" }, {});
    expect(out.results.length).toBeGreaterThanOrEqual(1);
  });
});
