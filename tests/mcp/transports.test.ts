import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  connectJsonRpcTransport,
  createMcpTransport,
  type JsonRpcConnection
} from '../../src/mcp/transports.js';
import { McpServerConfigSchema } from '../../src/mcp/schemas.js';
import { clearRegisteredSecretValues, scrubSecretValues } from '../../src/safety/secretSafety.js';

/**
 * Transport factory coverage: stdio delegates to the existing connection;
 * http/sse are real JSON-RPC over loopback-only in-process servers. No external
 * connection is ever made (plan constraint) — every server here is bound to
 * 127.0.0.1 on an ephemeral port.
 */

function httpConfig(url: string, overrides: Record<string, unknown> = {}) {
  return McpServerConfigSchema.parse({
    id: "fake",
    transport: "http",
    url,
    category: "test",
    timeoutMs: 2_000,
    ...overrides
  });
}

describe("createMcpTransport — factory dispatch", () => {
  it("resolves stdio configs to the stdio connector", () => {
    const config = McpServerConfigSchema.parse({
      id: "fake",
      transport: "stdio",
      command: "node",
      args: ["-e", ""],
      category: "test"
    });
    expect(createMcpTransport(config)).toBe("stdio");
  });

  it("resolves http and sse configs", () => {
    expect(createMcpTransport(httpConfig("https://example.com/mcp"))).toBe("http");
    expect(createMcpTransport(httpConfig("https://example.com/mcp", { transport: "sse" }))).toBe("sse");
  });
});

describe("http transport — loopback JSON-RPC", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let lastSeenBody: unknown;
  let connection: JsonRpcConnection | undefined;

  beforeEach(async () => {
    server = createServer((request, response) => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        lastSeenBody = JSON.parse(body);
        const message = lastSeenBody as Record<string, unknown>;
        if (typeof message.method === "string" && message.id === undefined) {
          // Notification: accepted, no reply body.
          response.writeHead(202).end();
          return;
        }
        if (message.method === "fail") {
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "boom" } }));
          return;
        }
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { echoed: message.params ?? null } }));
      });
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await connection?.close();
    connection = undefined;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  it("sends a JSON-RPC request and resolves the result", async () => {
    connection = connectJsonRpcTransport({ transport: "http", url: `${baseUrl}/mcp` });
    const result = await connection.request("initialize", { protocolVersion: "2025-03-26" });
    expect(result).toEqual({ echoed: { protocolVersion: "2025-03-26" } });
    const sent = lastSeenBody as Record<string, unknown>;
    expect(sent.jsonrpc).toBe("2.0");
    expect(sent.method).toBe("initialize");
    expect(typeof sent.id).toBe("number");
  });

  it("posts notifications without waiting for a reply", async () => {
    connection = connectJsonRpcTransport({ transport: "http", url: `${baseUrl}/mcp` });
    connection.notify("notifications/initialized");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const sent = lastSeenBody as Record<string, unknown>;
    expect(sent.method).toBe("notifications/initialized");
    expect(sent.id).toBeUndefined();
  });

  it("rejects with the server's JSON-RPC error message", async () => {
    connection = connectJsonRpcTransport({ transport: "http", url: `${baseUrl}/mcp` });
    await expect(connection.request("fail")).rejects.toThrow(/boom/u);
  });

  it("times out instead of hanging on a blackholed response", async () => {
    server?.removeAllListeners("request");
    server?.on("request", () => {
      /* never respond */
    });
    connection = connectJsonRpcTransport({ transport: "http", url: `${baseUrl}/mcp` });
    await expect(connection.request("initialize", {}, { timeoutMs: 200 })).rejects.toThrow(/timed out after 200ms/u);
  });

  it("aborts an in-flight request via AbortSignal", async () => {
    server?.removeAllListeners("request");
    server?.on("request", () => {
      /* never respond */
    });
    connection = connectJsonRpcTransport({ transport: "http", url: `${baseUrl}/mcp` });
    const controller = new AbortController();
    const pending = connection.request("initialize", {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/u);
  });

  it("surfaces a non-2xx HTTP status without a stack dump", async () => {
    server?.removeAllListeners("request");
    server?.on("request", (_request, response: ServerResponse) => {
      response.writeHead(500).end("internal");
    });
    connection = connectJsonRpcTransport({ transport: "http", url: `${baseUrl}/mcp` });
    await expect(connection.request("initialize")).rejects.toThrow(/500/u);
  });

  it("close() rejects pending requests and new requests after close fail fast", async () => {
    server?.removeAllListeners("request");
    server?.on("request", () => {
      /* never respond */
    });
    connection = connectJsonRpcTransport({ transport: "http", url: `${baseUrl}/mcp` });
    const pending = connection.request("initialize");
    const closing = connection.close();
    await expect(pending).rejects.toThrow(/closed/u);
    await closing;
    await expect(connection.request("initialize")).rejects.toThrow(/closed/u);
  });
});

