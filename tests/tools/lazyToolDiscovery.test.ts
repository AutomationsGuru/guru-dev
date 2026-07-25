import { z } from "zod";

import { createLazyToolDiscovery } from '../../src/tools/lazyToolDiscovery.js';
import type { ToolDefinition } from '../../src/tools/registry.js';

const EchoInputSchema = z.object({ message: z.string() }).strict();
const EchoOutputSchema = z.object({ message: z.string() }).strict();

function createEchoTool(id: string, title: string, description: string): ToolDefinition<typeof EchoInputSchema, typeof EchoOutputSchema> {
  return {
    id,
    title,
    description,
    inputSchema: EchoInputSchema,
    outputSchema: EchoOutputSchema,
    execute: (input) => input
  };
}

describe("lazy tool discovery", () => {
  it("lists only each tool's name and one-line description in stable id order", () => {
    const inputSchema = z.object({ secret: z.string() }).strict();
    const outputSchema = z.object({ result: z.string() }).strict();
    const discovery = createLazyToolDiscovery([
      {
        ...createEchoTool("z.echo", "Z Echo", "Return a Z message."),
        inputSchema,
        outputSchema
      },
      createEchoTool("a.echo", "A Echo", "Return an A message.")
    ]);

    expect(discovery.listThin()).toEqual([
      { name: "a.echo", description: "Return an A message." },
      { name: "z.echo", description: "Return a Z message." }
    ]);
  });

  it("loads the complete tool definition and its schemas only for an exact selected name", () => {
    const inputSchema = z.object({ count: z.number().int() }).strict();
    const outputSchema = z.object({ total: z.number().int() }).strict();
    const tool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
      id: "counter",
      title: "Counter",
      description: "Count an input value.",
      inputSchema,
      outputSchema,
      execute: (input) => ({ total: input.count })
    };
    const discovery = createLazyToolDiscovery([tool]);

    expect(discovery.loadFull("counter")).toBe(tool);
    expect(discovery.loadFull("missing")).toBeUndefined();
  });
});
