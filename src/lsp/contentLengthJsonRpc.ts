import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { scrubSecretValues } from "../safety/secretSafety.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_NOTIFICATION_QUEUE = 32;
const DEFAULT_MAX_STDERR_CHARS = 4_000;
const DEFAULT_CLOSE_GRACE_MS = 2_000;
const MAX_HEADER_BYTES = 16 * 1024;

export interface ContentLengthJsonRpcSpawnOptions {
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: ["pipe", "pipe", "pipe"];
  readonly shell: false;
  readonly windowsHide: true;
}

/** Injectable only for deterministic transport tests; product callers use Node's spawn. */
export type SpawnContentLengthJsonRpcProcess = (
  command: string,
  args: readonly string[],
  options: ContentLengthJsonRpcSpawnOptions
) => ChildProcessWithoutNullStreams;

export interface ContentLengthJsonRpcOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly defaultTimeoutMs?: number;
  readonly maxPayloadBytes?: number;
  readonly maxBufferBytes?: number;
  readonly maxNotificationQueue?: number;
  readonly maxStderrChars?: number;
  readonly closeGraceMs?: number;
  readonly spawnProcess?: SpawnContentLengthJsonRpcProcess;
}

export interface ContentLengthJsonRpcWaitOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ContentLengthJsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export class ContentLengthJsonRpcRequestError extends Error {
  constructor(
    readonly rpc: ContentLengthJsonRpcError,
    readonly method: string
  ) {
    super(scrubSecretValues(`JSON-RPC ${method} failed (${rpc.code}): ${rpc.message}`));
    this.name = "ContentLengthJsonRpcRequestError";
  }
}

export interface ContentLengthJsonRpcNotificationSubscription {
  /** Resolves with the params from the next matching server notification. */
  next(options?: ContentLengthJsonRpcWaitOptions): Promise<unknown>;
  close(): void;
}

export interface ContentLengthJsonRpcConnection {
  request(method: string, params?: unknown, options?: ContentLengthJsonRpcWaitOptions): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  /**
   * Subscribe before the request that can emit the notification. Each subscription
   * retains only the newest configured number of notifications.
   */
  subscribe(method: string): ContentLengthJsonRpcNotificationSubscription;
  close(): Promise<void>;
  /** Bounded and secret-scrubbed diagnostic tail; never raw child stderr. */
  stderrTail(): string;
  readonly exited: Promise<number | null>;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly abortCleanup: (() => void) | null;
}

interface PendingNotification {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly abortCleanup: (() => void) | null;
}

interface SubscriptionState {
  readonly method: string;
  readonly queue: unknown[];
  pending: PendingNotification | null;
  closed: boolean;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function transportError(message: string): Error {
  return new Error(scrubSecretValues(message));
}

function encodeFrame(message: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"),
    body
  ]);
}

