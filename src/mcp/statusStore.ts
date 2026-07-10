import type { McpServerStatus } from "./schemas.js";

/**
 * Process-local MCP attach status board — written by attachConfiguredMcpServers,
 * read by the mcp_bridge_status tool / operator surfaces. Not durable across
 * process restarts (reattach on next session boot).
 */

let lastStatuses: readonly McpServerStatus[] = [];
let recordedAt: string | undefined;

export function recordMcpAttachmentStatuses(statuses: readonly McpServerStatus[]): void {
  lastStatuses = statuses.map((s) => ({ ...s, missingEnvNames: [...(s.missingEnvNames ?? [])] }));
  recordedAt = new Date().toISOString();
}

export function getMcpAttachmentStatuses(): readonly McpServerStatus[] {
  return lastStatuses;
}

export function getMcpAttachmentRecordedAt(): string | undefined {
  return recordedAt;
}

/** Tests only. */
export function clearMcpAttachmentStatuses(): void {
  lastStatuses = [];
  recordedAt = undefined;
}
