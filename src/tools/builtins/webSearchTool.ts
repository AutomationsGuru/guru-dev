import { z } from "zod";

import type { ToolDefinition } from "../registry.js";

/**
 * Bounded web search (no API key) — DuckDuckGo HTML results.
 * Complements `web_fetch` for the research pair modern harnesses expose.
 */

export const WEB_SEARCH_DEFAULT_MAX_RESULTS = 8;
export const WEB_SEARCH_DEFAULT_TIMEOUT_MS = 15_000;
export const WEB_SEARCH_MAX_BYTES = 400_000;

const WebSearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    maxResults: z.number().int().positive().max(15).default(WEB_SEARCH_DEFAULT_MAX_RESULTS),
    timeoutMs: z.number().int().positive().max(60_000).default(WEB_SEARCH_DEFAULT_TIMEOUT_MS)
  })
  .strict();

const SearchHitSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string()
});

const WebSearchOutputSchema = z
  .object({
    ok: z.boolean(),
    query: z.string(),
    results: z.array(SearchHitSchema),
    summary: z.string()
  })
  .strict();

export type WebSearchOutput = z.infer<typeof WebSearchOutputSchema>;
export type WebSearchHit = z.infer<typeof SearchHitSchema>;

export interface WebSearchDeps {
  readonly fetchImpl?: typeof fetch;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&nbsp;/giu, " ")
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim());
}

/**
 * Extract DDG uddg= target from redirect wrappers when present.
 * Exported for unit tests.
 */
export function unwrapDuckDuckGoHref(rawHref: string): string {
  try {
    const parsed = new URL(rawHref, "https://html.duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) {
      return decodeURIComponent(uddg);
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    // fall through
  }
  return rawHref;
}

/**
 * Parse DuckDuckGo HTML result cards. Tolerates modest markup drift.
 * Exported for unit tests (no network).
 */
export function parseDuckDuckGoHtml(html: string, maxResults: number): WebSearchHit[] {
  const results: WebSearchHit[] = [];
  // Classic html.duckduckgo.com result links; snippet is nearby in the same card.
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu;

  for (const match of html.matchAll(linkRe)) {
    const full = match[0] ?? "";
    const index = match.index ?? 0;
    const href = match[1] ?? "";
    const titleHtml = match[2] ?? "";
    const url = unwrapDuckDuckGoHref(href);
    if (!/^https?:\/\//iu.test(url)) {
      continue;
    }
    const title = stripTags(titleHtml);
    if (!title) {
      continue;
    }
    // Look ahead ~800 chars for a snippet element in the same card.
    const window = html.slice(index, index + full.length + 800);
    const snippetMatch =
      /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div|span)>/iu.exec(window) ??
      /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\//iu.exec(window);
    const snippet = stripTags(snippetMatch?.[1] ?? "").slice(0, 400);
    results.push({ title, url, snippet });
    if (results.length >= maxResults) {
      break;
    }
  }

  // Fallback: any absolute http(s) anchors with visible text (lite pages / markup drift)
  if (results.length === 0) {
    const loose = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/giu;
    for (const match of html.matchAll(loose)) {
      const url = unwrapDuckDuckGoHref(match[1] ?? "");
      if (!/^https?:\/\//iu.test(url) || /duckduckgo\.com/iu.test(url)) {
        continue;
      }
      const title = stripTags(match[2] ?? "");
      if (title.length < 3) {
        continue;
      }
      results.push({ title, url, snippet: "" });
      if (results.length >= maxResults) {
        break;
      }
    }
  }

  return results;
}

export async function searchWeb(
  input: z.infer<typeof WebSearchInputSchema>,
  deps: WebSearchDeps = {}
): Promise<WebSearchOutput> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available in this runtime.");
  }

  const endpoint = new URL("https://html.duckduckgo.com/html/");
  endpoint.searchParams.set("q", input.query);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetchImpl(endpoint.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "user-agent": "guruharness-web-search/1.4"
      }
    });
    const buf = Buffer.from(await response.arrayBuffer());
    const slice = buf.byteLength > WEB_SEARCH_MAX_BYTES ? buf.subarray(0, WEB_SEARCH_MAX_BYTES) : buf;
    const html = slice.toString("utf8");
    if (!response.ok) {
      return {
        ok: false,
        query: input.query,
        results: [],
        summary: `Search HTTP ${response.status} for ${JSON.stringify(input.query)}.`
      };
    }
    const results = parseDuckDuckGoHtml(html, input.maxResults);
    return {
      ok: results.length > 0,
      query: input.query,
      results,
      summary:
        results.length > 0
          ? `Found ${results.length} result(s) for ${JSON.stringify(input.query)}.`
          : `No results parsed for ${JSON.stringify(input.query)} (provider markup may have changed).`
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createWebSearchTools(deps: WebSearchDeps = {}): readonly ToolDefinition[] {
  const tool: ToolDefinition<typeof WebSearchInputSchema, typeof WebSearchOutputSchema> = {
    id: "web_search",
    title: "Search the web",
    description:
      "Search the public web (DuckDuckGo HTML, no API key) and return title/url/snippet hits. Pair with web_fetch to read a chosen page. Network edge.",
    inputSchema: WebSearchInputSchema,
    outputSchema: WebSearchOutputSchema,
    async execute(input, context) {
      if (context.signal?.aborted) {
        throw new Error("web_search aborted.");
      }
      try {
        return await searchWeb(input, deps);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          query: input.query,
          results: [],
          summary: `web_search failed: ${message}`
        };
      }
    }
  };
  return [tool];
}
