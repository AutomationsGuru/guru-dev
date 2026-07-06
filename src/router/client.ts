import { sanitizeErrorMessage } from "./health.js";

export interface RouterClientOptions {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface RouterCallResult<TBody = unknown> {
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
  readonly body: TBody;
}

export interface OpenAiChatRequest {
  readonly model: string;
  readonly messages: readonly unknown[];
  readonly stream?: boolean;
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly tools?: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface OpenAiResponsesRequest {
  readonly model: string;
  readonly input: unknown;
  readonly stream?: boolean;
  readonly tools?: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface AnthropicMessagesRequest {
  readonly model: string;
  readonly messages: readonly unknown[];
  readonly max_tokens: number;
  readonly system?: unknown;
  readonly stream?: boolean;
  readonly tools?: readonly unknown[];
  readonly [key: string]: unknown;
}

export class RouterClientError extends Error {
  constructor(
    message: string,
    readonly details: { readonly url: string; readonly status?: number; readonly body?: unknown }
  ) {
    super(message);
    this.name = "RouterClientError";
  }
}

export async function callRouterOpenAiChat(request: OpenAiChatRequest, options: RouterClientOptions = {}): Promise<RouterCallResult> {
  return callRouterEndpoint("/v1/chat/completions", request, options);
}

export async function callRouterOpenAiResponses(request: OpenAiResponsesRequest, options: RouterClientOptions = {}): Promise<RouterCallResult> {
  return callRouterEndpoint("/v1/responses", request, options);
}

export async function callRouterAnthropicMessages(request: AnthropicMessagesRequest, options: RouterClientOptions = {}): Promise<RouterCallResult> {
  return callRouterEndpoint("/v1/messages", request, options);
}

export async function callRouterEndpoint(path: string, body: unknown, options: RouterClientOptions = {}): Promise<RouterCallResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new RouterClientError("fetch is not available in this runtime.", { url: buildRouterUrl(path, options.baseUrl) });
  }

  const url = buildRouterUrl(path, options.baseUrl);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.apiKey) {
    headers.authorization = `Bearer ${options.apiKey}`;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new RouterClientError(`Router request failed: ${sanitizeErrorMessage(error)}`, { url });
  }

  const responseBody = await parseResponseBody(response);
  if (!response.ok) {
    throw new RouterClientError(`Router request failed with HTTP ${response.status}.`, {
      url,
      status: response.status,
      body: redactBody(responseBody)
    });
  }

  return { url, status: response.status, ok: response.ok, body: responseBody };
}

export function buildRouterUrl(path: string, baseUrl = "http://127.0.0.1:4000"): string {
  const normalizedBase = baseUrl.replace(/\/+$/u, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function redactBody(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeErrorMessage(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactBody);
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => (/api[_-]?key|authorization|token|secret/iu.test(key) ? [key, "[redacted]"] : [key, redactBody(item)]))
    );
  }

  return value;
}
