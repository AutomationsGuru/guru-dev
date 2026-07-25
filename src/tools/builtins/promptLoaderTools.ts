import { z } from "zod";

import { createPromptLoader } from "../../resources/promptLoader.js";
import {
  PromptTemplateSchema,
  PromptSnippetSchema,
  PromptRegistrySchema
} from "../../resources/prompts.js";
import type { ToolDefinition } from "../registry.js";

export const ListPromptsToolInputSchema = z.object({}).strict();
export const ListPromptsToolOutputSchema = PromptRegistrySchema;

export const GetPromptInputSchema = z.object({
  id: z.string().min(1)
}).strict();
export const GetPromptToolOutputSchema = PromptTemplateSchema.optional();

export function createListPromptsTool(roots: readonly string[]): ToolDefinition<typeof ListPromptsToolInputSchema, typeof ListPromptsToolOutputSchema> {
  const loader = createPromptLoader(roots);

  return {
    id: "prompts.registry.list",
    title: "List prompt registry",
    description: "Discover prompt templates and snippets from configured prompt directories.",
    inputSchema: ListPromptsToolInputSchema,
    outputSchema: ListPromptsToolOutputSchema,
    async execute(_input, _context) {
      const templates = await loader.list();
      const snippets = await loader.listSnippets();
      return { templates, snippets };
    }
  };
}

export function createGetPromptTool(roots: readonly string[]): ToolDefinition<typeof GetPromptInputSchema, typeof GetPromptToolOutputSchema> {
  const loader = createPromptLoader(roots);

  return {
    id: "prompt.template.get",
    title: "Get prompt template",
    description: "Load a prompt template from the registry by id.",
    inputSchema: GetPromptInputSchema,
    outputSchema: GetPromptToolOutputSchema,
    async execute(input, _context) {
      return await loader.get(input.id);
    }
  };
}
