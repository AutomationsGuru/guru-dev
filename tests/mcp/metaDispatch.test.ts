import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { createMcpMetaDispatchTools } from "../../src/mcp/metaDispatch.js";
import {
  createToolRegistry,
  executeRegisteredTool,
  type ToolDefinition,
  type ToolObservation,
  type ToolRegistry
} from "../../src/tools/registry.js";

const TestInputSchema = z.object({ arguments: z.record(z.string(), z.unknown()) }).strict();
const TestOutputSchema = z.object({ value: z.string() }).strict();

const SearchResultSchema = z
  .object({
    query: z.string(),
    tools: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          description: z.string()
        })
        .strict()
    )
  })
  .strict();

const ToolObservationResultSchema = z
  .object({
    toolId: z.string(),
    status: z.enum(["succeeded", "failed"]),
    startedAt: z.string(),
    endedAt: z.string(),
    durationMs: z.number().nonnegative(),
    output: z.unknown().optional(),
    error: z.string().optional()
  })
  .strict();

function makeTool(id: string, title = id, description = `${id} description`): ToolDefinition<typeof TestInputSchema, typeof TestOutputSchema> {
  return {
    id,
    title,
    description,
    inputSchema: TestInputSchema,
    outputSchema: TestOutputSchema,
    execute: () => ({ value: id })
  };
}

function registerMetaTools(registry: ToolRegistry): void {
  for (const tool of createMcpMetaDispatchTools(registry)) {
    registry.register(tool);
  }
}

function succeededOutput(observation: ToolObservation): unknown {
  expect(observation.status).toBe("succeeded");
  return observation.output;
}