export function connectContentLengthJsonRpc(
  options: ContentLengthJsonRpcOptions
): ContentLengthJsonRpcConnection {
  if (options.command.trim().length === 0) {
    throw new Error("JSON-RPC child command must not be empty.");
  }

  const defaultTimeoutMs = positiveInteger(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, "defaultTimeoutMs");
  const maxPayloadBytes = positiveInteger(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, "maxPayloadBytes");
  const maxBufferBytes = positiveInteger(options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES, "maxBufferBytes");
  const maxNotificationQueue = positiveInteger(
    options.maxNotificationQueue ?? DEFAULT_MAX_NOTIFICATION_QUEUE,
    "maxNotificationQueue"
  );
  const maxStderrChars = positiveInteger(options.maxStderrChars ?? DEFAULT_MAX_STDERR_CHARS, "maxStderrChars");
  const closeGraceMs = positiveInteger(options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS, "closeGraceMs");
  const maxHeaderBytes = Math.min(MAX_HEADER_BYTES, maxBufferBytes);

  const spawnOptions: ContentLengthJsonRpcSpawnOptions = {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true
  };
  const args = [...(options.args ?? [])];
  const child = options.spawnProcess
    ? options.spawnProcess(options.command, args, spawnOptions)
    : spawn(options.command, args, spawnOptions);

  const pending = new Map<number, PendingRequest>();
  const subscriptions = new Set<SubscriptionState>();
  let nextId = 1;
  let stdoutBuffer = Buffer.alloc(0);
  let stderr = "";
  let closed = false;
  let terminalError: Error | null = null;
  let teardownPromise: Promise<void> | null = null;
  let processExited = child.exitCode !== null || child.signalCode !== null;
  let settleExited!: (code: number | null) => void;
  let exitedSettled = false;

  const exited = new Promise<number | null>((resolve) => {
    settleExited = resolve;
  });

  function settleProcessExit(code: number | null): void {
    if (exitedSettled) {
      return;
    }
    exitedSettled = true;
    processExited = true;
    settleExited(code);
  }

  function cleanupRequest(entry: PendingRequest): void {
    clearTimeout(entry.timer);
    entry.abortCleanup?.();
  }

  function takePending(id: number): PendingRequest | undefined {
    const entry = pending.get(id);
    if (!entry) {
      return undefined;
    }
    pending.delete(id);
    cleanupRequest(entry);
    return entry;
  }

  function failAllPending(error: Error): void {
    for (const [id] of pending) {
      const entry = takePending(id);
      entry?.reject(error);
    }
  }

  function cleanupNotification(entry: PendingNotification): void {
    clearTimeout(entry.timer);
    entry.abortCleanup?.();
  }

  function finishSubscription(state: SubscriptionState, error: Error): void {
    if (state.closed) {
      return;
    }
    state.closed = true;
    subscriptions.delete(state);
    state.queue.length = 0;
    if (state.pending) {
      const waiting = state.pending;
      state.pending = null;
      cleanupNotification(waiting);
      waiting.reject(error);
    }
  }

  function failSubscriptions(error: Error): void {
    for (const subscription of [...subscriptions]) {
      finishSubscription(subscription, error);
    }
  }

  function failConnection(error: Error, terminate: boolean): void {
    if (!terminalError) {
      terminalError = error;
    }
    failAllPending(terminalError);
    failSubscriptions(terminalError);
    if (terminate) {
      void terminateChild();
    }
  }

  function canWrite(): boolean {
    return !closed && !terminalError && !processExited && child.stdin.writable;
  }

  function writeMessage(message: Record<string, unknown>): void {
    if (!canWrite()) {
      throw terminalError ?? transportError("JSON-RPC connection is closed.");
    }
    const output = encodeFrame(message);
    try {
      child.stdin.write(output, (error?: Error | null) => {
        if (error) {
          failConnection(transportError(`JSON-RPC child stdin write failed: ${error.message}`), false);
        }
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const wrapped = transportError(`JSON-RPC child stdin write failed: ${detail}`);
      failConnection(wrapped, false);
      throw wrapped;
    }
  }

  function dispatchNotification(method: string, params: unknown): void {
    for (const subscription of subscriptions) {
      if (subscription.method !== method || subscription.closed) {
        continue;
      }
      if (subscription.pending) {
        const waiting = subscription.pending;
        subscription.pending = null;
        cleanupNotification(waiting);
        waiting.resolve(params);
        continue;
      }
      subscription.queue.push(params);
      if (subscription.queue.length > maxNotificationQueue) {
        subscription.queue.splice(0, subscription.queue.length - maxNotificationQueue);
      }
    }
  }

  function handleMessage(message: Record<string, unknown>): void {
    if (message.jsonrpc !== "2.0") {
      failConnection(transportError("LSP server sent a message without JSON-RPC 2.0 framing."), true);
      return;
    }

    const id = message.id;
    if (typeof message.method === "string") {
      if (typeof id === "number" || typeof id === "string") {
        try {
          writeMessage({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "Client method not supported." }
          });
        } catch {
          // writeMessage already transitions the connection to its terminal state.
        }
        return;
      }
      dispatchNotification(message.method, message.params);
      return;
    }

    if (typeof id !== "number" || !Number.isSafeInteger(id)) {
      return;
    }
    const entry = takePending(id);
    if (!entry) {
      return;
    }
    if (message.error !== undefined && message.error !== null) {
      const raw = typeof message.error === "object" ? (message.error as Record<string, unknown>) : {};
      const rpc: ContentLengthJsonRpcError = {
        code: typeof raw.code === "number" ? raw.code : -32000,
        message: scrubSecretValues(
          (typeof raw.message === "string" ? raw.message : "unknown error").slice(0, 1_000)
        ),
        ...(raw.data !== undefined ? { data: raw.data } : {})
      };
      entry.reject(new ContentLengthJsonRpcRequestError(rpc, entry.method));
      return;
    }
    entry.resolve(message.result);
  }

  function parseContentLength(headerBytes: Buffer): number {
    const header = headerBytes.toString("latin1");
    const values: string[] = [];
    for (const line of header.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon <= 0) {
        throw transportError("LSP server sent a malformed protocol header.");
      }
      const name = line.slice(0, colon).trim().toLowerCase();
      if (name === "content-length") {
        values.push(line.slice(colon + 1).trim());
      }
    }
    if (values.length !== 1) {
      throw transportError("LSP server must send exactly one Content-Length header.");
    }
    const raw = values[0] ?? "";
    if (!/^\d+$/.test(raw)) {
      throw transportError("LSP server sent an invalid Content-Length header.");
    }
    const length = Number(raw);
    if (!Number.isSafeInteger(length)) {
      throw transportError("LSP server sent an invalid Content-Length header.");
    }
    if (length > maxPayloadBytes) {
      throw transportError(`LSP server payload exceeded the ${maxPayloadBytes}-byte cap.`);
    }
    return length;
  }

  function drainStdout(): void {
    while (!terminalError && stdoutBuffer.byteLength > 0) {
      const headerEnd = stdoutBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (stdoutBuffer.byteLength > maxHeaderBytes) {
          failConnection(transportError("LSP server stdout exceeded the transport buffer cap."), true);
          stdoutBuffer = Buffer.alloc(0);
        }
        return;
      }
      if (headerEnd > maxHeaderBytes) {
        failConnection(transportError("LSP server stdout exceeded the transport buffer cap."), true);
        stdoutBuffer = Buffer.alloc(0);
        return;
      }

      let contentLength: number;
      try {
        contentLength = parseContentLength(stdoutBuffer.subarray(0, headerEnd));
      } catch (error) {
        failConnection(error instanceof Error ? error : transportError(String(error)), true);
        stdoutBuffer = Buffer.alloc(0);
        return;
      }
      const bodyStart = headerEnd + 4;
      const frameLength = bodyStart + contentLength;
      if (frameLength > maxBufferBytes) {
        failConnection(transportError("LSP server frame exceeded the transport buffer cap."), true);
        stdoutBuffer = Buffer.alloc(0);
        return;
      }
      if (stdoutBuffer.byteLength < frameLength) {
        return;
      }

      const body = stdoutBuffer.subarray(bodyStart, frameLength);
      stdoutBuffer = stdoutBuffer.subarray(frameLength);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        failConnection(transportError("LSP server sent a malformed JSON payload."), true);
        stdoutBuffer = Buffer.alloc(0);
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        failConnection(transportError("LSP server sent a non-object JSON-RPC payload."), true);
        stdoutBuffer = Buffer.alloc(0);
        return;
      }
      handleMessage(parsed as Record<string, unknown>);
    }
  }

  child.stdout.on("data", (chunk: Buffer | string) => {
    if (terminalError || closed) {
      return;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (stdoutBuffer.byteLength + bytes.byteLength > maxBufferBytes) {
      failConnection(transportError("LSP server stdout exceeded the transport buffer cap."), true);
      stdoutBuffer = Buffer.alloc(0);
      return;
    }
    stdoutBuffer = Buffer.concat([stdoutBuffer, bytes]);
    drainStdout();
  });
  child.stdout.on("error", (error) => {
    failConnection(transportError(`LSP server stdout failed: ${error.message}`), true);
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    stderr = (stderr + text).slice(-maxStderrChars);
  });
  child.stderr.on("error", () => {
    // Stderr is diagnostic-only; losing it must not crash an otherwise healthy server.
  });

  child.stdin.on("error", (error) => {
    failConnection(transportError(`LSP server stdin failed: ${error.message}`), false);
  });

  child.on("error", (error) => {
    failConnection(transportError(`LSP server process failed to start: ${error.message}`), false);
  });
  child.on("exit", (code) => {
    settleProcessExit(code);
    if (!closed && !terminalError) {
      failConnection(transportError("LSP server process exited before responding."), false);
    }
  });
  child.on("close", (code) => {
    settleProcessExit(code);
    if (!closed && !terminalError) {
      failConnection(transportError("LSP server process closed before responding."), false);
    }
  });

  function safeKill(signal: NodeJS.Signals): void {
    if (processExited || child.exitCode !== null || child.signalCode !== null) {
      processExited = true;
      return;
    }
    try {
      child.kill(signal);
    } catch {
      // The bounded wait below remains authoritative even when kill itself fails.
    }
  }

  function waitForExit(timeoutMs: number): Promise<void> {
    if (processExited || child.exitCode !== null || child.signalCode !== null) {
      processExited = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      void exited.then(finish);
    });
  }

  function terminateChild(): Promise<void> {
    if (teardownPromise) {
      return teardownPromise;
    }
    teardownPromise = (async () => {
      try {
        if (!child.stdin.destroyed) {
          child.stdin.end();
        }
      } catch {
        // A child can close stdin between the state check and end().
      }
      if (processExited || child.exitCode !== null || child.signalCode !== null) {
        processExited = true;
        return;
      }
      safeKill("SIGTERM");
      await waitForExit(closeGraceMs);
      if (processExited || child.exitCode !== null || child.signalCode !== null) {
        processExited = true;
        return;
      }
      safeKill("SIGKILL");
      await waitForExit(closeGraceMs);
    })();
    return teardownPromise;
  }

  return {
    request(method, params, requestOptions) {
      const normalizedMethod = method.trim();
      if (normalizedMethod.length === 0) {
        return Promise.reject(transportError("JSON-RPC request method must not be empty."));
      }
      if (terminalError) {
        return Promise.reject(terminalError);
      }
      if (closed || processExited) {
        return Promise.reject(transportError("JSON-RPC connection is closed."));
      }
      const timeoutMs = positiveInteger(requestOptions?.timeoutMs ?? defaultTimeoutMs, "timeoutMs");
      const signal = requestOptions?.signal;
      const id = nextId;
      nextId += 1;

      return new Promise<unknown>((resolve, reject) => {
        if (signal?.aborted) {
          reject(transportError(`JSON-RPC ${normalizedMethod} aborted.`));
          return;
        }
        let abortCleanup: (() => void) | null = null;
        const timer = setTimeout(() => {
          const entry = takePending(id);
          entry?.reject(transportError(`JSON-RPC ${normalizedMethod} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
        if (signal) {
          const onAbort = (): void => {
            const entry = takePending(id);
            entry?.reject(transportError(`JSON-RPC ${normalizedMethod} aborted.`));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          abortCleanup = () => signal.removeEventListener("abort", onAbort);
        }
        pending.set(id, { method: normalizedMethod, resolve, reject, timer, abortCleanup });
        try {
          writeMessage({
            jsonrpc: "2.0",
            id,
            method: normalizedMethod,
            ...(params !== undefined ? { params } : {})
          });
        } catch (error) {
          const entry = takePending(id);
          entry?.reject(error instanceof Error ? error : transportError(String(error)));
        }
      });
    },

    notify(method, params) {
      const normalizedMethod = method.trim();
      if (normalizedMethod.length === 0) {
        throw transportError("JSON-RPC notification method must not be empty.");
      }
      writeMessage({
        jsonrpc: "2.0",
        method: normalizedMethod,
        ...(params !== undefined ? { params } : {})
      });
    },

    subscribe(method) {
      const normalizedMethod = method.trim();
      if (normalizedMethod.length === 0) {
        throw transportError("JSON-RPC notification method must not be empty.");
      }
      if (terminalError) {
        throw terminalError;
      }
      if (closed || processExited) {
        throw transportError("JSON-RPC connection is closed.");
      }
      const state: SubscriptionState = {
        method: normalizedMethod,
        queue: [],
        pending: null,
        closed: false
      };
      subscriptions.add(state);

      return {
        next(waitOptions) {
          if (state.closed) {
            return Promise.reject(transportError("JSON-RPC notification subscription is closed."));
          }
          if (state.queue.length > 0) {
            return Promise.resolve(state.queue.shift());
          }
          if (state.pending) {
            return Promise.reject(
              transportError("JSON-RPC notification subscription already has a pending wait.")
            );
          }
          const timeoutMs = positiveInteger(waitOptions?.timeoutMs ?? defaultTimeoutMs, "timeoutMs");
          const signal = waitOptions?.signal;
          if (signal?.aborted) {
            return Promise.reject(
              transportError(`JSON-RPC ${normalizedMethod} notification wait aborted.`)
            );
          }
          return new Promise<unknown>((resolve, reject) => {
            let abortCleanup: (() => void) | null = null;
            const timer = setTimeout(() => {
              const waiting = state.pending;
              if (!waiting) {
                return;
              }
              state.pending = null;
              cleanupNotification(waiting);
              waiting.reject(
                transportError(
                  `JSON-RPC ${normalizedMethod} notification wait timed out after ${timeoutMs}ms.`
                )
              );
            }, timeoutMs);
            if (signal) {
              const onAbort = (): void => {
                const waiting = state.pending;
                if (!waiting) {
                  return;
                }
                state.pending = null;
                cleanupNotification(waiting);
                waiting.reject(
                  transportError(`JSON-RPC ${normalizedMethod} notification wait aborted.`)
                );
              };
              signal.addEventListener("abort", onAbort, { once: true });
              abortCleanup = () => signal.removeEventListener("abort", onAbort);
            }
            state.pending = { resolve, reject, timer, abortCleanup };
          });
        },
        close() {
          finishSubscription(
            state,
            transportError("JSON-RPC notification subscription is closed.")
          );
        }
      };
    },

    async close() {
      if (!closed) {
        closed = true;
        const error = terminalError ?? transportError("JSON-RPC connection closed.");
        failAllPending(error);
        failSubscriptions(error);
      }
      await terminateChild();
    },

    stderrTail() {
      return scrubSecretValues(stderr).slice(-maxStderrChars);
    },

    exited
  };
}
