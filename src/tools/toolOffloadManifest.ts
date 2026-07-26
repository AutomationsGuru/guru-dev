export type ToolOffloadLocation = "local" | "remote";

export interface ToolOffloadManifestEntry {
  readonly toolId: string;
  readonly location: ToolOffloadLocation;
  readonly backendId?: string;
}

export interface ResolvedToolOffload {
  readonly toolId: string;
  readonly location: ToolOffloadLocation;
  readonly backendId?: string;
}

export interface ToolOffloadManifest {
  resolve(toolId: string): ResolvedToolOffload;
}

/**
 * Resolves declared tool placement only. Execution remains the caller's
 * responsibility, so this manifest cannot silently route a tool or make a network call.
 */
export function createToolOffloadManifest(entries: readonly ToolOffloadManifestEntry[] = []): ToolOffloadManifest {
  const entriesByToolId = new Map<string, ResolvedToolOffload>();

  for (const entry of entries) {
    const toolId = entry.toolId.trim();
    if (toolId.length === 0) {
      throw new Error("Tool offload entry requires a tool id.");
    }
    if (entriesByToolId.has(toolId)) {
      throw new Error(`Tool offload entry already defined: ${toolId}`);
    }

    const backendId = entry.backendId?.trim();
    if (entry.location === "remote" && !backendId) {
      throw new Error(`Remote tool offload entry requires a backend id: ${toolId}`);
    }

    entriesByToolId.set(
      toolId,
      entry.location === "remote" ? { toolId, location: "remote", backendId } : { toolId, location: "local" }
    );
  }

  return {
    resolve(toolId) {
      const normalizedToolId = toolId.trim();

      return entriesByToolId.get(normalizedToolId) ?? { toolId: normalizedToolId, location: "local" };
    }
  };
}
