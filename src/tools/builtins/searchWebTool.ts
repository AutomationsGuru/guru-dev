import { z } from "zod";
import type { ToolDefinition } from "../registry.js";
import { defaultWebSearch } from "./httpFetch.js";

export const SearchWebToolInputSchema = z
  .object({
    query: z.string().trim().min(1).describe("The search query."),
    domain: z.string().trim().min(1).optional().describe("Optional domain to recommend the search prioritize.")
  })
  .strict();

export const SearchWebToolOutputSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      snippet: z.string()
    })
  )
});

export interface SearchWebToolOptions {
  /** Callback to perform the actual web search. Defaults to DuckDuckGo Instant Answer (no key). */
  readonly onSearch?: (query: string, domain?: string) => Promise<{ title: string; url: string; snippet: string }[]>;
  readonly fetchImpl?: typeof fetch;
}

export function createSearchWebTool(options: SearchWebToolOptions = {}): ToolDefinition<typeof SearchWebToolInputSchema, typeof SearchWebToolOutputSchema> {
  return {
    id: "search_web",
    title: "Search Web",
    description: "Performs a web search for a given query. Returns a summary of relevant information along with URL citations.",
    inputSchema: SearchWebToolInputSchema,
    outputSchema: SearchWebToolOutputSchema,
    async execute(input) {
      const onSearch =
        options.onSearch ??
        ((query: string, domain?: string) => defaultWebSearch(query, domain, options.fetchImpl));
      const results = await onSearch(input.query, input.domain);
      return { results };
    }
  };
}
