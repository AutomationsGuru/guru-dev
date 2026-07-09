import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { connectMcpServer, type McpClient } from "../../src/mcp/client.js";
import { McpServerConfigSchema } from "../../src/mcp/schemas.js";
import { discoverMcpTools, makeMcpToolFactory, mcpToolId, type McpBridgeOutput } from "../../src/mcp/toolBridge.js";
import { createToolRegistry, executeRegisteredTool } from "../../src/tools/registry.js";

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_SERVER = join(fixtureDir, "fake-mcp-server.mjs");

const config = McpServerConfigSchema.parse({
  id: "fake",
  transport: "stdio",
  command: process.execPath,
  args: [FAKE_SERVER],
  category: "test",
  timeoutMs: 10_000
});

describe("MCP tool bridge — attached tools obey the same constitution as builtins", () => {
  let client: McpClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("bridges discovered tools into registry ToolDefinitions", async () => {
    client = await connectMcpServer({ config, env: process.env });
    const tools = await discoverMcpTools({ client });

    expect(tools.map((tool) => tool.id)).toEqual(["mcp.fake.echo", "mcp.fake.leak", "mcp.fake.boom", "mcp.fake.slow"]);
    // The server's advertised JSON Schema is surfaced for the model to read.
    expect(tools[0]?.description).toContain("Arguments (JSON Schema)");
    // Factory shape plugs into the frozen ExtensionApi.registerTool seam.
    expect(makeMcpToolFactory(tools)()).toHaveLength(4);
  });

  it("executes a bridged tool through the registry choke point", async () => {
    client = await connectMcpServer({ config, env: process.env });
    const registry = createToolRegistry(await discoverMcpTools({ client }));

    const observation = await executeRegisteredTool(registry, "mcp.fake.echo", { arguments: { value: "bridged" } });
    expect(observation.status).toBe("succeeded");
    const output = observation.output as McpBridgeOutput;
    expect(output.text).toContain('echo:{"value":"bridged"}');
    expect(output.riskLevel).toBe("read-only");
  });

  it("REDACTS token-shaped output from an attached server (render-layer scrub holds)", async () => {
    client = await connectMcpServer({ config, env: process.env });
    const registry = createToolRegistry(await discoverMcpTools({ client }));

    const observation = await executeRegisteredTool(registry, "mcp.fake.leak", { arguments: {} });
    expect(observation.status).toBe("succeeded");
    const output = observation.output as McpBridgeOutput;
    // The fake server returned "sk-fakeleak1234567890abcdefgh" — the registry's
    // sanitizer must have scrubbed it before it reached any printable surface.
    expect(JSON.stringify(output)).not.toContain("sk-fakeleak");
    expect(output.text).toContain("[redacted");
  });

  it("maps isError results to a failed bridge status without throwing", async () => {
    client = await connectMcpServer({ config, env: process.env });
    const registry = createToolRegistry(await discoverMcpTools({ client }));

    const observation = await executeRegisteredTool(registry, "mcp.fake.boom", { arguments: {} });
    expect(observation.status).toBe("succeeded"); // transport succeeded —
    const output = observation.output as McpBridgeOutput;
    expect(output.status).toBe("failed"); // — the TOOL reported failure, legibly.
    expect(output.text).toBe("kaboom");
  });

  it("slug-safes weird tool names in registry ids", () => {
    expect(mcpToolId("srv", "weird name/with:chars")).toBe("mcp.srv.weird-name-with-chars");
  });
});
