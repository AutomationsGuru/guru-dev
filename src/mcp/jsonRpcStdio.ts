import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { scrubSecretValues } from "../safety/secretSafety.js";

/**
 * Newline-delimited JSON-RPC 2.0 over child-process stdio — the MCP stdio
 * transport (spec 2025-03-26). Deliberately minimal and bounded:
 *
 * - every request carries a timeout (a blackholed server must never hang a turn);
 * - the stdout buffer is capped (a runaway server cannot exhaust memory);
 * - non-JSON stdout lines are tolerated and skipped (misbehaving servers log
 *   to stdout despite the spec) — stderr is collected separately, scrubbed;
 * - server→client REQUESTS are answered with -32601 (method not found) so the
 *   stream stays healthy; server notifications are ignored in v1;
 * - close() rejects all pending requests, then TERM→KILLs the child.
 *
 * Error strings pass through scrubSecretValues before leaving this module —
 * a server that echoes an env value into a crash message must not leak it.
 */

const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_CHARS = 4_000;
const CLOSE_GRACE_MS = 2_000;

export interface JsonRpcStdioOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Child env — pass the real process env so the server finds its own keys. */
  readonly env?: NodeJS.ProcessEnv;
  readonly defaultTimeoutMs?: number;
}

export interface JsonRpcRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export class JsonRpcRequestError extends Error {
  constructor(
    readonly rpc: JsonRpcError,
    method: string
  ) {
    super(scrubSecretValues(`JSON-RPC ${method} failed (${rpc.code}): ${rpc.message}`));
    this.name = "JsonRpcRequestError";
  }
}

export interface JsonRpcConnection {
  request(method: string, params?: unknown, options?: JsonRpcRequestOptions): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): Promise<void>;
  /** Bounded, secret-scrubbed tail of the child's stderr — for diagnostics. */
  stderrTail(): string;
  readonly exited: Promise<number | null>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  readonly timer: NodeJS.Timeout;
  readonly abortCleanup?: () => void;
}

export function connectStdioJsonRpc(options: JsonRpcStdioOptions): JsonRpcConnection {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  const child: ChildProcessWithoutNullStreams = spawn(options.command, [...(options.args ?? [])], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true
  });

  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let stdoutBuffer = "";
  let stderrTail = "";
  let closed = false;
  let spawnFailure: Error | null = null;

  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      failAllPending(new Error("MCP server process exited before responding."));
      resolve(code);
    });
  });

  child.on("error", (error) => {
    // Spawn failure (ENOENT, EACCES, ...) — fail everything legibly.
    spawnFailure = new Error(scrubSecretValues(`MCP server process failed to start: ${error.message}`));
    failAllPending(spawnFailure);
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-MAX_STDERR_CHARS);
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    if (stdoutBuffer.length > MAX_BUFFER_BYTES) {
      failAllPending(new Error("MCP server stdout exceeded the transport buffer cap."));
      stdoutBuffer = "";
      void closeChild();
      return;
    }
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        handleLine(line);
      }
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });

  function handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) {
        return;
      }
      message = parsed as Record<string, unknown>;
    } catch {
      // Tolerated: a server that logs prose to stdout. Protocol lines still correlate by id.
      return;
    }

    const id = message.id;
    const hasMethod = typeof message.method === "string";

    if (hasMethod && (typeof id === "number" || typeof id === "string")) {
      // Server→client REQUEST (sampling, roots, ...): not supported in v1 — answer
      // method-not-found instead of going silent, so the server can proceed.
      writeMessage({ jsonrpc: "2.0", id, error: { code: -32601, message: "Client method not supported." } });
      return;
    }
    if (hasMethod) {
      return; // Server notification — ignored in v1.
    }

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

    if (message.error !== undefined && message.error !== null) {
      const raw = message.error as Partial<JsonRpcError>;
      entry.reject(
        new JsonRpcRequestError(
          { code: typeof raw.code === "number" ? raw.code : -32000, message: typeof raw.message === "string" ? raw.message : "unknown error", data: raw.data },
          "request"
        )
      );
      return;
    }
    entry.resolve(message.result);
  }

  function writeMessage(message: Record<string, unknown>): void {
    if (closed || !child.stdin.writable) {
      return;
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function failAllPending(error: Error): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.abortCleanup?.();
      entry.reject(error);
    }
    pending.clear();
  }

  async function closeChild(): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.stdin.end();
    child.kill();
    // TERM→KILL escalation, bounded — a wedged server must not outlive the harness.
    const killTimer = setTimeout(() => child.kill("SIGKILL"), CLOSE_GRACE_MS);
    await exited;
    clearTimeout(killTimer);
  }

  return {
    request(method, params, requestOptions) {
      return new Promise<unknown>((resolve, reject) => {
        if (spawnFailure) {
          reject(spawnFailure);
          return;
        }
        if (closed) {
          reject(new Error("JSON-RPC connection is closed."));
          return;
        }
        const id = nextId;
        nextId += 1;
        const timeoutMs = requestOptions?.timeoutMs ?? defaultTimeoutMs;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`JSON-RPC ${method} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);

        let abortCleanup: (() => void) | undefined;
        const signal = requestOptions?.signal;
        if (signal) {
          const onAbort = (): void => {
            pending.delete(id);
            clearTimeout(timer);
            reject(new Error(`JSON-RPC ${method} aborted.`));
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          abortCleanup = () => signal.removeEventListener("abort", onAbort);
        }

        pending.set(id, { resolve, reject, timer, ...(abortCleanup ? { abortCleanup } : {}) });
        writeMessage({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
      });
    },
    notify(method, params) {
      writeMessage({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      failAllPending(new Error("JSON-RPC connection closed."));
      await closeChild();
    },
    stderrTail() {
      return scrubSecretValues(stderrTail);
    },
    exited
  };
}