describe("sse transport — legacy streamable HTTP (spec 2025-03-26)", () => {
  let server: Server | undefined;
  let baseUrl = "";
  const postedBodies: unknown[] = [];
  let connection: JsonRpcConnection | undefined;

  beforeEach(async () => {
    postedBodies.length = 0;
    const clients = new Set<ServerResponse>();
    server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/events") {
        clients.add(response);
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        response.flushHeaders();
        request.on("close", () => clients.delete(response));
        return;
      }
      if (request.method === "POST" && request.url === "/messages") {
        let body = "";
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        request.on("end", () => {
          postedBodies.push(JSON.parse(body));
          response.writeHead(202).end();
          const message = JSON.parse(body) as Record<string, unknown>;
          if (typeof message.method === "string" && message.id === undefined) {
            return; // notification — no SSE reply
          }
          const reply =
            message.method === "fail"
              ? { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "sse boom" } }
              : { jsonrpc: "2.0", id: message.id, result: { echoed: message.params ?? null } };
          for (const client of clients) {
            client.write(`data: ${JSON.stringify(reply)}\n\n`);
          }
        });
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await connection?.close();
    connection = undefined;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  it("POSTs requests to the message endpoint and resolves replies off the event stream", async () => {
    connection = connectJsonRpcTransport({
      transport: "sse",
      url: `${baseUrl}/events`,
      postUrl: `${baseUrl}/messages`
    });
    const result = await connection.request("initialize", { hello: "world" }, { timeoutMs: 2_000 });
    expect(result).toEqual({ echoed: { hello: "world" } });
    expect(postedBodies).toHaveLength(1);
    expect((postedBodies[0] as Record<string, unknown>).method).toBe("initialize");
  });

  it("discovers the POST endpoint from an `endpoint` SSE event when postUrl is not given", async () => {
    // Emit the endpoint event to each connecting client.
    server?.removeAllListeners("request");
    const clients = new Set<ServerResponse>();
    server?.on("request", (request, response) => {
      if (request.method === "GET" && request.url === "/events") {
        clients.add(response);
        response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
        response.flushHeaders();
        response.write(`event: endpoint\ndata: /messages\n\n`);
        request.on("close", () => clients.delete(response));
        return;
      }
      if (request.method === "POST" && request.url === "/messages") {
        let body = "";
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        request.on("end", () => {
          postedBodies.push(JSON.parse(body));
          response.writeHead(202).end();
          const message = JSON.parse(body) as Record<string, unknown>;
          if (typeof message.method === "string" && message.id === undefined) {
            return;
          }
          for (const client of clients) {
            client.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } })}\n\n`);
          }
        });
        return;
      }
      response.writeHead(404).end();
    });
    connection = connectJsonRpcTransport({ transport: "sse", url: `${baseUrl}/events` });
    const result = await connection.request("initialize", {}, { timeoutMs: 2_000 });
    expect(result).toEqual({ ok: true });
    expect(postedBodies).toHaveLength(1);
  });

  it("rejects with the server's JSON-RPC error message", async () => {
    connection = connectJsonRpcTransport({
      transport: "sse",
      url: `${baseUrl}/events`,
      postUrl: `${baseUrl}/messages`
    });
    await expect(connection.request("fail", {}, { timeoutMs: 2_000 })).rejects.toThrow(/sse boom/u);
  });

  it("times out instead of hanging when no SSE reply arrives", async () => {
    server?.removeAllListeners("request");
    server?.on("request", (request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
        response.flushHeaders();
        return;
      }
      response.writeHead(202).end();
    });
    connection = connectJsonRpcTransport({
      transport: "sse",
      url: `${baseUrl}/events`,
      postUrl: `${baseUrl}/messages`
    });
    await expect(connection.request("initialize", {}, { timeoutMs: 200 })).rejects.toThrow(/timed out after 200ms/u);
  });

  it("aborts an in-flight request via AbortSignal", async () => {
    server?.removeAllListeners("request");
    server?.on("request", (request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
        response.flushHeaders();
        return;
      }
      response.writeHead(202).end();
    });
    connection = connectJsonRpcTransport({
      transport: "sse",
      url: `${baseUrl}/events`,
      postUrl: `${baseUrl}/messages`
    });
    const controller = new AbortController();
    const pending = connection.request("initialize", {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/u);
  });

  it("close() ends the event stream and rejects new requests", async () => {
    connection = connectJsonRpcTransport({
      transport: "sse",
      url: `${baseUrl}/events`,
      postUrl: `${baseUrl}/messages`
    });
    await connection.close();
    await expect(connection.request("initialize")).rejects.toThrow(/closed/u);
  });
});

describe("secret constitution — transport error paths stay value-free", () => {
  it("an Authorization header value never appears in an error message", async () => {
    const secret = "super-sensitive-transport-header";
    clearRegisteredSecretValues();
    try {
      const server = createServer((_request, response) => {
        response.writeHead(401, { "www-authenticate": `Bearer token=${secret}` }).end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const port = (server.address() as AddressInfo).port;
        const connection = connectJsonRpcTransport({
          transport: "http",
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { authorization: `Bearer ${secret}` }
        });
        let message = "";
        try {
          await connection.request("initialize");
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        } finally {
          await connection.close();
        }
        expect(message).not.toContain(secret);
        // And even if the value lands in ANY later printable surface, the registry
        // scrubber (fed by header registration at connect time) redacts it.
        expect(scrubSecretValues(`leak path: ${secret}`)).not.toContain(secret);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      clearRegisteredSecretValues();
    }
  });
});
