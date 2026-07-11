/**
 * Shared HTTP helpers for read-only net tools (read_url / search_web).
 * Zero new dependencies — Node fetch + simple HTML strip.
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BYTES = 512 * 1024;

/** Fetch a URL with timeout + size cap. Throws a short operator-facing message. */
export async function fetchText(
  url: string,
  options: { readonly timeoutMs?: number; readonly accept?: string; readonly fetchImpl?: typeof fetch } = {}
): Promise<{ readonly status: number; readonly contentType: string; readonly text: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http(s) URLs are supported (got ${parsed.protocol})`);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(parsed.toString(), {
      signal: controller.signal,
      headers: {
        "user-agent": "guruharness/1.4 (+read-only fetch)",
        accept: options.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5"
      },
      redirect: "follow"
    });
    const contentType = response.headers.get("content-type") ?? "";
    const buffer = Buffer.from(await response.arrayBuffer());
    const slice = buffer.length > MAX_BYTES ? buffer.subarray(0, MAX_BYTES) : buffer;
    const text = slice.toString("utf8");
    return { status: response.status, contentType, text: buffer.length > MAX_BYTES ? `${text}\n\n…[truncated at ${MAX_BYTES} bytes]` : text };
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw new Error(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Crude HTML → readable text. Strips scripts/styles, tags, collapses whitespace.
 * Not a full markdown converter — enough for the model to read docs/pages.
 */
export function htmlToReadableText(html: string): string {
  let text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article|header|footer|main|blockquote)>/giu, "\n")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&#(\d+);/gu, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
  return text;
}

/** Default read_url_content provider. */
export async function defaultFetchUrlContent(
  url: string,
  fetchImpl?: typeof fetch
): Promise<string> {
  const result = await fetchText(url, fetchImpl ? { fetchImpl } : {});
  if (result.status >= 400) {
    throw new Error(`HTTP ${result.status} fetching ${url}`);
  }
  const isHtml = /html|xml/i.test(result.contentType) || /^\s*</u.test(result.text);
  const body = isHtml ? htmlToReadableText(result.text) : result.text;
  return body.length > 0 ? body : "(empty response body)";
}

export interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/**
 * Default search_web provider — DuckDuckGo Instant Answer API (no key).
 * Returns RelatedTopics + Abstract when present; empty array on a dry miss.
 */
export async function defaultWebSearch(
  query: string,
  domain?: string,
  fetchImpl?: typeof fetch
): Promise<WebSearchHit[]> {
  const q = domain ? `${query} site:${domain}` : query;
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
  const result = await fetchText(url, {
    accept: "application/json",
    timeoutMs: 15_000,
    ...(fetchImpl ? { fetchImpl } : {})
  });
  if (result.status >= 400) {
    throw new Error(`Search HTTP ${result.status}`);
  }
  let json: {
    AbstractText?: string;
    AbstractURL?: string;
    Heading?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
  };
  try {
    json = JSON.parse(result.text) as typeof json;
  } catch {
    throw new Error("Search response was not JSON");
  }
  const hits: WebSearchHit[] = [];
  if (json.AbstractText && json.AbstractURL) {
    hits.push({
      title: json.Heading || json.AbstractURL,
      url: json.AbstractURL,
      snippet: json.AbstractText
    });
  }
  const flatten = (topics: NonNullable<typeof json.RelatedTopics>): void => {
    for (const topic of topics) {
      if (topic.Text && topic.FirstURL) {
        hits.push({ title: topic.Text.slice(0, 120), url: topic.FirstURL, snippet: topic.Text });
      }
      if (topic.Topics) {
        flatten(topic.Topics);
      }
    }
  };
  if (json.RelatedTopics) {
    flatten(json.RelatedTopics);
  }
  return hits.slice(0, 8);
}
