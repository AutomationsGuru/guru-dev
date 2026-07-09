import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { checkMcpReadiness, connectMcpServer, type McpClient } from "../../src/mcp/client.js";
import { McpServerConfigSchema } from "../../src/mcp/schemas.js";

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_SERVER = join(fixtureDir, "fake-mcp-server.mjs");

function fakeServerConfig(overrides: Record<string, unknown> = {}) {
  return McpServerConfigSchema.parse({
    id: "fake",
    transport: "stdio",
    command: process.execPath,
    args: [FAKE_SERVER],
    category: "test",
    timeoutMs: 10_000,
    ...overrides
  });
}

describe("checkMcpReadiness — presence-only, value-free", () => {
  it("reports ready for a launchable stdio server", () => {
    expect(checkMcpReadiness(fakeServerConfig(), {}).status).toBe("ready");
  });

  it("reports disabled / not-implemented / missing-command / missing-env", () => {
    expect(checkMcpReadiness(fakeServerConfig({ enabled: false }), {}).status).toBe("disabled");
    expect(checkMcpReadiness(fakeServerConfig({ transport: "http", url: "https://example.com/mcp" }), {}).status).toBe("not-implemented");
    // The schema already rejects stdio-without-command at parse time; the readiness
    // branch is defensive — exercise it past the parser deliberately.
    const noCommand = { ...fakeServerConfig(), command: undefined } as unknown as Parameters<typeof checkMcpReadiness>[0];
    expect(checkMcpReadiness(noCommand, {}).status).toBe("missing-command");
    const missing = checkMcpReadiness(fakeServerConfig({ requiredEnvNames: ["FAKE_MCP_KEY"] }), {});
    expect(missing.status).toBe("missing-env");
    expect(missing.missingEnvNames).toEqual(["FAKE_MCP_KEY"]); // names only, never values
  });
});

describe("MCP client against a live stdio server", () => {
  let client: McpClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("handshakes, paginates tools/list, and calls a tool", async () => {
    client = await connectMcpServer({ config: fakeServerConfig(), env: process.env });
    expect(client.serverInfo.name).toBe("fake-mcp-server");
    expect(client.serverInfo.protocolVersion).toBe("2025-03-26");

    const tools = await client.listTools();
    // Two pages followed via nextCursor: echo+leak, then boom+slow.
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "leak", "boom", "slow"]);
    expect(tools[0]?.serverId).toBe("fake");

    const result = await client.callTool("echo", { value: "hi" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('echo:{"value":"hi"}');
  });

  it("surfaces isError results without throwing", async () => {
    client = await connectMcpServer({ config: fakeServerConfig(), env: process.env });
    const result = await client.callTool("boom", {});
    expect(result.isError).toBe(true);
    expect(result.text).toBe("kaboom");
  });

  it("times out a blackholed call instead of hanging", async () => {
    client = await connectMcpServer({ config: fakeServerConfig(), env: process.env });
    await expect(client.callTool("slow", {}, { timeoutMs: 300 })).rejects.toThrow(/timed out after 300ms/u);
  });

  it("fails legibly when the command does not exist", async () => {
    await expect(
      connectMcpServer({
        config: fakeServerConfig({ command: "definitely-not-a-real-binary-guruharness" }),
        env: process.env
      })
    ).rejects.toThrow(/failed to start|exited before responding/u);
  });

  it("refuses to connect when readiness is not green", async () => {
    await expect(
      connectMcpServer({ config: fakeServerConfig({ requiredEnvNames: ["FAKE_MCP_KEY_MISSING"] }), env: {} })
    ).rejects.toThrow(/missing env: FAKE_MCP_KEY_MISSING/u);
  });
});
