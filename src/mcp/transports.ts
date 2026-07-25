import { registerSecretValue, scrubSecretValues } from "../safety/secretSafety.js";
import { connectStdioJsonRpc, type JsonRpcConnection, type JsonRpcStdioOptions } from "./jsonRpcStdio.js";
import type { McpServerConfig, McpTransport } from "./schemas.js";

/**
 * MCP transport factory + remote transports (IDEA-D3, R-CR-MCP-XPORT) —
 * stdio / http / sse behind one JsonRpcConnection surface so client.ts needs
 * no per-transport handshake logic.
 *
 * - stdio  → delegates to connectStdioJsonRpc (spawned child, newline JSON-RPC).
 * - http   → one POST per request/notification; replies arrive in the POST
 *            response body (spec 2025-03-26 "Streamable HTTP", v1: no GET
 *            server-initiated stream).
 * - sse    → legacy HTTP+SSE transport (spec 2025-03-26): POSTs go to a
 *            message endpoint (config `postUrl`, or discovered from the
 *            server's `event: endpoint` frame); replies arrive as `data:`
 *            frames on the GET event stream and correlate by id.
 *
 * Every transport enforces the same floors as the stdio path: per-request
 * timeout (a blackholed server must never hang a turn), AbortSignal support,
 * close() that rejects pending + future requests, and a bounded buffer.
 *
 * Secret constitution (§3.3): error strings pass through scrubSecretValues
 * before leaving this module, and auth header values are registered with the
 * value scrubber at connect time. Headers are auth material — never logged,
 * never interpolated into errors.
 */

export type { JsonRpcConnection } from "./jsonRpcStdio.js";

