import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ContentLengthJsonRpcRequestError,
  connectContentLengthJsonRpc,
  type ContentLengthJsonRpcConnection,
  type SpawnContentLengthJsonRpcProcess
} from "../../src/lsp/contentLengthJsonRpc.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    return true;
  }

  finish(code = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

interface Harness {
  readonly child: FakeChild;
  readonly connection: ContentLengthJsonRpcConnection;
  readonly writes: Buffer[];
  readonly spawnCalls: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly options: Record<string, unknown>;
  }>;
}

function createHarness(
  overrides: Partial<Parameters<typeof connectContentLengthJsonRpc>[0]> = {}
): Harness {
  const child = new FakeChild();
  const writes: Buffer[] = [];
  const spawnCalls: Harness["spawnCalls"] = [];
  child.stdin.on("data", (chunk: Buffer | string) => {
    writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  const spawnProcess: SpawnContentLengthJsonRpcProcess = (command, args, options) => {
    spawnCalls.push({
      command,
      args: [...args],
      options: options as unknown as Record<string, unknown>
    });
    return child as never;
  };
  const connection = connectContentLengthJsonRpc({
    command: "typescript-language-server",
    args: ["--stdio"],
    defaultTimeoutMs: 100,
    closeGraceMs: 5,
    spawnProcess,
    ...overrides
  });
  return { child, connection, writes, spawnCalls };
}

function frame(message: unknown, headerName = "Content-Length"): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`${headerName}: ${body.byteLength}\r\n\r\n`, "ascii"),
    body
  ]);
}

function decodeFrames(chunks: readonly Buffer[]): Array<Record<string, unknown>> {
  let input = Buffer.concat(chunks);
  const messages: Array<Record<string, unknown>> = [];
  while (input.byteLength > 0) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      break;
    }
    const header = input.subarray(0, headerEnd).toString("ascii");
    const match = /^Content-Length:\s*(\d+)$/im.exec(header);
    if (!match?.[1]) {
      break;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (input.byteLength < bodyStart + length) {
      break;
    }
    messages.push(JSON.parse(input.subarray(bodyStart, bodyStart + length).toString("utf8")) as Record<string, unknown>);
    input = input.subarray(bodyStart + length);
  }
  return messages;
}

