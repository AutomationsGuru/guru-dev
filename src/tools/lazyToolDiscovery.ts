import type { ToolDefinition } from "./registry.js";

export interface ThinToolDefinition {
  readonly name: string;
  readonly description: string;
}

export interface LazyToolDiscovery {
  /** Lists stable catalog metadata without exposing executable schemas. */
  listThin(): readonly ThinToolDefinition[];
  /** Returns the complete definition, including schemas, for an exact catalog name. */
  loadFull(name: string): ToolDefinition | undefined;
}

function toOneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function createLazyToolDiscovery(tools: readonly ToolDefinition[]): LazyToolDiscovery {
  const toolsByName = new Map<string, ToolDefinition>();

  for (const tool of tools) {
    if (toolsByName.has(tool.id)) {
      throw new Error(`Tool already registered: ${tool.id}`);
    }

    toolsByName.set(tool.id, tool);
  }

  const thinTools = Object.freeze(
    [...toolsByName.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((tool) => Object.freeze({ name: tool.id, description: toOneLine(tool.description) }))
  );

  return {
    listThin() {
      return thinTools;
    },
    loadFull(name) {
      return toolsByName.get(name);
    }
  };
}