describe("MCP meta-dispatch tools", () => {
  it("creates the search_tool and use_tool definitions", () => {
    const tools = createMcpMetaDispatchTools(createToolRegistry());

    expect(tools.map((tool) => tool.id)).toEqual(["search_tool", "use_tool"]);
  });

  it.each([
    ["id", "MCP.ALPHA.ECHO", "echo"],
    ["title", "MCP.BETA.RUN", "RELEASE HELPER"],
    ["description", "MCP.GAMMA.READ", "PRODUCTION NOTES"]
  ])("matches MCP tool %s case-insensitively", async (_field, expectedId, query) => {
    const registry = createToolRegistry([
      makeTool("mcp.alpha.echo", "Echo", "Repeat a value"),
      makeTool("mcp.beta.run", "Release Helper", "Run a bounded job"),
      makeTool("mcp.gamma.read", "Reader", "Read production notes")
    ]);
    registerMetaTools(registry);

    const observation = await executeRegisteredTool(registry, "search_tool", { query });
    const result = SearchResultSchema.parse(succeededOutput(observation));

    expect(result.tools.map((tool) => tool.id.toUpperCase())).toContain(expectedId);
  });

  it("returns only stable public metadata for registered mcp.* tools", async () => {
    const execute = vi.fn(() => ({ value: "must not run" }));
    const registry = createToolRegistry([
      makeTool("local.echo", "Local Echo", "match local"),
      {
        ...makeTool("mcp.remote.echo", "Remote Echo", "match remote"),
        execute
      }
    ]);
    registerMetaTools(registry);

    const observation = await executeRegisteredTool(registry, "search_tool", { query: "echo" });
    const result = SearchResultSchema.parse(succeededOutput(observation));

    expect(result).toEqual({
      query: "echo",
      tools: [{ id: "mcp.remote.echo", title: "Remote Echo", description: "match remote" }]
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns deterministic id order with a default limit of ten and an explicit maximum of twenty-five", async () => {
    const registry = createToolRegistry(
      Array.from({ length: 30 }, (_unused, index) => {
        const suffix = String(29 - index).padStart(2, "0");
        return makeTool(`mcp.server.match-${suffix}`);
      })
    );
    registerMetaTools(registry);

    const defaultObservation = await executeRegisteredTool(registry, "search_tool", { query: "match" });
    const defaultResult = SearchResultSchema.parse(succeededOutput(defaultObservation));
    const maximumObservation = await executeRegisteredTool(registry, "search_tool", { query: "match", limit: 25 });
    const maximumResult = SearchResultSchema.parse(succeededOutput(maximumObservation));

    expect(defaultResult.tools).toHaveLength(10);
    expect(defaultResult.tools.map((tool) => tool.id)).toEqual(
      Array.from({ length: 10 }, (_unused, index) => `mcp.server.match-${String(index).padStart(2, "0")}`)
    );
    expect(maximumResult.tools).toHaveLength(25);
  });

  it.each([
    [{ query: "" }, "empty query"],
    [{ query: "   " }, "whitespace query"],
    [{ query: "x".repeat(201) }, "oversized query"],
    [{ query: "match", limit: 0 }, "zero limit"],
    [{ query: "match", limit: 26 }, "oversized limit"],
    [{ query: "match", limit: 1.5 }, "fractional limit"]
  ])("rejects an invalid search input: %s (%s)", async (input, _label) => {
    const registry = createToolRegistry();
    registerMetaTools(registry);

    const observation = await executeRegisteredTool(registry, "search_tool", input);

    expect(observation.status).toBe("failed");
    expect(observation.error).toContain("Invalid input");
  });

  it("uses an exact MCP id through the registry and forwards the execution context", async () => {
    const InputSchema = z.object({ arguments: z.object({ value: z.string() }).strict() }).strict();
    const OutputSchema = z.object({ echoed: z.string() }).strict();
    let receivedSignal: AbortSignal | undefined;
    let receivedRunId: string | undefined;
    const echoTool: ToolDefinition<typeof InputSchema, typeof OutputSchema> = {
      id: "mcp.remote.echo",
      title: "Remote Echo",
      description: "Echo a value",
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      execute(input, context) {
        receivedSignal = context.signal;
        receivedRunId = context.runId;
        return { echoed: input.arguments.value };
      }
    };
    const registry = createToolRegistry([echoTool]);
    registerMetaTools(registry);
    const controller = new AbortController();

    const observation = await executeRegisteredTool(
      registry,
      "use_tool",
      { toolId: "mcp.remote.echo", arguments: { value: "hello" } },
      { runId: "meta-run", signal: controller.signal }
    );
    const result = ToolObservationResultSchema.parse(succeededOutput(observation));

    expect(result).toMatchObject({
      toolId: "mcp.remote.echo",
      status: "succeeded",
      output: { echoed: "hello" }
    });
    expect(receivedSignal).toBe(controller.signal);
    expect(receivedRunId).toBe("meta-run");
  });

  it("preserves target input validation as a failed inner observation", async () => {
    const InputSchema = z.object({ arguments: z.object({ count: z.number().int() }).strict() }).strict();
    const execute = vi.fn(() => ({ value: "unexpected" }));
    const registry = createToolRegistry([
      {
        id: "mcp.remote.count",
        title: "Counter",
        description: "Count values",
        inputSchema: InputSchema,
        outputSchema: TestOutputSchema,
        execute
      }
    ]);
    registerMetaTools(registry);

    const observation = await executeRegisteredTool(registry, "use_tool", {
      toolId: "mcp.remote.count",
      arguments: { count: "not-a-number" }
    });
    const result = ToolObservationResultSchema.parse(succeededOutput(observation));

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Invalid input at arguments.count");
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves registry output sanitization in the inner observation", async () => {
    const registry = createToolRegistry([
      {
        ...makeTool("mcp.remote.leak"),
        execute: () => ({ value: "sk-fakeleak1234567890abcdefgh" })
      }
    ]);
    registerMetaTools(registry);

    const observation = await executeRegisteredTool(registry, "use_tool", {
      toolId: "mcp.remote.leak",
      arguments: {}
    });
    const result = ToolObservationResultSchema.parse(succeededOutput(observation));

    expect(result.status).toBe("succeeded");
    expect(JSON.stringify(result.output)).not.toContain("sk-fakeleak");
    expect(JSON.stringify(result.output)).toContain("[redacted");
  });

  it.each([
    ["search_tool", "cannot dispatch itself"],
    ["use_tool", "cannot dispatch itself"],
    ["local.echo", "exact registered mcp.*"],
    ["MCP.remote.echo", "exact registered mcp.*"],
    [" mcp.remote.echo", "exact registered mcp.*"],
    ["mcp.remote.missing", "Unknown registered MCP tool id"]
  ])("rejects invalid use_tool target %s", async (toolId, expectedError) => {
    const registry = createToolRegistry([makeTool("mcp.remote.echo")]);
    registerMetaTools(registry);

    const observation = await executeRegisteredTool(registry, "use_tool", { toolId, arguments: {} });

    expect(observation.status).toBe("failed");
    expect(observation.error).toContain(expectedError);
  });

  it("requires use_tool arguments to be a record", async () => {
    const registry = createToolRegistry([makeTool("mcp.remote.echo")]);
    registerMetaTools(registry);

    const missing = await executeRegisteredTool(registry, "use_tool", { toolId: "mcp.remote.echo" });
    const nonRecord = await executeRegisteredTool(registry, "use_tool", {
      toolId: "mcp.remote.echo",
      arguments: "nope"
    });

    expect(missing.status).toBe("failed");
    expect(nonRecord.status).toBe("failed");
  });
});
