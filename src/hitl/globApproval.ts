export type WebhookDecision = "approve" | "deny";
export type WebhookApprovalOutcome = "approve" | "deny" | "ask";

export interface WebhookApprovalOptions {
  readonly url: string;
  readonly toolName: string;
  readonly hardEdge: boolean;
  readonly requestId: string;
  readonly callbackToken: string;
  readonly summary?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface WebhookApprovalResult {
  readonly outcome: WebhookApprovalOutcome;
  readonly callbackAccepted: boolean;
  readonly advisoryOutcome: WebhookDecision | null;
}

interface WebhookApprovalPayload {
  readonly toolName?: unknown;
  readonly hardEdge?: unknown;
  readonly requestId?: unknown;
  readonly callbackToken?: unknown;
  readonly summary?: unknown;
}

interface WebhookApprovalResponse {
  readonly decision?: unknown;
  readonly requestId?: unknown;
  readonly callbackToken?: unknown;
}

export function matchGlob(toolName: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (typeof pattern !== "string") {
      return false;
    }
    const trimmed = pattern.trim();
    if (trimmed.length === 0) {
      return false;
    }
    return globToRegExp(trimmed).test(toolName);
  });
}

export async function requestWebhookApproval(options: WebhookApprovalOptions): Promise<WebhookApprovalResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    return { outcome: "ask", callbackAccepted: false, advisoryOutcome: null };
  }

  const payload: WebhookApprovalPayload = {
    toolName: options.toolName,
    hardEdge: options.hardEdge,
    requestId: options.requestId,
    callbackToken: options.callbackToken,
    summary: options.summary
  };

  try {
    const response = await fetchImpl(options.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const parsed = (await response.json()) as WebhookApprovalResponse;
    const advisoryOutcome = normalizeDecision(parsed.decision);
    const callbackAccepted =
      advisoryOutcome !== null &&
      parsed.requestId === options.requestId &&
      parsed.callbackToken === options.callbackToken;

    if (!callbackAccepted || advisoryOutcome === null) {
      return { outcome: "ask", callbackAccepted: false, advisoryOutcome: null };
    }
    if (advisoryOutcome === "deny") {
      return { outcome: "deny", callbackAccepted: true, advisoryOutcome };
    }
    if (options.hardEdge) {
      return { outcome: "ask", callbackAccepted: true, advisoryOutcome };
    }
    return { outcome: "approve", callbackAccepted: true, advisoryOutcome };
  } catch {
    return { outcome: "ask", callbackAccepted: false, advisoryOutcome: null };
  }
}

function normalizeDecision(value: unknown): WebhookDecision | null {
  return value === "approve" || value === "deny" ? value : null;
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const char of pattern) {
    if (char === "*") {
      source += ".*";
      continue;
    }
    if (char === "?") {
      source += ".";
      continue;
    }
    source += escapeRegExp(char);
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