export interface HttpTransportOptions {
  readonly transport: "http" | "sse";
  /** Event-stream URL for sse; request URL for http. */
  readonly url: string;
  /** POST endpoint for sse when already known (skips `endpoint` discovery). */
  readonly postUrl?: string;
  /** Extra request headers — auth material; values never appear in errors. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly defaultTimeoutMs?: number;
}

export type ConnectTransportOptions = JsonRpcStdioOptions | HttpTransportOptions;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;
const SSE_ENDPOINT_WAIT_MS = 10_000;

/** Resolve which connector a server config uses. */
export function createMcpTransport(config: McpServerConfig): McpTransport {
  return config.transport;
}

/** Connect over the transport implied by the options (stdio | http | sse). */
export function connectJsonRpcTransport(options: ConnectTransportOptions): JsonRpcConnection {
  if ("command" in options) {
    return connectStdioJsonRpc(options);
  }
  // Structural choke (§3.3): auth header values enter the value registry here
  // so any later printable path redacts them. Register the raw value AND its
  // scheme-stripped credential ("Bearer x" → "x") — exact-match redaction
  // cannot catch a bare credential substring leaking out of a wrapped header.
  // Values are never interpolated into errors.
  if (options.headers !== undefined) {
    for (const value of Object.values(options.headers)) {
      registerSecretValue(value);
      const credential = value.replace(/^(?:Bearer|Basic|Token)\s+/iu, "");
      if (credential !== value) {
        registerSecretValue(credential);
      }
    }
  }
  return options.transport === "sse" ? connectSseJsonRpc(options) : connectHttpJsonRpc(options);
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  readonly timer: NodeJS.Timeout;
  readonly abortCleanup?: () => void;
}

interface RpcFrameError {
  readonly code: number;
  readonly message: string;
}

/** Shared lifecycle: id allocation, pending map, timeout/abort, close. */
function createPendingTracker(defaultTimeoutMs: number) {
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let closed = false;

  function failAllPending(error: Error): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.abortCleanup?.();
      entry.reject(error);
    }
    pending.clear();
  }

  function track<T>(
    method: string,
    options: { timeoutMs?: number; signal?: AbortSignal } | undefined,
    send: (id: number, fail: (error: Error) => void) => T
  ): { promise: Promise<unknown>; handle: T } {
    if (closed) {
      return { promise: Promise.reject(new Error("JSON-RPC connection is closed.")), handle: undefined as T };
    }
    let handle = undefined as T;
    const promise = new Promise<unknown>((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`JSON-RPC ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      let abortCleanup: (() => void) | undefined;
      const signal = options?.signal;
      const fail = (error: Error): void => {
        if (!pending.has(id)) {
          return;
        }
        pending.delete(id);
        clearTimeout(timer);
        abortCleanup?.();
        reject(error);
      };
      if (signal) {
        const onAbort = (): void => fail(new Error(`JSON-RPC ${method} aborted.`));
        if (signal.aborted) {
          reject(new Error(`JSON-RPC ${method} aborted.`));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => signal.removeEventListener("abort", onAbort);
      }

      pending.set(id, { resolve, reject, timer, ...(abortCleanup ? { abortCleanup } : {}) });
      try {
        handle = send(id, fail);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return { promise, handle };
  }

  function settle(id: unknown, result: unknown, error: RpcFrameError | undefined): void {
    if (typeof id !== "number") {
      return;
    }
    const entry = pending.get(id);
    if (!entry) {
      return;
    }
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.abortCleanup?.();
    if (error !== undefined) {
      entry.reject(
        new Error(scrubSecretValues(`JSON-RPC request failed (${typeof error.code === "number" ? error.code : -32000}): ${error.message}`))
      );
      return;
    }
    entry.resolve(result);
  }

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    failAllPending(new Error("JSON-RPC connection closed."));
  }

  return { failAllPending, settle, track, close, isClosed: () => closed };
}

function parseRpcReply(payload: unknown): { id: unknown; result: unknown; error?: RpcFrameError } | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const message = payload as Record<string, unknown>;
  if (typeof message.method === "string") {
    return null; // server→client request/notification — not supported in v1
  }
  const raw = message.error as Partial<RpcFrameError> | null | undefined;
  const error =
    raw !== undefined && raw !== null
      ? { code: typeof raw.code === "number" ? raw.code : -32000, message: typeof raw.message === "string" ? raw.message : "unknown error" }
      : undefined;
  return { id: message.id, result: message.result, ...(error !== undefined ? { error } : {}) };
}

/** http: one POST per request; the response body carries the reply. */
function connectHttpJsonRpc(options: HttpTransportOptions): JsonRpcConnection {
  const tracker = createPendingTracker(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  let exitedResolve!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    exitedResolve = resolve;
  });

  async function post(body: string, signal?: AbortSignal): Promise<Response> {
    return fetch(options.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      body,
      ...(signal ? { signal } : {})
    });
  }

  return {
    request(method, params, requestOptions) {
      const { promise, handle } = tracker.track(method, requestOptions, (id, fail) => {
        const controller = new AbortController();
        const onCallerAbort = (): void => controller.abort();
        requestOptions?.signal?.addEventListener("abort", onCallerAbort, { once: true });
        void post(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }), controller.signal)
          .then(async (response) => {
            if (!response.ok) {
              throw new Error(`MCP http transport received HTTP ${response.status} for ${method}.`);
            }
            if (response.status === 204 || response.status === 202) {
              return undefined; // accepted, no reply body
            }
            const text = await response.text();
            if (text.trim().length === 0) {
              return undefined;
            }
            const reply = parseRpcReply(JSON.parse(text));
            if (reply === null) {
              return undefined;
            }
            tracker.settle(reply.id, reply.result, reply.error);
            return undefined;
          })
          .catch((error: unknown) => {
            const message = error instanceof Error && error.name === "AbortError" ? `JSON-RPC ${method} aborted.` : error instanceof Error ? error.message : String(error);
            fail(new Error(scrubSecretValues(message)));
          })
          .finally(() => {
            requestOptions?.signal?.removeEventListener("abort", onCallerAbort);
          });
        return controller;
      });
      return promise.finally(() => handle?.abort());
    },
    notify(method, params) {
      if (tracker.isClosed()) {
        return;
      }
      void post(JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) })).catch(() => {
        /* best-effort — a dropped notification must not crash the loop */
      });
    },
    async close() {
      tracker.close();
      exitedResolve(0);
    },
    stderrTail: () => "",
    exited
  };
}

/** sse: GET event stream + POST message endpoint (legacy spec 2025-03-26). */
function connectSseJsonRpc(options: HttpTransportOptions): JsonRpcConnection {
  const tracker = createPendingTracker(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  let exitedResolve!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    exitedResolve = resolve;
  });
  const streamController = new AbortController();
  let postUrl = options.postUrl;
  let endpointWaiter: { resolve(url: string): void; reject(error: Error): void } | undefined;

  function deliverFrame(json: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return; // tolerate non-JSON frames (keepalive prose, server chatter)
    }
    const reply = parseRpcReply(parsed);
    if (reply !== null) {
      tracker.settle(reply.id, reply.result, reply.error);
    }
  }

  async function pumpEventStream(response: Response): Promise<void> {
    if (response.body === null) {
      throw new Error("MCP sse transport received an empty event stream.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];
    let eventType = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_BUFFER_BYTES) {
        throw new Error("MCP sse event stream exceeded the transport buffer cap.");
      }
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/u, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line === "") {
          // Frame boundary — endpoint frames name the POST path; everything
          // else is a JSON-RPC payload for the pending map.
          if (dataLines.length > 0) {
            const payload = dataLines.join("\n");
            if (eventType === "endpoint") {
              if (postUrl === undefined) {
                postUrl = new URL(payload, options.url).toString();
                endpointWaiter?.resolve(postUrl);
                endpointWaiter = undefined;
              }
            } else {
              deliverFrame(payload);
            }
            dataLines = [];
          }
          eventType = "";
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /u, ""));
        } else if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
  }

  // Open the event stream eagerly so `endpoint` discovery can happen before
  // the first request when postUrl was not configured.
  const streamReady = (async (): Promise<void> => {
    const response = await fetch(options.url, {
      method: "GET",
      headers: { accept: "text/event-stream", ...(options.headers ?? {}) },
      signal: streamController.signal
    });
    if (!response.ok) {
      throw new Error(`MCP sse transport received HTTP ${response.status} opening the event stream.`);
    }
    // The pump runs until close(); its failures fail everything pending.
    pumpEventStream(response).catch((error: unknown) => {
      const message = error instanceof Error && error.name === "AbortError" ? "MCP sse event stream closed." : error instanceof Error ? error.message : String(error);
      tracker.failAllPending(new Error(scrubSecretValues(message)));
      endpointWaiter?.reject(new Error(scrubSecretValues(message)));
    });
  })();
  streamReady.catch((error: unknown) => {
    const message = error instanceof Error && error.name === "AbortError" ? "MCP sse event stream closed." : error instanceof Error ? error.message : String(error);
    tracker.failAllPending(new Error(scrubSecretValues(message)));
    endpointWaiter?.reject(new Error(scrubSecretValues(message)));
  });

  async function resolvePostUrl(): Promise<string> {
    if (postUrl !== undefined) {
      return postUrl;
    }
    await streamReady;
    if (postUrl !== undefined) {
      return postUrl;
    }
    // Bound the wait — a server that never sends `endpoint` must not hang a turn.
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        endpointWaiter = undefined;
        reject(new Error(`MCP sse server did not announce a message endpoint within ${SSE_ENDPOINT_WAIT_MS}ms.`));
      }, SSE_ENDPOINT_WAIT_MS);
      endpointWaiter = {
        resolve: (url) => {
          clearTimeout(timer);
          resolve(url);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      };
    });
  }

  async function postMessage(target: string, body: string): Promise<void> {
    const response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      body
    });
    if (!response.ok) {
      throw new Error(`MCP sse transport received HTTP ${response.status} posting a message.`);
    }
  }

  return {
    request(method, params, requestOptions) {
      const { promise } = tracker.track(method, requestOptions, (id, fail) => {
        void resolvePostUrl()
          .then((target) => postMessage(target, JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })))
          .catch((error: unknown) => {
            fail(new Error(scrubSecretValues(error instanceof Error ? error.message : String(error))));
          });
        return undefined;
      });
      return promise;
    },
    notify(method, params) {
      if (tracker.isClosed()) {
        return;
      }
      void resolvePostUrl()
        .then((target) => postMessage(target, JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) })))
        .catch(() => {
          /* best-effort */
        });
    },
    async close() {
      tracker.close();
      streamController.abort();
      endpointWaiter?.reject(new Error("JSON-RPC connection closed."));
      endpointWaiter = undefined;
      // Swallow the stream teardown result; close() is about local state.
      await streamReady.catch(() => undefined);
      exitedResolve(0);
    },
    stderrTail: () => "",
    exited
  };
}
