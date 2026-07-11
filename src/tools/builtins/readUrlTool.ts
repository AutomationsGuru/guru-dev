import { z } from "zod";
import type { ToolDefinition } from "../registry.js";
import { defaultFetchUrlContent } from "./httpFetch.js";

export const ReadUrlToolInputSchema = z
  .object({
    url: z.string().url().describe("URL to read content from")
  })
  .strict();

export const ReadUrlToolOutputSchema = z.object({
  content: z.string().describe("The content fetched from the URL (converted to markdown).")
});

export interface ReadUrlToolOptions {
  /** Callback to perform the actual fetch and conversion. Defaults to built-in fetch+HTML strip. */
  readonly onFetch?: (url: string) => Promise<string>;
  readonly fetchImpl?: typeof fetch;
}

export function createReadUrlTool(options: ReadUrlToolOptions = {}): ToolDefinition<typeof ReadUrlToolInputSchema, typeof ReadUrlToolOutputSchema> {
  return {
    id: "read_url_content",
    title: "Read URL Content",
    description: "Fetch content from a URL via HTTP request (invisible to USER). Converts HTML to readable text.",
    inputSchema: ReadUrlToolInputSchema,
    outputSchema: ReadUrlToolOutputSchema,
    async execute(input) {
      const onFetch =
        options.onFetch ??
        ((url: string) => defaultFetchUrlContent(url, options.fetchImpl));
      const content = await onFetch(input.url);
      return { content };
    }
  };
}
