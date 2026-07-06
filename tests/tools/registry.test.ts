import { z } from "zod";

import { createToolRegistry, executeRegisteredTool, type ToolDefinition } from "../../src/tools/registry.js";

describe("createToolRegistry", () => {
  it("should register and list tools in id order", () => {
    const registry = createToolRegistry([createEchoTool("z.echo"), createEchoTool("a.echo")]);

    expect(registry.list().map((tool) => tool.id)).toEqual(["a.echo", "z.echo"]);
    expect(registry.get("a.echo")?.title).toBe("Echo");
  });

  it("should reject duplicate tool ids", () => {
    expect(() => createToolRegistry([createEchoTool("echo"), createEchoTool("echo")])).toThrow("Tool already registered: echo");
  });
});

describe("executeRegisteredTool", () => {
  it("should pass execution context to the tool", async () => {
    const receivedContexts: unknown[] = [];
    const registry = createToolRegistry([
      {
        ...createEchoTool("context-test"),
        execute(input, context) {
          receivedContexts.push(context);

          return input;
        }
      }
    ]);

    await executeRegisteredTool(registry, "context-test", { message: "hello" }, { runId: "run-1" });

    expect(receivedContexts).toEqual([{ runId: "run-1" }]);
  });

  it("should execute a registered tool and normalize a successful observation", async () => {
    const registry = createToolRegistry([createEchoTool("echo")]);

    const observation = await executeRegisteredTool(registry, "echo", { message: "hello" }, { runId: "run-1" });

    expect(observation).toMatchObject({
      toolId: "echo",
      status: "succeeded",
      output: { message: "hello" }
    });
    expect(observation.durationMs).toBeGreaterThanOrEqual(0);
    expect(new Date(observation.startedAt).toString()).not.toBe("Invalid Date");
    expect(new Date(observation.endedAt).toString()).not.toBe("Invalid Date");
  });

  it("should return a failed observation for missing tools", async () => {
    const observation = await executeRegisteredTool(createToolRegistry(), "missing", {});

    expect(observation.status).toBe("failed");
    expect(observation.error).toContain("Tool not registered: missing");
  });

  it("should return a failed observation for invalid input", async () => {
    const registry = createToolRegistry([createEchoTool("echo")]);

    const observation = await executeRegisteredTool(registry, "echo", { message: 42 });

    expect(observation.status).toBe("failed");
    expect(observation.error).toContain("Invalid input at message");
  });

  it("should return a failed observation for invalid output", async () => {
    const registry = createToolRegistry([
      {
        ...createEchoTool("bad-output"),
        execute: () => ({ wrong: true })
      }
    ]);

    const observation = await executeRegisteredTool(registry, "bad-output", { message: "hello" });

    expect(observation.status).toBe("failed");
    expect(observation.error).toContain("Invalid output at message");
  });

  it("should return a failed observation for thrown errors", async () => {
    const registry = createToolRegistry([
      {
        ...createEchoTool("throws"),
        execute: () => {
          throw new Error("boom");
        }
      }
    ]);

    const observation = await executeRegisteredTool(registry, "throws", { message: "hello" });

    expect(observation.status).toBe("failed");
    expect(observation.error).toBe("boom");
  });
});

function createEchoTool(id: string): ToolDefinition {
  return {
    id,
    title: "Echo",
    description: "Return the provided message.",
    inputSchema: z.object({ message: z.string() }),
    outputSchema: z.object({ message: z.string() }),
    execute(input) {
      return input;
    }
  };
}