async function finish(harness: Harness): Promise<void> {
  harness.child.finish();
  await harness.connection.close();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Content-Length JSON-RPC transport", () => {
  it("spawns without a shell and correlates numeric requests", async () => {
    const harness = createHarness({ cwd: "/repo", env: { PATH: "/bin" } });
    expect(harness.spawnCalls).toEqual([
      {
        command: "typescript-language-server",
        args: ["--stdio"],
        options: expect.objectContaining({
          cwd: "/repo",
          env: { PATH: "/bin" },
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"]
        })
      }
    ]);

    const result = harness.connection.request("initialize", { rootUri: "file:///repo" });
    expect(decodeFrames(harness.writes)).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { rootUri: "file:///repo" }
      }
    ]);

    harness.child.stdout.write(frame({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }));
    await expect(result).resolves.toEqual({ capabilities: {} });

    harness.connection.notify("initialized", {});
    expect(decodeFrames(harness.writes).at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "initialized",
      params: {}
    });
    await finish(harness);
  });

  it("parses case-insensitive chunked headers and bodies with multiple frames per chunk", async () => {
    const harness = createHarness();
    const first = harness.connection.request("one");
    const second = harness.connection.request("two");
    const combined = Buffer.concat([
      frame({ jsonrpc: "2.0", id: 1, result: "héllo" }, "cOnTeNt-LeNgTh"),
      frame({ jsonrpc: "2.0", id: 2, result: { ok: true } })
    ]);

    harness.child.stdout.write(combined.subarray(0, 7));
    harness.child.stdout.write(combined.subarray(7, 31));
    harness.child.stdout.write(combined.subarray(31, combined.byteLength - 2));
    harness.child.stdout.write(combined.subarray(combined.byteLength - 2));

    await expect(first).resolves.toBe("héllo");
    await expect(second).resolves.toEqual({ ok: true });
    await finish(harness);
  });

  it("provides a bounded queued subscription for server notifications", async () => {
    const harness = createHarness({ maxNotificationQueue: 2 });
    const diagnostics = harness.connection.subscribe("textDocument/publishDiagnostics");
    harness.child.stdout.write(
      Buffer.concat([
        frame({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { version: 1 } }),
        frame({ jsonrpc: "2.0", method: "window/logMessage", params: { message: "ignored" } }),
        frame({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { version: 2 } }),
        frame({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { version: 3 } })
      ])
    );

    await expect(diagnostics.next()).resolves.toEqual({ version: 2 });
    await expect(diagnostics.next()).resolves.toEqual({ version: 3 });
    diagnostics.close();
    await finish(harness);
  });

  it("answers unsupported server requests with -32601", async () => {
    const harness = createHarness();
    harness.child.stdout.write(
      frame({ jsonrpc: "2.0", id: "server-1", method: "workspace/applyEdit", params: {} })
    );

    expect(decodeFrames(harness.writes)).toEqual([
      {
        jsonrpc: "2.0",
        id: "server-1",
        error: { code: -32601, message: "Client method not supported." }
      }
    ]);
    await finish(harness);
  });

  it("rejects remote JSON-RPC errors with bounded structured context", async () => {
    const harness = createHarness();
    const request = harness.connection.request("textDocument/hover");
    harness.child.stdout.write(
      frame({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "not ready", data: { retry: false } } })
    );

    const error = await request.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContentLengthJsonRpcRequestError);
    expect(error).toMatchObject({
      method: "textDocument/hover",
      rpc: { code: -32001, message: "not ready", data: { retry: false } }
    });
    await finish(harness);
  });

  it.each([
    ["missing", Buffer.from("Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}")],
    ["duplicate", Buffer.from("Content-Length: 2\r\ncontent-length: 2\r\n\r\n{}")],
    ["invalid", Buffer.from("Content-Length: nope\r\n\r\n{}")],
    ["oversized", Buffer.from("Content-Length: 99\r\n\r\n")]
  ])("rejects pending requests for a %s Content-Length header", async (_label, malformed) => {
    const harness = createHarness({ maxPayloadBytes: 16, maxBufferBytes: 128 });
    const request = harness.connection.request("initialize");
    harness.child.stdout.write(malformed);

    await expect(request).rejects.toThrow(/Content-Length|payload/i);
    await harness.connection.close();
  });

  it("caps an unterminated stdout header buffer", async () => {
    const harness = createHarness({ maxBufferBytes: 32, maxPayloadBytes: 16 });
    const request = harness.connection.request("initialize");
    harness.child.stdout.write(Buffer.alloc(33, 0x41));

    await expect(request).rejects.toThrow(/buffer cap/i);
    await harness.connection.close();
  });

  it("removes timed-out and aborted requests while tolerating late responses", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ defaultTimeoutMs: 20 });

    const timedOut = harness.connection.request("slow");
    const timeoutAssertion = expect(timedOut).rejects.toThrow("timed out after 20ms");
    await vi.advanceTimersByTimeAsync(20);
    await timeoutAssertion;

    harness.child.stdout.write(frame({ jsonrpc: "2.0", id: 1, result: "late" }));
    const aborter = new AbortController();
    const aborted = harness.connection.request("abort-me", undefined, { signal: aborter.signal });
    const abortAssertion = expect(aborted).rejects.toThrow("aborted");
    aborter.abort();
    await abortAssertion;

    const final = harness.connection.request("final");
    harness.child.stdout.write(frame({ jsonrpc: "2.0", id: 3, result: "ok" }));
    await expect(final).resolves.toBe("ok");
    harness.child.finish();
    await harness.connection.close();
  });

  it("bounds subscription waits with timeout, abort, and close", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ defaultTimeoutMs: 20 });
    const subscription = harness.connection.subscribe("window/logMessage");

    const timedOut = subscription.next();
    const timeoutAssertion = expect(timedOut).rejects.toThrow("timed out after 20ms");
    await vi.advanceTimersByTimeAsync(20);
    await timeoutAssertion;

    const aborter = new AbortController();
    const aborted = subscription.next({ signal: aborter.signal });
    const abortAssertion = expect(aborted).rejects.toThrow("aborted");
    aborter.abort();
    await abortAssertion;

    const closing = subscription.next();
    subscription.close();
    await expect(closing).rejects.toThrow("subscription is closed");
    harness.child.finish();
    await harness.connection.close();
  });

  it("rejects pending work on spawn failure, process exit, and stdin EPIPE without unhandled errors", async () => {
    const spawnHarness = createHarness();
    const spawning = spawnHarness.connection.request("initialize");
    const spawnAssertion = expect(spawning).rejects.toThrow("failed to start");
    spawnHarness.child.emit("error", new Error("ENOENT"));
    await spawnAssertion;
    await expect(spawnHarness.connection.request("later")).rejects.toThrow("failed to start");
    await spawnHarness.connection.close();

    const exitHarness = createHarness();
    const exiting = exitHarness.connection.request("initialize");
    const exitAssertion = expect(exiting).rejects.toThrow("exited before responding");
    exitHarness.child.finish(2);
    await exitAssertion;
    await exitHarness.connection.close();

    const pipeHarness = createHarness();
    const writing = pipeHarness.connection.request("initialize");
    const pipeAssertion = expect(writing).rejects.toThrow(/stdin|EPIPE/i);
    pipeHarness.child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    await pipeAssertion;
    await pipeHarness.connection.close();
  });

  it("caps and scrubs the stderr tail", async () => {
    const harness = createHarness({ maxStderrChars: 80 });
    harness.child.stderr.write(`${"x".repeat(120)} sk-test_abcdefghijklmnop end`);

    expect(harness.connection.stderrTail()).not.toContain("sk-test_abcdefghijklmnop");
    expect(harness.connection.stderrTail()).toContain("[redacted:secret-shape]");
    expect(harness.connection.stderrTail().length).toBeLessThanOrEqual(80);
    await finish(harness);
  });

  it("uses bounded TERM-to-KILL cleanup when the child will not exit", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ closeGraceMs: 10 });
    const closing = harness.connection.close();

    await vi.advanceTimersByTimeAsync(20);
    await closing;
    expect(harness.child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
