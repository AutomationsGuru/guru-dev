import { z } from "zod";

import type { ToolDefinition } from "../registry.js";

/**
 * Bounded HTTP(S) fetch for research — parity with modern harness “open page”
 * tools. Hard caps on size/time; no cookie jar; redirects limited; text only.
 */

export const WEB_FETCH_DEFAULT_MAX_BYTES = 120_000;
export const WEB_FETCH_DEFAULT_TIMEOUT_MS = 20_000;
export const WEB_FETCH_MAX_REDIRECTS = 5;

const WebFetchInputSchema = z
  .object({
    url: z.string().trim().url().max(2048),
    maxBytes: z.number().int().positive().max(500_000).default(WEB_FETCH_DEFAULT_MAX_BYTES),
    timeoutMs: z.number().int().positive().max(60_000).default(WEB_FETCH_DEFAULT_TIMEOUT_MS)
  })
  .strict();

const WebFetchOutputSchema = z
  .object({
    ok: z.boolean(),
    url: z.string(),
    finalUrl: z.string(),
    status: z.number().int(),
    contentType: z.string().optional(),
    bytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    /** True when HTML was converted to readable text. */
    convertedFromHtml: z.boolean().default(false),
    text: z.string(),
    summary: z.string()
  })
  .strict();

export type WebFetchOutput = z.infer<typeof WebFetchOutputSchema>;

export interface WebFetchDeps {
  readonly fetchImpl?: typeof fetch;
}

function assertHttpUrl(raw: string): URL {
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http(s) URLs are allowed (got ${parsed.protocol}).`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }
  return parsed;
}

function decodeEntities(text: string): string {
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

/**
 * Best-effort HTML → readable text for agents (no dependency).
 * Strips scripts/styles, turns headings/links/lists into plain markdown-ish lines.
 * Exported for unit tests.
 */
export function htmlToReadableText(html: string): string {
  let s = html;
  // Drop non-content blocks first.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ");
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/giu, " ");
  s = s.replace(/<!--[\s\S]*?-->/gu, " ");

  // Structure → newlines / markdown-ish.
  s = s.replace(/<\/?(h[1-6])\b[^>]*>/giu, "\n\n");
  s = s.replace(/<\/p>/giu, "\n\n");
  s = s.replace(/<br\s*\/?>/giu, "\n");
  s = s.replace(/<\/(div|section|article|li|tr)>/giu, "\n");
  s = s.replace(/<li\b[^>]*>/giu, "\n- ");
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu, (_m, href: string, inner: string) => {
    const label = decodeEntities(inner.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim());
    return label ? `[${label}](${href})` : href;
  });

  // Remaining tags out.
  s = s.replace(/<[^>]+>/gu, " ");
  s = decodeEntities(s);
  // Collapse whitespace while keeping paragraph breaks.
  s = s
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
  return s;
}

function looksLikeHtml(contentType: string | undefined, body: string): boolean {
  if (contentType && /html/iu.test(contentType)) {
    return true;
  }
  // Sniff when servers lie about content-type.
  const head = body.slice(0, 512).toLowerCase();
  return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/u.test(head);
}

/**
 * Pure-ish fetch helper — exported for tests. Follows redirects manually so we
 * re-validate each hop stays http(s).
 */
export async function fetchUrlText(
  input: z.infer<typeof WebFetchInputSchema>,
  deps: WebFetchDeps = {}
): Promise<WebFetchOutput> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available in this runtime.");
  }

  let current = assertHttpUrl(input.url);
  let status = 0;
  let contentType: string | undefined;
  let bodyText = "";
  let hops = 0;

  while (hops <= WEB_FETCH_MAX_REDIRECTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await fetchImpl(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "text/*,application/json,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1",
          "user-agent": "guruharness-web-fetch/1.4"
        }
      });
      status = response.status;
      contentType = response.headers.get("content-type") ?? undefined;

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`Redirect ${response.status} without Location header.`);
        }
        current = assertHttpUrl(new URL(location, current).toString());
        hops += 1;
        continue;
      }

      const buf = Buffer.from(await response.arrayBuffer());
      const truncated = buf.byteLength > input.maxBytes;
      const slice = truncated ? buf.subarray(0, input.maxBytes) : buf;
      bodyText = slice.toString("utf8");
      const ok = response.ok;
      let text = bodyText;
      let convertedFromHtml = false;
      if (ok && looksLikeHtml(contentType, bodyText)) {
        text = htmlToReadableText(bodyText);
        convertedFromHtml = text.length > 0 && text !== bodyText;
      }
      return {
        ok,
        url: input.url,
        finalUrl: current.toString(),
        status,
        ...(contentType ? { contentType } : {}),
        bytes: slice.byteLength,
        truncated,
        convertedFromHtml,
        text,
        summary: ok
          ? `Fetched ${slice.byteLength} byte(s) from ${current.toString()}${truncated ? " (truncated)" : ""}${convertedFromHtml ? "; HTML→text" : ""}.`
          : `HTTP ${status} from ${current.toString()} (${slice.byteLength} byte(s)).`
      };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Too many redirects (>${WEB_FETCH_MAX_REDIRECTS}).`);
}

export function createWebFetchTools(deps: WebFetchDeps = {}): readonly ToolDefinition[] {
  const tool: ToolDefinition<typeof WebFetchInputSchema, typeof WebFetchOutputSchema> = {
    id: "web_fetch",
    title: "Fetch a web page",
    description:
      "HTTP(S) GET a URL and return text (bounded size + timeout). HTML pages are converted to readable text (scripts/styles stripped, links kept as markdown). Pair with web_search for discovery. Network edge.",
    inputSchema: WebFetchInputSchema,
    outputSchema: WebFetchOutputSchema,
    async execute(input, context) {
      // Honour turn abort if present.
      if (context.signal?.aborted) {
        throw new Error("web_fetch aborted.");
      }
      try {
        return await fetchUrlText(input, deps);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          url: input.url,
          finalUrl: input.url,
          status: 0,
          bytes: 0,
          truncated: false,
          convertedFromHtml: false,
          text: "",
          summary: `web_fetch failed: ${message}`
        };
      }
    }
  };
  return [tool];
}
