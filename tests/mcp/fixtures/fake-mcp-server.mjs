/**
 * Fake MCP server for transport/client/bridge tests — newline-delimited
 * JSON-RPC 2.0 over stdio, per the MCP stdio transport. Tools:
 *   echo  — returns the arguments as text content
 *   leak  — returns a token-shaped string (proves the registry scrubs bridged output)
 *   boom  — returns isError: true
 *   slow  — replies after 5s (drives the client timeout path)
 * Pages tools/list in two pages to exercise cursor pagination.
 * Also logs a prose line to stdout on boot — a spec violation real servers
 * commit — which the transport must tolerate.
 */

process.stdout.write("fake-mcp-server booting (prose line, not JSON-RPC)\n");

let buffer = "";

const TOOLS_PAGE_1 = [
  { name: "echo", description: "Echo the arguments back as text.", inputSchema: { type: "object", properties: { value: { type: "string" } } } },
  { name: "leak", description: "Returns a token-shaped string." }
];
const TOOLS_PAGE_2 = [
  { name: "boom", description: "Always fails." },
  { name: "slow", description: "Replies after 5 seconds." }
];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? "2025-03-26",
      serverInfo: { name: "fake-mcp-server", version: "1.0.0" },
      capabilities: { tools: {} }
    });
    return;
  }
  if (method === "notifications/initialized") {
    return; // notification — no reply
  }
  if (method === "tools/list") {
    if (params?.cursor === "page-2") {
      reply(id, { tools: TOOLS_PAGE_2 });
    } else {
      reply(id, { tools: TOOLS_PAGE_1, nextCursor: "page-2" });
    }
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    if (name === "echo") {
      reply(id, { content: [{ type: "text", text: `echo:${JSON.stringify(params?.arguments ?? {})}` }], isError: false });
      return;
    }
    if (name === "leak") {
      // Deliberately token-shaped (OpenAI style) — must be redacted by the harness.
      reply(id, { content: [{ type: "text", text: "the key is sk-fakeleak1234567890abcdefgh" }], isError: false });
      return;
    }
    if (name === "boom") {
      reply(id, { content: [{ type: "text", text: "kaboom" }], isError: true });
      return;
    }
    if (name === "slow") {
      setTimeout(() => reply(id, { content: [{ type: "text", text: "finally" }], isError: false }), 5_000);
      return;
    }
  }
  if (id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such method: ${method}` } })}\n`);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      try {
        handle(JSON.parse(line));
      } catch {
        // ignore unparseable lines
      }
    }
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
